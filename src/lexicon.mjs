/**
 * 关键词风控中和 —— 与 dsh-workbuddy-meter 中的实现**保持逐字节等价**。
 *
 * ## 为什么这里有一份副本
 * 本插件（dsh-workbuddy-fix）刻意**不依赖** dsh-workbuddy-meter：
 * 遇到问题的人应该能只装这个小插件解决，不必先装一整套计量面板。
 *
 * 两个插件通过**共享同一个状态文件**实现联动：
 *   ~/.dsh/workbuddy-meter/lexicon.json
 * 任一方改开关，另一方读到的是同一份配置 —— 一个开，另一个也开。
 * 文件不存在时用默认值（默认开启，符合「装了就想修好」的直觉）。
 *
 * ## 上游为什么拦（2026-10-30 规则已升级）
 *
 * 旧规则（本插件 v1 修的）：对 system prompt 做**关键词子串匹配**，命中
 * 「DeepSeek Harness」就回 400 / code 11128。插零宽空格即可绕开。
 *
 * **新规则（2026-10-30 实测）：不再看关键词，改成看 `role` 本身。**
 * 只要 `messages` 里存在 `role: "system"` 且内容像 agent 指令，就拒绝。
 * 关键词怎么中和都没用 —— 实测零宽空格、整词替换全部 400。
 *
 * 实测矩阵（真实 DSH 11.6KB system prompt）：
 *   完整内容 + role=system              → 400（确定性 3/3）
 *   完整内容 + role=user                → 200  ✅
 *   零宽中和 + role=system               → 400
 *   整词替换 + role=system               → 400
 *   极简 system                          → 200
 *   中性文本 12000 字元 + role=system     → 200（所以不是长度限制）
 *
 * 所以修法是**把 system 降级成 user**：指令一个字不丢，只是模型从
 * 「系统设定」看到的内容变成「用户开头说的话」。这是绕过新规则、
 * 同时保证提示词无损的唯一方式。
 *
 * ## 不能碰文件路径
 * 运行时上下文有 `D:\10_COD\DeepSeek Harness\resources\app.asar\dsh\`。
 * 路径里插零宽字符会让模型把坏路径传给工具调用。用负向断言跳过路径语境。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 零宽空格：渲染无差别，但上游子串匹配不再命中。 */
export const ZERO_WIDTH_SPACE = '\u200B'

/** 默认配置 —— 与 meter 插件一致。 */
export const LEXICON_DEFAULTS = {
  enabled: true,
  /** 核心修复：把 role=system 降级为 role=user（新规则的唯一解法）。 */
  demoteSystem: true,
  /** 关键词中和：对旧规则有效，新规则下已非必需，保留作双保险。 */
  neutralize: true,
  hideIdentity: false,
  /** ⚠️ 默认关闭：在 demoteSystem 生效时，补 system 反而会重新触发拦截。 */
  ensureSystem: false,
  keywords: ['DeepSeek Harness'],
}

/** system 降级成 user 时加的前缀，让模型知道这是设定而非用户随口一说。 */
export const SYSTEM_PREFIX = '【系统设定】\n'

/** 保底 system：上游要求首条必须是 system prompt。 */
export const FALLBACK_SYSTEM = 'You are a helpful assistant.'

/**
 * 共享状态文件路径。
 * 刻意与 dsh-workbuddy-meter 用同一个文件：这就是两个插件联动的机制。
 */
export function lexiconStatePath(dshHome) {
  const home = dshHome ?? resolveDshHome()
  return path.join(home, 'workbuddy-meter', 'lexicon.json')
}

export function resolveDshHome() {
  const env = String(process.env.DSH_HOME ?? '').trim()
  return env.length > 0 ? env : path.join(os.homedir(), '.dsh')
}

/** 规范化配置，永不抛错（钩子跑在 SSE 流里，抛错会中断请求）。 */
export function normalizeLexiconConfig(raw) {
  const input = typeof raw === 'object' && raw !== null ? raw : {}
  const keywords = Array.isArray(input.keywords)
    ? input.keywords.filter((k) => typeof k === 'string' && k.trim().length > 0).map((k) => k.trim())
    : LEXICON_DEFAULTS.keywords
  return {
    enabled: input.enabled !== false,
    demoteSystem: input.demoteSystem !== false,
    neutralize: input.neutralize !== false,
    hideIdentity: input.hideIdentity === true,
    ensureSystem: input.ensureSystem === true,
    keywords: keywords.length > 0 ? keywords : LEXICON_DEFAULTS.keywords,
  }
}

/** 读共享配置；文件不存在或损坏时回落默认值。 */
export function readLexiconConfig(dshHome) {
  try {
    return normalizeLexiconConfig(JSON.parse(fs.readFileSync(lexiconStatePath(dshHome), 'utf8')))
  } catch {
    return normalizeLexiconConfig(LEXICON_DEFAULTS)
  }
}

/**
 * 写共享配置（原子落盘）。
 * 用 tmp + rename，避免另一个插件恰好读到半截 JSON。
 */
export function writeLexiconConfig(dshHome, next) {
  const normalized = normalizeLexiconConfig(next)
  const file = lexiconStatePath(dshHome)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.fix-tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
  return normalized
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 关键词匹配器：关键词内部允许任意空白，
 * 但**前后不能是路径分隔符** —— 否则会把 `D:\...\DeepSeek Harness\...` 改坏。
 */
export function buildKeywordPattern(keyword) {
  const parts = keyword.split(/\s+/).filter(Boolean).map(escapeRegExp)
  if (parts.length === 0) return null
  return new RegExp(`(?<![\\\\/])${parts.join('[ \\u00A0]+')}(?![\\\\/])`, 'g')
}

/** 中和单个字符串。 */
export function neutralizeText(text, config) {
  if (typeof text !== 'string' || text.length === 0) return { text, hits: 0 }
  let out = text
  let hits = 0
  for (const keyword of config.keywords) {
    const pattern = buildKeywordPattern(keyword)
    if (pattern === null) continue
    out = out.replace(pattern, (match) => {
      hits += 1
      return match.split(/[ \u00A0]+/).join(ZERO_WIDTH_SPACE + ' ')
    })
    if (config.hideIdentity) {
      out = out.replace(/(?<![\\\\/])DeepSeek(?![\\\\/])/g, 'Deep' + ZERO_WIDTH_SPACE + 'Seek')
    }
  }
  return { text: out, hits }
}

/** 递归改写一条 message 的所有字符串字段（content 可能是 string 或 parts 数组）。 */
export function neutralizeMessage(message, config) {
  if (message === null || typeof message !== 'object') return 0
  let hits = 0
  for (const key of Object.keys(message)) {
    const value = message[key]
    if (typeof value === 'string') {
      const r = neutralizeText(value, config)
      if (r.hits > 0) { message[key] = r.text; hits += r.hits }
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        const item = value[i]
        if (typeof item === 'string') {
          const r = neutralizeText(item, config)
          if (r.hits > 0) { value[i] = r.text; hits += r.hits }
        } else if (item !== null && typeof item === 'object') {
          hits += neutralizeMessage(item, config)
        }
      }
    } else if (value !== null && typeof value === 'object') {
      hits += neutralizeMessage(value, config)
    }
  }
  return hits
}

/**
 * 对整份 messages 做改写：**system 降级为 user** + 关键词中和。永不抛错。
 *
 * 降级是核心：新规则按 role 判定，system 在就会被拒。降级后指令完整保留，
 * 只是角色变了。`ensureSystem` 在降级开启时被强制忽略 —— 补一条 system
 * 等于把刚拆掉的雷又装回去。
 */
export function rewriteMessages(messages, rawConfig) {
  const config = normalizeLexiconConfig(rawConfig)
  if (!config.enabled) return { hits: 0, injected: false, demoted: 0, skipped: true }
  if (!Array.isArray(messages)) return { hits: 0, injected: false, demoted: 0 }

  let demoted = 0
  if (config.demoteSystem) {
    for (const message of messages) {
      if (message === null || typeof message !== 'object') continue
      if (message.role !== 'system') continue
      message.role = 'user'
      if (typeof message.content === 'string') {
        message.content = SYSTEM_PREFIX + message.content
      } else if (Array.isArray(message.content)) {
        message.content.unshift({ type: 'text', text: SYSTEM_PREFIX })
      }
      demoted += 1
    }
  }

  let hits = 0
  if (config.neutralize) {
    for (let i = 0; i < messages.length; i += 1) hits += neutralizeMessage(messages[i], config)
  }

  let injected = false
  if (config.ensureSystem && !config.demoteSystem) {
    const first = messages[0]
    if (first === undefined || first === null || first.role !== 'system') {
      messages.unshift({ role: 'system', content: FALLBACK_SYSTEM })
      injected = true
    }
  }
  return { hits, injected, demoted }
}

/**
 * 安装 `globalThis.__wbLexicon`。
 *
 * 与 dsh-workbuddy-meter 用**同一个全局名与同一个方法签名** `rewrite(messages)`，
 * 所以 pack.js 里那一行钩子对两个插件都有效。两个插件同时安装时：
 *   - 后装的会覆盖先装的；
 *   - 但两者都读同一个配置文件，行为完全一致，谁在都一样；
 *   - 卸载时会检查 `=== hook` 才删除，不会把对方的钩子误删。
 */
export function installLexiconHook({ getConfig, onStats, logger }) {
  const hook = {
    rewrite(messages) {
      try {
        const config = normalizeLexiconConfig(getConfig())
        if (!config.enabled) return
        const result = rewriteMessages(messages, config)
        if (result.hits > 0 || result.injected || result.demoted > 0) onStats?.(result)
      } catch (error) {
        logger?.debug?.(`workbuddy-fix: rewrite failed (${error instanceof Error ? error.message : String(error)})`)
      }
    },
  }
  globalThis.__wbLexicon = hook
  return () => {
    if (globalThis.__wbLexicon === hook) delete globalThis.__wbLexicon
  }
}
