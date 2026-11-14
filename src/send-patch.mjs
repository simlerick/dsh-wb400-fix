/**
 * OFM pack.js 的 11128 修复补丁 —— 直接注入 send() 里的修复逻辑。
 *
 * ## 为什么要打补丁而不是包 fetch
 *
 * OFM 的 `fetchImpl` 来自 `createChannelFetch()`（`network = createChannelFetch({...})`），
 * 是它自己的包装器，不是 `globalThis.fetch`。所以**包 globalThis.fetch 的钩子完全拦不到**
 * —— 这是 dsh-wb400-fix v1.4 失败的真正原因（面板显示 hook 已装，实际一个请求都拦不住）。
 *
 * 唯一可靠的注入点是 `registerBuddyLlm` 里那个 adapter 的 `send(credential, body, options)`：
 * 它在发请求前已经构造好 headers 和 body，改这两样就能生效。
 *
 * ## 两个渠道，同一个错误码 11128，两种不同原因
 *
 * | 渠道 | 真实原因 | 修法 |
 * |---|---|---|
 * | CodeBuddy 国内（copilot.tencent.com） | 网关把请求文本里的 `@`-mention 当文件引用解析 | body 里 `@` → `\@` |
 * | WorkBuddy 国际（www.workbuddy.ai） | 缺三个会话标识头 | headers 补 `X-Conversation-*` |
 *
 * 两者互不影响，所以补丁用 `product.id` 分流。
 *
 * \@module src/send-patch.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { resolvePackFile, sha256, countOccurrences } from './patch.mjs'

/** 证明补丁在位（两个渠道各一个标记）。 */
export const SEND_MARKER_BUDDY = '[wbfix:@]'
export const SEND_MARKER_WB = '[wbfix:conv]'
export const SEND_MARKERS = [SEND_MARKER_BUDDY, SEND_MARKER_WB]

/**
 * 总开关门控标记。
 *
 * 补丁注入的代码本身**无法读文件**（它在 pack.js 的 send() 里同步执行，
 * 而 send() 是 async 的但引入 fs 会破坏打包产物的纯文本特性），
 * 所以总开关只能在**打补丁/撤补丁**这一层生效：
 *
 *   enabled=false  → 调 revertSendPatch()，把注入段整段删掉
 *   enabled=true   → 调 applySendPatch()，重新插入
 *
 * 这也是唯一能做到「关了就全关」的做法 —— 只要注入段在文件里，
 * 它就无条件执行，改任何配置都拦不住它。
 */
export const SEND_GATE_ENV = 'DSH_WB400_DISABLED'

/**
 * 锚点：buddy adapter 的 send() 里设置完 User-Agent 之后那一行。
 *
 * 选这一行的原因：它在 headers 全部 set 完、`fetchImpl` 调用之前，
 * 是唯一能同时改 headers 和 body 的位置。
 */
export const SEND_ANCHOR =
  '    headers.set("User-Agent", resolveUserAgent(this.product, options.model));\n' +
  '    try {\n' +
  '      return await this.fetchImpl(`${this.product.endpoint}/v2/chat/completions`, {'

/** 注入的代码。缩进 4 空格，与周边一致。 */
function buildInjection() {
  return [
    '    // [wbfix:gate] 总开关：读环境变量，关了就整段跳过（零副作用）。',
    '    // 为什么还要这一层：撤补丁要改文件、要重启，而用户点「关」时期望的是',
    '    // **立即**停手。两层叠加 = 点了立刻停，重启后文件里彻底不再有这段。',
    '    if (!process.env.DSH_WB400_DISABLED) {',
    '    // [wbfix:@] CodeBuddy 国内网关 11128：网关把请求文本里的 @-mention 当文件',
    '    // 引用解析，遇到「行首或空白后的 @ + 长句」就解析失败，并用 11128',
    '    // 「Illegal API invocation from an unapproved channel」伪装成安全拦截。',
    '    //',
    '    // 实测（copilot.tencent.com，真实 11.6KB DSH system prompt）：',
    '    //   原句含 "@ " + 长句        → 400',
    '    //   "@" 转义成 "\\@"          → 200',
    '    //   "@" 换成 "Z"              → 200',
    '    //   "@" 单独 / "@abc" / "@"+中文 → 200（短就不触发）',
    '    //   "@" → 全角＠/ZWSP/NBSP/删空格 → 全部仍 400',
    '    // 反斜杠转义语义不变，模型看到的就是 @。',
    '    if (this.product.id === "buddy" && typeof body === "string" && body.includes("@")) {',
    '      try {',
    '        const parsed = JSON.parse(body);',
    '        const esc = (v) => typeof v === "string" ? v.replace(/(^|\\s)@/g, "$1\\\\@") : v;',
    '        if (Array.isArray(parsed.messages)) {',
    '          for (const m of parsed.messages) {',
    '            if (typeof m.content === "string") m.content = esc(m.content);',
    '            else if (Array.isArray(m.content)) {',
    '              for (const part of m.content) {',
    '                if (part && typeof part.text === "string") part.text = esc(part.text);',
    '              }',
    '            }',
    '          }',
    '        }',
    '        body = JSON.stringify(parsed);',
    '      } catch (e) {}',
    '    }',
    '    // [wbfix:conv] WorkBuddy 国际版（www.workbuddy.ai）强制要求三个会话标识头，',
    '    // 缺任一即 400 {"code":11128,"msg":"request illegal"}。报错文案跟国内版',
    '    // 长得一样，但原因完全不同 —— 与渠道、账号、token、内容审核全都无关。',
    '    //',
    '    // 实测（真实 token，明文即可，不需要解密 App 的 $wbEncrypted）：',
    '    //   不带三件套            → 400 request illegal',
    '    //   带三件套（随机 UUID）  → 400 "first message is not system prompt"',
    '    //                            ↑ 错误变了 = 会话头校验已通过，只剩格式问题',
    '    //   三件套 + system 首条   → 200',
    '    //',
    '    // 三个头只需唯一字符串，服务端不校验它们之间的关联，也不要求跨请求一致。',
    '    // 是否带 X-IDE-*/X-User-Id 无关（最小头实测 200）。',
    '    if (this.product.id === "workbuddy") {',
    '      try {',
    '        const { randomUUID } = await import("node:crypto");',
    '        for (const name of ["X-Conversation-ID", "X-Conversation-Message-ID", "X-Conversation-Request-ID"]) {',
    '          if (!headers.has(name)) headers.set(name, randomUUID());',
    '        }',
    '      } catch (e) {}',
    '    }',
    '    }',  // if (!process.env.DSH_WB400_DISABLED) 结束
    '',
    SEND_ANCHOR,
  ].join('\n')
}

/**
 * 只读检查补丁状态。
 * \@param {string} [packFile]
 * \@returns {{ok:boolean, reason?:string, patched:boolean, buddy:number, wb:number, anchor:number, sha256?:string, text?:string}}
 */
export function inspectSendPatch(packFile) {
  const file = packFile ?? resolvePackFile()
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    return {
      ok: false,
      reason: `pack.js 读取失败：${error instanceof Error ? error.message : String(error)}`,
      patched: false,
      buddy: 0,
      wb: 0,
      anchor: 0,
    }
  }
  const buddy = countOccurrences(text, SEND_MARKER_BUDDY)
  const wb = countOccurrences(text, SEND_MARKER_WB)
  const anchor = countOccurrences(text, SEND_ANCHOR)
  return {
    ok: true,
    patched: buddy > 0 && wb > 0,
    buddy,
    wb,
    anchor,
    sha256: sha256(text),
    text,
  }
}

/**
 * 打补丁。默认 dryRun，显式 `dryRun: false` 才落盘。
 *
 * 幂等：已打过就返回 `already-patched`，不会重复插入。
 *
 * \@param {object} options
 * \@param {string} [options.packFile]
 * \@param {boolean} [options.dryRun]
 * \@returns {{applied:boolean, reason?:string, backupPath?:string, sha256Before?:string, sha256After?:string}}
 */
export function applySendPatch({ packFile, dryRun = true } = {}) {
  const file = packFile ?? resolvePackFile()
  const state = inspectSendPatch(file)
  if (!state.ok) return { applied: false, reason: state.reason }
  if (state.patched) {
    return { applied: false, reason: 'already-patched', sha256Before: state.sha256, sha256After: state.sha256 }
  }
  if (state.anchor !== 1) {
    return {
      applied: false,
      reason: `锚点命中 ${state.anchor} 次（期望 1）—— OFM 版本可能已变，不敢猜`,
    }
  }

  const nextText = state.text.replace(SEND_ANCHOR, buildInjection())

  if (dryRun) {
    return {
      applied: false,
      reason: 'dry-run',
      sha256Before: state.sha256,
      sha256After: sha256(nextText),
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = `${file}.wbfix-send-backup-${stamp}`
  fs.copyFileSync(file, backupPath)
  const tmp = `${file}.wbfix-send-tmp`
  fs.writeFileSync(tmp, nextText, 'utf8')
  fs.renameSync(tmp, file)

  const after = inspectSendPatch(file)
  if (!after.ok || !after.patched) {
    fs.copyFileSync(backupPath, file)
    return { applied: false, reason: '写入后复验失败，已回滚', backupPath }
  }
  return { applied: true, backupPath, sha256Before: state.sha256, sha256After: after.sha256 }
}

/**
 * 移除补丁（按标记删掉注入的整段，不动 OFM 自己的代码）。
 * \@param {object} [options]
 * \returns {{reverted:boolean, reason?:string}}
 */
export function revertSendPatch({ packFile } = {}) {
  const file = packFile ?? resolvePackFile()
  const state = inspectSendPatch(file)
  if (!state.ok) return { reverted: false, reason: state.reason }
  if (!state.patched) return { reverted: false, reason: 'not-patched' }

  // 注入段以 "[wbfix:@" 起，止于锚点行之前。整段删掉即可。
  // 注意：v1.5 起注入段开头多了一层总开关 `if (!process.env...)`，
  // 它的注释行也带 [wbfix:@] 标记，所以「以首个 [wbfix:@] 为起点」依然成立。
  const lines = state.text.split('\n')
  const keep = []
  let skipping = false
  for (const line of lines) {
    const isAnchor = line === '    headers.set("User-Agent", resolveUserAgent(this.product, options.model));'
    if (!skipping && (line.includes('[wbfix:gate]') || line.includes('[wbfix:@]'))) { skipping = true; continue }
    if (skipping) {
      // 锚点是注入段的结尾（buildInjection 最后一行就是锚点首行）
      if (isAnchor) {
        skipping = false
        keep.push(line)
      }
      continue
    }
    keep.push(line)
  }
  const nextText = keep.join('\n')
  const tmp = `${file}.wbfix-send-rev-tmp`
  fs.writeFileSync(tmp, nextText, 'utf8')
  fs.renameSync(tmp, file)
  const after = inspectSendPatch(file)
  return { reverted: true, patched: after.ok ? after.patched : true }
}

/** 供面板显示：两个渠道各自的修复状态。 */
export function describeSendPatch(packFile) {
  const state = inspectSendPatch(packFile)
  return {
    ok: state.ok,
    reason: state.reason ?? null,
    applied: Boolean(state.patched),
    buddyFix: state.buddy > 0,
    workbuddyFix: state.wb > 0,
    anchorHits: state.anchor,
  }
}
