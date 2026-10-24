/**
 * fetch 层钩子 —— 不依赖 OFM 的 pack.js，直接包 globalThis.fetch。
 *
 * 为什么不用 pack.js：
 *   pack.js 的钩子需要「插一行到别人打包产物里」，任何 OFM 升级改结构、
 *   换打包工具、或用户装了别的 WB 反代插件（不是 OFM），那行就插不进去。
 *   对接方反馈的「一直显示钩子没打上」就是这种情况。
 *
 * 这个实现只做一件事：在 fetch 发出前，把 chat/completions 请求体里的
 * messages 交给 rewrite()。它不看 OFM 版本、不碰任何第三方文件，
 * 所以对「任何走 fetch 打 WorkBuddy/CodeBuddy 的插件」都成立。
 *
 * 安全边界（重要）：
 *   ① 只在 URL 命中 WB 域名时介入，其它请求原样透传（零开销、零影响）
 *   ② 只处理 POST + JSON body，其它形态完全不碰
 *   ③ body 解析失败就原样放行，绝不让插件因本插件而崩
 *   ④ rewrite 抛错也原样放行
 *   ⑤ 可完整卸载（restore 原 fetch 引用）
 */

/** 命中这些主机名才算 WB 系请求。 */
const WB_HOSTS = [
  'copilot.tencent.com',
  'workbuddy.ai',
  'codebuddy.ai',
  'codebuddy.cn',
]

/** 只看这些路径，避免误伤同域其它接口。 */
const CHAT_PATHS = ['/chat/completions', '/v1/chat/completions', '/completions']

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function isWorkBuddyUrl(url, hosts = WB_HOSTS) {
  const host = hostOf(url)
  if (!host) return false
  if (!hosts.some((h) => host === h || host.endsWith(`.${h}`))) return false
  const lower = String(url).toLowerCase()
  return CHAT_PATHS.some((p) => lower.includes(p))
}

/** 把 input 归一成 { url, init }。fetch(input, init) 两种形态都要支持。 */
function normalize(input, init) {
  if (typeof input === 'string') return { url: input, init: init ?? {} }
  if (input instanceof URL) return { url: input.toString(), init: init ?? {} }
  if (input && typeof input === 'object' && typeof input.url === 'string') {
    // Request 对象：method/body 都挂在它自己身上
    return { url: input.url, init: init ?? {}, request: input }
  }
  return { url: '', init: init ?? {} }
}

/**
 * 装钩子。
 * @param {object} opts
 * @param {() => any} opts.getConfig   返回 { enabled, neutralize, ensureSystem, hideIdentity }
 * @param {(messages:any[]) => any} opts.rewrite  真正做改写的函数
 * @param {(r:{hits:number,injected:boolean}) => void} [opts.onStats]
 * @param {object} [opts.logger]
 * @param {string[]} [opts.extraHosts]  额外的 WB 主机名（测试用，或适配新域名）
 * @param {boolean} [opts.cloneBodyForRequest]  Request 形态是否强制 clone 读体（默认 true）
 * @returns {() => void} 卸载函数
 */
export function installFetchHook({
  getConfig,
  rewrite,
  onStats,
  logger = {},
  extraHosts = [],
}) {
  const hosts = extraHosts.length > 0 ? [...WB_HOSTS, ...extraHosts] : WB_HOSTS
  const original = globalThis.fetch
  if (typeof original !== 'function') {
    logger.warn?.('workbuddy-fix: globalThis.fetch 不存在，跳过 fetch 钩子')
    return () => {}
  }
  // 防止重复包装（本插件重复加载、或与 meter 插件同时存在时）
  if (original.__wbFixWrapped === true) {
    logger.debug?.('workbuddy-fix: fetch 已被包装过，跳过')
    return () => {}
  }

  const wrapped = async function wbFixFetch(input, init) {
    let cfg
    try {
      cfg = getConfig()
    } catch {
      cfg = null
    }
    if (!cfg || cfg.enabled === false) return original(input, init)

    let url = ''
    let nextInit = init
    let request = null
    try {
      const n = normalize(input, init)
      url = n.url
      nextInit = n.init
      request = n.request
    } catch {
      return original(input, init)
    }

    if (!isWorkBuddyUrl(url, hosts)) return original(input, init)

    // 只处理 POST + JSON
    const method = String((nextInit?.method ?? request?.method ?? 'GET')).toUpperCase()
    if (method !== 'POST') return original(input, init)

    // 取 body 文本
    let bodyText = null
    try {
      if (typeof nextInit?.body === 'string') {
        bodyText = nextInit.body
      } else if (request && typeof request.clone === 'function') {
        bodyText = await request.clone().text()
      }
    } catch {
      return original(input, init)
    }
    if (typeof bodyText !== 'string' || bodyText.length === 0) {
      return original(input, init)
    }

    // 解析 + 改写
    let payload
    try {
      payload = JSON.parse(bodyText)
    } catch {
      return original(input, init) // 不是 JSON，原样放行
    }
    if (!payload || !Array.isArray(payload.messages)) return original(input, init)

    let result
    try {
      result = rewrite(payload.messages)
    } catch (error) {
      logger.debug?.(
        `workbuddy-fix: rewrite 抛错，原样放行（${error instanceof Error ? error.message : String(error)}）`,
      )
      return original(input, init)
    }
    if (!result || (!result.changed && !result.injected)) return original(input, init)

    try {
      onStats?.({ hits: result.hits ?? 0, injected: Boolean(result.injected) })
    } catch {
      /* 统计失败不影响主流程 */
    }

    // 重建 init：body 换成改写后的文本，Content-Length 必须去掉（长度变了）
    const headers = new Headers(nextInit?.headers ?? request?.headers ?? undefined)
    headers.delete('content-length')
    headers.set('content-type', 'application/json')

    const rebuilt = {
      ...(nextInit ?? {}),
      method: 'POST',
      headers,
      // ⚠️ 这里必须用 rewrite 就地改过的 payload.messages —— rewrite() 是原地修改
      // 传入数组的，所以 payload.messages 已经是改写后的内容。整包重新序列化即可。
      body: JSON.stringify(payload),
    }
    // Request 形态下原始 body 已被读走，必须用 url 重新发起
    return request ? original(url, rebuilt) : original(input, rebuilt)
  }

  wrapped.__wbFixWrapped = true
  globalThis.fetch = wrapped
  logger.info?.('workbuddy-fix: fetch 层钩子已安装（不依赖 pack.js）')

  return () => {
    if (globalThis.fetch === wrapped) globalThis.fetch = original
  }
}

/** 供诊断用：当前 fetch 是否被本插件包装。 */
export function isFetchHookInstalled() {
  return globalThis.fetch?.__wbFixWrapped === true
}
