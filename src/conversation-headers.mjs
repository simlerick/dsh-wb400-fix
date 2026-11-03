/**
 * WorkBuddy 国际版（www.workbuddy.ai）的 11128 修复。
 *
 * ## 根因
 *
 * 国际版网关要求每个 chat 请求带三个会话标识头，缺任何一个就返回：
 *
 *   HTTP 400 {"code":11128,"msg":"request illegal",
 *             "displayMsg":{"zh":"请求被拦截，请重新发送"}}
 *
 * 报错文案完全误导 —— 它跟渠道、账号、token、内容审核都无关，
 * 纯粹是**缺少会话头**。
 *
 * ## 实测（2026-11-03，真实 App 解密 token）
 *
 *  没有 X-Conversation-* 三件套      → 400 request illegal
 *  加上三件套（值随意 UUID）          → 400 first message is not system prompt
 *                                        （注意错误变了 = 校验已通过，只剩格式问题）
 *  三件套 + system 首条               → 200 ✅
 *
 * 三件套：
 *   X-Conversation-ID         会话 id
 *   X-Conversation-Message-ID 消息 id
 *   X-Conversation-Request-ID 请求 id
 *
 * 三者都只需是唯一字符串；服务端不校验它们之间的关联，也不要求
 * 与之前的请求保持一致。所以每次请求生成新 UUID 即可。
 *
 * \@module src/conversation-headers.mjs
 */

import { randomUUID } from 'node:crypto'

/** 国际版域名（这些主机需要会话头）。 */
const INTL_HOSTS = ['workbuddy.ai']

/** 需要会话头的路径。 */
const CHAT_PATHS = ['/chat/completions', '/v1/chat/completions']

/** 三个必需的会话头名。 */
export const CONVERSATION_HEADERS = Object.freeze([
  'X-Conversation-ID',
  'X-Conversation-Message-ID',
  'X-Conversation-Request-ID',
])

/**
 * 这个 URL 是不是国际版的 chat 端点。
 * \@param {string} url
 * \@returns {boolean}
 */
export function needsConversationHeaders(url) {
  const text = String(url ?? '')
  let host = ''
  try { host = new URL(text).hostname.toLowerCase() } catch { return false }
  // www.workbuddy.ai / workbuddy.ai 都要；但不误伤 codebuddy.cn 等国内域
  if (!INTL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return false
  return CHAT_PATHS.some((p) => text.toLowerCase().includes(p))
}

/**
 * 补齐三个会话头（已存在则不覆盖 —— 调用方自己设的优先）。
 * \@param {Headers} headers
 * \returns {number} 补了几个
 */
export function ensureConversationHeaders(headers) {
  if (!(headers instanceof Headers)) return 0
  let added = 0
  for (const name of CONVERSATION_HEADERS) {
    if (headers.has(name)) continue
    headers.set(name, randomUUID())
    added += 1
  }
  return added
}
