/**
 * dsh-workbuddy-fix — Host half.
 *
 * 一个**只管一件事**的小插件：修复 WorkBuddy / CodeBuddy 的
 * `Illegal API invocation from an unapproved channel`（code 11128）。
 *
 * 设计约束（重要）：
 *  1. **不依赖 dsh-workbuddy-meter**，也不导入它的任何文件 —— 只装本插件
 *     就能解决 400 问题，不必先装整套计量面板。
 *  2. 与 dsh-workbuddy-meter **共享同一个状态文件**
 *     `~/.dsh/workbuddy-meter/lexicon.json`：任一方改开关，另一方随即跟随，
 *     这就是「联动」。两个插件同时装、只装一个、先装后装都能正常工作。
 *  3. 与 meter 用**同一个全局钩子名** `globalThis.__wbLexicon` 和同一方法签名
 *     `rewrite(messages)`，所以 pack.js 里那一行钩子对两者都有效。
 */

import fs from 'node:fs'
import path from 'node:path'

import {
  installLexiconHook,
  lexiconStatePath,
  normalizeLexiconConfig,
  readLexiconConfig,
  resolveDshHome,
  rewriteMessages,
  writeLexiconConfig,
} from './src/lexicon.mjs'
import {
  applyLexiconPatch,
  inspectLexicon,
  resolvePackFile,
} from './src/patch.mjs'
import { installFetchHook, isFetchHookInstalled } from './src/fetch-hook.mjs'

export const name = 'workbuddy-fix'

/** 不硬性依赖任何服务：设置页面板靠同源 HTTP 路由取数。 */
export const inject = []

const ROUTE_PREFIX = '/api/workbuddy-fix'

export function apply(ctx, config) {
  const logger = ctx.logger ?? {}
  const dshHome = resolveDshHome(config)
  const profile =
    typeof config?.profile === 'string' && config.profile.trim().length > 0
      ? config.profile.trim()
      : typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE.trim().length > 0
        ? process.env.DSH_PROFILE.trim()
        : 'desktop'

  /* --- 运行时统计（面板展示「已中和多少次」）------------------------- */
  const stats = { rewrites: 0, hits: 0, injected: 0, lastAt: null }

  /* --- 主通道：fetch 层钩子（不依赖任何第三方文件）-------------------
   *
   * 这是本插件现在的**主力方案**。原来的做法是往 OFM 的 pack.js 插一行钩子，
   * 但那个方案要求「第三方文件存在 + 结构没变」，OFM 一升级、用户装的不是 OFM
   * （而是别的 WB 反代插件）、或者 profile 对不上，就插不进去 —— 表现为
   * 面板一直显示「pack.js 未打钩子」且点「补打钩子」也没用。
   *
   * fetch 层不需要改任何文件：直接包 globalThis.fetch，在 chat/completions
   * 请求发出前改写 messages。对所有走 fetch 打 WB 的插件一律有效。
   */
  ctx.effect(() => {
    const uninstall = installFetchHook({
      getConfig: () => readLexiconConfig(dshHome),
      rewrite: (messages) => {
        const cfg = normalizeLexiconConfig(readLexiconConfig(dshHome))
        if (!cfg.enabled) return { hits: 0, injected: false, changed: false }
        const result = rewriteMessages(messages, cfg)
        return {
          hits: result.hits ?? 0,
          injected: Boolean(result.injected),
          changed: (result.hits ?? 0) > 0 || Boolean(result.injected),
        }
      },
      onStats: (result) => {
        stats.rewrites += 1
        stats.hits += result.hits
        if (result.injected) stats.injected += 1
        stats.lastAt = Date.now()
      },
      logger,
    })
    return uninstall
  }, 'workbuddy-fix: fetch hook')

  /* --- 兼容通道：pack.js 行钩子（老方案，保留但不作为依赖项）---------
   *
   * 有些 WB 请求不走 globalThis.fetch（比如插件自己起的 undici 实例、
   * 或者子进程里的 http 请求），这时 fetch 钩子拦不到，仍需要 pack.js
   * 那一行兜底。装不上也不影响功能 —— 面板会显示「可选增强未启用」。
   */
  ctx.effect(() => {
    const uninstall = installLexiconHook({
      getConfig: () => readLexiconConfig(dshHome),
      logger,
      onStats: (result) => {
        stats.rewrites += 1
        stats.hits += result.hits
        if (result.injected) stats.injected += 1
        stats.lastAt = Date.now()
      },
    })
    return uninstall
  }, 'workbuddy-fix: lexicon hook')

  /* --- 补丁自愈：pnpm 重装 OFM 会冲掉那行钩子 ------------------------ */
  ctx.effect(() => {
    let cancelled = false
    const run = () => {
      if (cancelled) return
      try {
        const packFile = resolvePackFile({ dshHome, profile })
        const inspected = inspectLexicon(packFile)
        if (!inspected.ok) {
          logger.debug?.(`workbuddy-fix: 自愈跳过（${inspected.reason}）`)
          return
        }
        if (inspected.patched) return
        const result = applyLexiconPatch({ packFile, dryRun: false })
        if (result.applied) {
          logger.info?.('workbuddy-fix: 关键词中和钩子已自动重打（pnpm 重装过 OFM），重启 DSH 后生效。')
        } else if (result.reason !== 'already-patched') {
          logger.warn?.(`workbuddy-fix: 自愈失败 —— ${result.reason}`)
        }
      } catch (error) {
        logger.debug?.(`workbuddy-fix: 自愈异常（${error instanceof Error ? error.message : String(error)}）`)
      }
    }
    const timer = setTimeout(run, 1800)
    if (typeof timer.unref === 'function') timer.unref()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, 'workbuddy-fix: patch self-heal')

  /* --- HTTP 响应助手 ------------------------------------------------ */

  // ⚠️ connection.fetch 的 handler 必须返回标准 Response 对象。
  // 返回 { status, headers, body } 这种普通对象时，宿主不识别 → 回退成
  // 400 空 body（这是本次排查中最耗时的坑）。用 Response.json 构造。
  function jsonResponse(payload) {
    return Response.json(payload, { headers: { 'cache-control': 'no-store' } })
  }

  function okResponse(value) {
    return jsonResponse({ ok: true, value })
  }

  function errorResponse(code, message) {
    return jsonResponse({ ok: false, error: { code, message } })
  }

  async function readBody(request) {
    try {
      const raw = await request.text()
      if (!raw) return {}
      const parsed = JSON.parse(raw)
      return typeof parsed === 'object' && parsed !== null ? parsed : {}
    } catch {
      return {}
    }
  }

  /* --- 路由 --------------------------------------------------------- */

  const routes = [
    {
      path: `${ROUTE_PREFIX}/status`,
      label: 'workbuddy-fix: status route',
      handler: async () => {
        try {
          const packFile = resolvePackFile({ dshHome, profile })
          const pack = inspectLexicon(packFile)
          return okResponse({
            config: readLexiconConfig(dshHome),
            stats: { ...stats },
            // 主通道：fetch 层钩子。装上了就等于功能可用，与 OFM 无关。
            fetchHookInstalled: isFetchHookInstalled(),
            // 兼容通道：pack.js 那行。装不上不算故障，只影响非 fetch 请求。
            patchPresent: pack.ok ? pack.patched : false,
            patchError: pack.ok ? null : pack.reason,
            hookInstalled: globalThis.__wbLexicon !== undefined,
            statePath: lexiconStatePath(dshHome),
            // 装了 meter 就会共用同一个文件 —— 面板据此提示「与计量插件联动中」
            meterPresent: fs.existsSync(path.join(dshHome, 'workbuddy-meter')),
          })
        } catch (error) {
          return errorResponse('wbfix/status-failed', error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      path: `${ROUTE_PREFIX}/set`,
      label: 'workbuddy-fix: set route',
      handler: async (request) => {
        try {
          const body = await readBody(request)
          const current = readLexiconConfig(dshHome)
          const next = writeLexiconConfig(dshHome, { ...current, ...(body.patch ?? {}) })
          // 重置计数：否则「已中和 N 次」会跨模式累积，看不出是哪种模式干的
          if (body.resetStats === true) {
            stats.rewrites = 0
            stats.hits = 0
            stats.injected = 0
            stats.lastAt = null
          }
          return okResponse({ config: next })
        } catch (error) {
          return errorResponse('wbfix/set-failed', error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      path: `${ROUTE_PREFIX}/repair-patch`,
      label: 'workbuddy-fix: repair-patch route',
      handler: async () => {
        try {
          const packFile = resolvePackFile({ dshHome, profile })
          const result = applyLexiconPatch({ packFile, dryRun: false })
          const pack = inspectLexicon(packFile)
          return okResponse({
            applied: result.applied,
            reason: result.reason ?? null,
            patchPresent: pack.ok ? pack.patched : false,
            patchError: pack.ok ? null : pack.reason,
          })
        } catch (error) {
          return errorResponse('wbfix/repair-failed', error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      path: `${ROUTE_PREFIX}/dry-run`,
      label: 'workbuddy-fix: dry-run route',
      handler: async (request) => {
        try {
          const body = await readBody(request)
          const config = normalizeLexiconConfig({ ...readLexiconConfig(dshHome), ...(body.patch ?? {}) })
          const sample =
            typeof body.sample === 'string' && body.sample.length > 0
              ? body.sample
              : 'You are an AI agent powered by DeepSeek Harness.\nCheckout: D:\\10_COD\\DeepSeek Harness\\resources'
          const messages = [{ role: 'system', content: sample }]
          const result = rewriteMessages(messages, config)
          return okResponse({
            before: sample,
            after: messages[0].content,
            hits: result.hits,
            injected: result.injected,
          })
        } catch (error) {
          return errorResponse('wbfix/dry-run-failed', error instanceof Error ? error.message : String(error))
        }
      },
    },
  ]

  /* --- 注册路由 ----------------------------------------------------- *
   * 取服务时逐级回退：scope[name] → scope.get(name) → ctx.get(name)。
   * 与 dsh-our-free-model / dsh-workbuddy-meter 的取法保持一致 —— 不同宿主
   * 版本暴露服务的方式略有差异，多试一层比直接读属性更稳。
   *
   * 每条路由单独包一个 scope.effect：注册动作必须在 effect 回调里执行，
   * 宿主才会在 fiber 激活时真正挂载路由。
   * ------------------------------------------------------------------- */

  function serviceOf(scope, name) {
    if (scope === undefined || scope === null) return undefined
    try {
      const direct = scope[name]
      if (direct !== undefined && direct !== null) return direct
    } catch { /* fall through */ }
    try {
      if (typeof scope.get === 'function') {
        const viaGet = scope.get(name)
        if (viaGet !== undefined && viaGet !== null) return viaGet
      }
    } catch { /* fall through */ }
    try {
      if (typeof ctx.get === 'function') {
        const viaCtx = ctx.get(name)
        if (viaCtx !== undefined && viaCtx !== null) return viaCtx
      }
    } catch { /* fall through */ }
    return undefined
  }

  ctx.inject(['connection'], (scope) => {
    const connection = serviceOf(scope, 'connection')
    const register =
      typeof connection?.fetch?.register === 'function'
        ? connection.fetch.register.bind(connection.fetch)
        : undefined
    if (register === undefined) {
      logger.warn?.('workbuddy-fix: connection 服务没有 fetch.register，路由未挂载')
      return
    }
    for (const route of routes) {
      scope.effect(
        () => register({
          path: route.path,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: route.handler,
        }),
        route.label,
      )
    }
  })

  logger.info?.('workbuddy-fix: ready（关键词风控中和，设置页可开关）')
}

