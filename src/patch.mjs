/**
 * OFM pack.js 关键词钩子补丁 —— dsh-workbuddy-fix 自带的独立实现。
 *
 * 本插件**不依赖** dsh-workbuddy-meter，所以这里自带一份最小补丁逻辑
 * （只有「插入一行钩子」这一个能力，没有 meter 的采集补丁）。
 *
 * 两个插件装同一个钩子、同一个锚点、同一个标记。先后打补丁会命中
 * 「已打」直接返回，不会重复插入；先卸载一方也不影响另一方。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

/** 证明钩子那行在位。 */
export const LEXICON_MARKER = '__wbLexicon'

/** 插入锚点：workbuddy 专属的首条 system 兜底块。 */
export const LEXICON_ANCHOR =
  'if (this.product.id === "workbuddy" && (messages.length === 0 || messages[0].role !== "system")) {'

const HOOK_LINE = ';globalThis.__wbLexicon?.rewrite?.(messages);'

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

export function resolveDshHome() {
  const env = String(process.env.DSH_HOME ?? '').trim()
  return env.length > 0 ? env : path.join(os.homedir(), '.dsh')
}

export function resolveOfmDir({ dshHome, profile = 'desktop' } = {}) {
  const home = dshHome ?? resolveDshHome()
  const name = String(profile ?? 'desktop').trim() || 'desktop'
  return path.join(home, 'profiles', name, 'node_modules', 'dsh-our-free-model')
}

export function resolvePackFile(options = {}) {
  return path.join(resolveOfmDir(options), 'vendor', 'channel-pack', 'pack.js')
}

export function countOccurrences(text, needle) {
  let count = 0
  let index = 0
  while ((index = text.indexOf(needle, index)) !== -1) {
    count += 1
    index += needle.length
  }
  return count
}

/** 只读检查，不改文件。 */
export function inspectLexicon(packFile) {
  let text
  try {
    text = fs.readFileSync(packFile, 'utf8')
  } catch (error) {
    return {
      ok: false,
      reason: `pack.js 读取失败：${error instanceof Error ? error.message : String(error)}`,
      patched: false,
      markers: 0,
      anchors: 0,
      sha256: '',
    }
  }
  const markers = countOccurrences(text, LEXICON_MARKER)
  const anchors = countOccurrences(text, LEXICON_ANCHOR)
  return { ok: true, patched: markers > 0, markers, anchors, sha256: sha256(text), text }
}

/** 找到锚点块的闭合位置，返回插入点。 */
export function findLexiconInsertPoint(text) {
  const anchors = countOccurrences(text, LEXICON_ANCHOR)
  if (anchors !== 1) {
    return { ok: false, reason: `锚点命中 ${anchors} 次（期望 1）—— OFM 版本可能已变` }
  }
  const anchorAt = text.indexOf(LEXICON_ANCHOR)
  let depth = 0
  let i = anchorAt
  let seenBrace = false
  for (; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '{') { depth += 1; seenBrace = true } else if (ch === '}') {
      depth -= 1
      if (seenBrace && depth === 0) { i += 1; break }
    }
  }
  if (!seenBrace || depth !== 0) return { ok: false, reason: '无法定位锚点块闭合位置' }

  const lineEnd = text.indexOf('\n', i)
  const insertAt = lineEnd < 0 ? text.length : lineEnd
  const lineStart = text.lastIndexOf('\n', anchorAt) + 1
  const indent = (text.slice(lineStart).match(/^\s*/) ?? [''])[0]
  return { ok: true, index: insertAt, indent }
}

/**
 * 打钩子。默认 dryRun，显式传 dryRun: false 才落盘。
 * @returns {{applied:boolean, reason?:string, backupPath?:string, sha256Before?:string, sha256After?:string}}
 */
export function applyLexiconPatch({ packFile, dryRun = true } = {}) {
  const file = packFile ?? resolvePackFile()
  const state = inspectLexicon(file)
  if (!state.ok) return { applied: false, reason: state.reason }
  if (state.patched) {
    return { applied: false, reason: 'already-patched', sha256Before: state.sha256, sha256After: state.sha256 }
  }
  const where = findLexiconInsertPoint(state.text)
  if (!where.ok) return { applied: false, reason: where.reason }

  const hook = where.indent + HOOK_LINE
  const nextText = state.text.slice(0, where.index) + '\n' + hook + state.text.slice(where.index)

  if (dryRun) {
    return { applied: false, reason: 'dry-run', sha256Before: state.sha256, sha256After: sha256(nextText) }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = `${file}.wbfix-backup-${stamp}`
  fs.copyFileSync(file, backupPath)
  const tmp = `${file}.wbfix-tmp`
  fs.writeFileSync(tmp, nextText, 'utf8')
  fs.renameSync(tmp, file)

  const after = inspectLexicon(file)
  if (!after.ok || !after.patched) {
    fs.copyFileSync(backupPath, file)
    return { applied: false, reason: '写入后复验失败，已回滚', backupPath }
  }
  return { applied: true, backupPath, sha256Before: state.sha256, sha256After: after.sha256 }
}

/**
 * 移除钩子。
 *
 * ⚠️ 只有在本插件是唯一使用者时才该调用：dsh-workbuddy-meter 也依赖同一行，
 * 删掉它会让 meter 的关键词中和失效（虽然 meter 启动时会自愈重打）。
 * 面板上不暴露这个按钮，只在 README 里作为应急手段说明。
 */
export function revertLexiconPatch({ packFile } = {}) {
  const file = packFile ?? resolvePackFile()
  const state = inspectLexicon(file)
  if (!state.ok) return { reverted: false, reason: state.reason }
  if (!state.patched) return { reverted: false, reason: 'not-patched' }
  const nextText = state.text.split('\n').filter((line) => !line.includes(LEXICON_MARKER)).join('\n')
  const tmp = `${file}.wbfix-rev-tmp`
  fs.writeFileSync(tmp, nextText, 'utf8')
  fs.renameSync(tmp, file)
  const after = inspectLexicon(file)
  return { reverted: true, patched: after.ok ? after.patched : true, sha256: after.ok ? after.sha256 : '' }
}
