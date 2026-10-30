/**
 * dsh-workbuddy-fix — Client half.
 *
 * 在「设置」面板里注册一个独立的 section（`settings.section`），
 * 让遇到 WorkBuddy 400 错误的人一眼看到开关，不用先装整套计量面板。
 *
 * 与 dsh-workbuddy-meter 的关系：
 *   - 两个插件**互不依赖**，可单独装、可同时装；
 *   - 共享同一个状态文件 `~/.dsh/workbuddy-meter/lexicon.json`，
 *     所以任一方改了开关，另一方立即跟随（这就是「联动」）。
 *
 * 取数走插件自己的 /api/workbuddy-fix/* 同源路由（与 dsh-our-free-model 一致）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-wb400-fix',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useCallback = React.useCallback

    const NS = 'workbuddy-fix'
    const SECTION_ID = 'workbuddy-fix'

    /* ------------------------------------------------------------------ *
     * 文案：优先用宿主 locale 服务，取不到则回落到内置字典
     * ------------------------------------------------------------------ */

    /* ------------------------------------------------------------------ *
     * 同源 RPC：与本包 Host 半身通信
     *
     * 走插件自己的 /api/workbuddy-fix/* 路由（与 dsh-our-free-model 相同的
     * 做法），不依赖 host.call —— 后者需要额外的 Host 侧方法声明，未在此验证。
     * ------------------------------------------------------------------ */

    function apiBase() {
      try { return new URL('api/workbuddy-fix', document.baseURI).pathname }
      catch { return '/api/workbuddy-fix' }
    }

    function postJSON(path, body) {
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null
      const timer = setTimeout(() => ctrl && ctrl.abort(), 15000)
      return fetch(apiBase() + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
        redirect: 'error',
        signal: ctrl ? ctrl.signal : undefined,
      })
        .then((res) => res.json())
        .then((json) => {
          if (!json || json.ok !== true) {
            throw new Error((json && json.error && json.error.message) || 'request failed')
          }
          return json.value
        })
        .finally(() => clearTimeout(timer))
    }

    const ZH = {
      'nav': 'wb400修复',
      'title': '关键词风控中和',
      'subtitle': '上游按关键词拦截请求时的一键修复',
      'state.on': '已修复',
      'state.off': '已关闭',
      'master.label': '总开关',
      'master.hint': '关闭后完全恢复原始请求，一个字节都不改',
      'option.demoteSystem': '降级 system 消息（核心）',
      'option.demoteSystemHint': '把 system 消息改成 user 消息并加「系统设定」前缀。2026-10 起上游按 role 判定，这是唯一有效解法，指令无损',
      'option.neutralize': '中和身份关键词',
      'option.neutralizeHint': '把「DeepSeek​ Harness」中间插入不可见分隔符，语义不变、上游不再拦截',
      'option.ensureSystem': '补首条 system（已废弃）',
      'option.ensureSystemHint': '降级开启时这项会被忽略——补 system 等于把刚拆掉的雷装回去',
      'option.hideIdentity': '隐藏品牌词',
      'option.hideIdentityHint': '更激进：连 DeepSeek 也打散。默认关闭',
      'why.title': '这个报错到底是怎么回事',
      'why.body': '上游返回 400，报文写着 Illegal API invocation from an unapproved channel，看起来像渠道问题——实际上跟渠道、域名、客户端身份、请求头都无关。真正原因是上游在对 system prompt 做关键词内容风控：只要出现「DeepSeek​ Harness」这个词组就会被拒。',
      'why.selfCheck': '60 秒自证',
      'why.selfCheckBody': '用同一个 token 打两次，只改 system prompt 里的一个词。含关键词的那次失败、去掉关键词的那次成功，就说明是这个原因。',
      'why.intermittent': '为什么时好时坏',
      'why.intermittentBody': '关键词要配合请求体够大（约超过 1KB）才稳定触发。短 prompt 即使含关键词也会放过，这是最容易误判成「偶发故障」的地方。',
      'status.patchOk': '钩子已就位',
      'status.patchMissing': 'pack.js 未打钩子',
      'status.hookOk': '运行时钩子已安装',
      'status.hookMissing': '运行时钩子未安装',
      'status.repair': '补打钩子',
      'status.repairing': '处理中…',
      'status.meterLinked': '与「用量计量」插件联动中（共享同一份开关）',
      'status.standalone': '独立运行（未检测到用量计量插件）',
      'stats.label': '本机已降级 system {k} 条，中和 {n} 处，补 system {m} 次',
      'stats.idle': '还没有需要改写的请求',
      'preview.title': '效果预览',
      'preview.before': '改写前',
      'preview.after': '改写后',
      'preview.hits': '命中 {n} 处',
      'preview.note': '文件路径不会被改写',
      'restore.hint': '上游不再拦截后，把总开关关掉即可完全恢复原样。',
      'error.loadFailed': '读取状态失败：{reason}',
    }

    const EN = {
      'nav': 'wb400 Fix',
      'title': 'Keyword filter bypass',
      'subtitle': 'One-click fix when the upstream rejects requests by keyword',
      'state.on': 'Fixed',
      'state.off': 'Off',
      'master.label': 'Master switch',
      'master.hint': 'Turning this off restores the original request untouched',
      'option.demoteSystem': 'Demote system message (core)',
      'option.demoteSystemHint': 'Rewrites role=system into role=user with a prefix. Since Oct 2026 upstream judges by role; this is the only working fix and loses no prompt text',
      'option.neutralize': 'Neutralise identity keyword',
      'option.neutralizeHint': 'Inserts an invisible separator inside "DeepSeek Harness" — same meaning, no longer blocked',
      'option.ensureSystem': 'Prepend system message (deprecated)',
      'option.ensureSystemHint': 'Ignored while demotion is on — adding a system message re-arms the exact rule demotion removed',
      'option.hideIdentity': 'Also hide brand word',
      'option.hideIdentityHint': 'More aggressive: splits DeepSeek too. Off by default',
      'why.title': 'What this error actually is',
      'why.body': 'The upstream returns 400 with "Illegal API invocation from an unapproved channel", which looks like a channel problem. It is not — it has nothing to do with the channel, domain, client identity or headers. The real cause is keyword-based content filtering on the system prompt: the phrase "DeepSeek Harness" gets the request rejected.',
      'why.selfCheck': 'Verify in 60 seconds',
      'why.selfCheckBody': 'Send the same request twice with the same token, changing only one word in the system prompt. If the one containing the keyword fails and the other succeeds, this is the cause.',
      'why.intermittent': 'Why it seems intermittent',
      'why.intermittentBody': 'The keyword only triggers reliably with a large enough body (roughly over 1KB). Short prompts pass even with the keyword, which is why it is easily mistaken for a flaky failure.',
      'status.patchOk': 'Hook in place',
      'status.patchMissing': 'pack.js has no hook',
      'status.hookOk': 'Runtime hook installed',
      'status.hookMissing': 'Runtime hook missing',
      'status.repair': 'Reinstall hook',
      'status.repairing': 'Working…',
      'status.meterLinked': 'Linked with the usage-meter plugin (shared switches)',
      'status.standalone': 'Standalone (usage-meter plugin not detected)',
      'stats.label': 'Demoted {k} system messages, neutralised {n} spots, prepended system {m} times',
      'stats.idle': 'No request needed rewriting yet',
      'preview.title': 'Preview',
      'preview.before': 'Before',
      'preview.after': 'After',
      'preview.hits': '{n} matches',
      'preview.note': 'File paths are never rewritten',
      'restore.hint': 'Once the upstream stops blocking, switch the master switch off to restore the original behaviour.',
      'error.loadFailed': 'Failed to load status: {reason}',
    }

    // 两种字典风格都要支持：
    //   ① 嵌套（locale/*.json 的形态）：{ state: { on: "已修复" } }
    //   ② 扁平点号键（内嵌字典为了紧凑）：{ "state.on": "已修复" }
    // 先查扁平键，再按点号逐层下钻 —— 只做一种会静默回退成 key。
    function pick(dict, key) {
      if (dict === null || typeof dict !== 'object') return undefined
      const flat = dict[key]
      if (typeof flat === 'string') return flat
      const parts = String(key).split('.')
      let node = dict
      for (const part of parts) {
        if (node === null || typeof node !== 'object') return undefined
        node = node[part]
      }
      return typeof node === 'string' ? node : undefined
    }

    function interpolate(text, vars) {
      if (!vars) return text
      return String(text).replace(/\{(\w+)\}/g, (all, name) =>
        Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : all)
    }

    function makeT(ctx) {
      let bound = null
      try {
        if (ctx && ctx.locale && typeof ctx.locale.bind === 'function') bound = ctx.locale.bind(NS)
      } catch { bound = null }
      return function t(key, vars) {
        if (typeof bound === 'function') {
          try {
            const value = bound(key, vars)
            if (typeof value === 'string' && value !== '' && value !== key) return value
          } catch { /* fall through */ }
        }
        let text = pick(ZH, key)
        if (text === undefined) text = pick(EN, key)
        if (text === undefined) return String(key)
        return interpolate(text, vars)
      }
    }

    /* ------------------------------------------------------------------ *
     * 样式（只用主题 token，跟随明暗）
     * ------------------------------------------------------------------ */

    const STYLES = `
      .wbfix{display:flex;flex-direction:column;gap:14px;padding:2px 2px 24px;font-size:13px;color:var(--dsw-alias-label-primary)}
      .wbfix-head{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}
      .wbfix-headtext{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1 1 auto}
      .wbfix-h1{font-size:16px;font-weight:600;margin:0;line-height:1.3}
      .wbfix-sub{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.4}
      .wbfix-badge{flex:none;font-size:11px;font-weight:700;letter-spacing:.03em;padding:3px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}
      .wbfix-badge[data-on="true"]{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,var(--dsw-alias-border-l2));background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}
      .wbfix-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:14px 16px;background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;gap:11px}
      .wbfix-row{display:flex;align-items:center;gap:12px}
      .wbfix-rowtext{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto}
      .wbfix-rowlabel{font-size:13px;font-weight:600;line-height:1.35}
      .wbfix-rowhint{font-size:11.5px;color:var(--dsw-alias-label-tertiary);line-height:1.45}
      .wbfix-row[data-disabled="true"]{opacity:.45}
      .wbfix-switch{appearance:none;flex:none;position:relative;width:38px;height:21px;border-radius:999px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-4);cursor:pointer;padding:0;transition:background .18s ease,border-color .18s ease}
      .wbfix-switch[data-on="true"]{background:var(--dsw-alias-state-success-primary);border-color:transparent}
      .wbfix-switch[data-locked="true"]{cursor:not-allowed}
      .wbfix-knob{position:absolute;top:50%;left:2px;width:15px;height:15px;border-radius:50%;background:var(--dsw-alias-bg-layer-1);transform:translateY(-50%);transition:left .18s cubic-bezier(.4,0,.2,1);box-shadow:0 1px 2px color-mix(in srgb,var(--dsw-alias-label-primary) 28%,transparent)}
      .wbfix-switch[data-on="true"] .wbfix-knob{left:20px;background:var(--dsw-alias-bg-layer-4)}
      .wbfix-sep{height:1px;background:var(--dsw-alias-border-l2);margin:1px 0}
      .wbfix-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
      .wbfix-dot{flex:none;width:7px;height:7px;border-radius:50%}
      .wbfix-dot[data-ok="true"]{background:var(--dsw-alias-state-success-primary)}
      .wbfix-dot[data-ok="false"]{background:var(--dsw-alias-state-warn-primary)}
      .wbfix-note-soft{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary);word-break:break-word}
      .wbfix-err{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-state-error-primary);word-break:break-word}
      .wbfix-btn{appearance:none;font:inherit;font-size:11.5px;font-weight:600;padding:4px 11px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);cursor:pointer}
      .wbfix-btn:hover{border-color:var(--dsw-alias-brand-primary)}
      .wbfix-btn:disabled{opacity:.5;cursor:not-allowed}
      .wbfix-why{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:14px 16px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:9px}
      .wbfix-why-title{margin:0;font-size:12.5px;font-weight:700;color:var(--dsw-alias-label-primary)}
      .wbfix-why-body{margin:0;font-size:12px;line-height:1.65;color:var(--dsw-alias-label-secondary)}
      .wbfix-why-sub{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary);margin:3px 0 0}
      .wbfix-pre{display:flex;flex-direction:column;gap:5px}
      .wbfix-pre-label{font-size:10.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
      .wbfix-pre-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.55;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary)}
      .wbfix-note{font-size:11px;color:var(--dsw-alias-label-tertiary);margin:0;line-height:1.5}
      .wbfix-err{font-size:11.5px;color:var(--dsw-alias-state-error-primary);margin:0}
      @media (prefers-reduced-motion:reduce){.wbfix-switch,.wbfix-knob{transition:none}}
    `

    /* ------------------------------------------------------------------ *
     * 小组件
     * ------------------------------------------------------------------ */

    function ToggleRow(props) {
      return h(
        'div',
        { className: 'wbfix-row', 'data-disabled': props.disabled ? 'true' : 'false' },
        h('div', { className: 'wbfix-rowtext' },
          h('span', { className: 'wbfix-rowlabel' }, props.label),
          h('span', { className: 'wbfix-rowhint' }, props.hint)),
        h('button', {
          type: 'button',
          className: 'wbfix-switch',
          role: 'switch',
          'aria-checked': props.checked ? 'true' : 'false',
          'aria-label': props.label,
          'data-on': props.checked ? 'true' : 'false',
          'data-locked': props.disabled || props.busy ? 'true' : 'false',
          onClick: () => {
            if (props.disabled || props.busy) return
            props.onChange(!props.checked)
          },
        }, h('span', { className: 'wbfix-knob' }))
      )
    }

    function WhyCard(props) {
      const t = props.t
      return h('div', { className: 'wbfix-why' },
        h('h3', { className: 'wbfix-why-title' }, t('why.title')),
        h('p', { className: 'wbfix-why-body' }, t('why.body')),
        h('p', { className: 'wbfix-why-sub' }, t('why.selfCheck')),
        h('p', { className: 'wbfix-why-body' }, t('why.selfCheckBody')),
        h('p', { className: 'wbfix-why-sub' }, t('why.intermittent')),
        h('p', { className: 'wbfix-why-body' }, t('why.intermittentBody')))
    }

    function PreviewCard(props) {
      const t = props.t
      const pre = props.preview
      if (!pre) return null
      return h('div', { className: 'wbfix-why' },
        h('h3', { className: 'wbfix-why-title' }, t('preview.title')),
        h('div', { className: 'wbfix-pre' },
          h('span', { className: 'wbfix-pre-label' }, t('preview.before')),
          h('code', { className: 'wbfix-pre-code' }, pre.before)),
        h('div', { className: 'wbfix-pre' },
          h('span', { className: 'wbfix-pre-label' },
            t('preview.after') + (pre.hits > 0 ? ' · ' + t('preview.hits', { n: pre.hits }) : '')),
          h('code', { className: 'wbfix-pre-code' }, pre.after)),
        h('p', { className: 'wbfix-note' }, t('preview.note')))
    }

    /* ------------------------------------------------------------------ *
     * 设置页面板
     * ------------------------------------------------------------------ */

    function FixPanel(props) {
      const t = props.t

      const [state, setState] = useState({ status: 'loading', value: null, error: null })
      const [busy, setBusy] = useState(false)
      const [preview, setPreview] = useState(null)

      const load = useCallback(() => {
        postJSON('/status', {})
          .then((value) => setState({ status: 'ready', value, error: null }))
          .catch((error) => setState({ status: 'error', value: null, error: errorText(error) }))
      }, [])

      useEffect(() => { load() }, [load])

      const apply = useCallback((patch) => {
        setBusy(true)
        // 乐观更新：先动 UI，失败再回滚，避免开关看起来「点了没反应」
        setState((prev) => {
          if (!prev.value) return prev
          return { ...prev, value: { ...prev.value, config: { ...prev.value.config, ...patch } } }
        })
        postJSON('/set', { patch, resetStats: true })
          .then((res) => {
            setState((prev) => prev.value
              ? { ...prev, value: { ...prev.value, config: res.config, stats: { rewrites: 0, hits: 0, injected: 0, demoted: 0 } } }
              : prev)
            // 刷新预览，让用户立刻看到改写效果
            return postJSON('/dry-run', { patch })
          })
          .then((res) => { if (res) setPreview(res) })
          .catch((error) => setState((prev) => ({ ...prev, error: errorText(error) })))
          .finally(() => setBusy(false))
      }, [])

      const repair = useCallback(() => {
        setBusy(true)
        postJSON('/repair-patch', {})
          .then((res) => {
            setState((prev) => prev.value
              ? { ...prev, value: { ...prev.value, patchPresent: res.patchPresent === true } }
              : prev)
          })
          .catch((error) => setState((prev) => ({ ...prev, error: errorText(error) })))
          .finally(() => setBusy(false))
      }, [])

      const v = state.value
      const config = v ? v.config || {} : {}
      const enabled = config.enabled !== false
      const stats = v ? v.stats || {} : {}

      const badge = v ? (enabled ? t('state.on') : t('state.off')) : '…'

      return h('div', { className: 'wbfix' },
        h('style', null, STYLES),

        h('div', { className: 'wbfix-head' },
          h('div', { className: 'wbfix-headtext' },
            h('h2', { className: 'wbfix-h1' }, t('title')),
            h('span', { className: 'wbfix-sub' }, t('subtitle'))),
          h('span', { className: 'wbfix-badge', 'data-on': enabled ? 'true' : 'false' }, badge)),

        state.status === 'error'
          ? h('p', { className: 'wbfix-err' }, t('error.loadFailed', { reason: state.error || '' }))
          : null,

        v
          ? h('div', { className: 'wbfix-card' },
              h(ToggleRow, {
                label: t('master.label'),
                hint: t('master.hint'),
                checked: enabled,
                busy,
                disabled: false,
                onChange: (next) => apply({ enabled: next }),
              }),
              h('div', { className: 'wbfix-sep' }),
              h(ToggleRow, {
                label: t('option.demoteSystem'),
                hint: t('option.demoteSystemHint'),
                checked: config.demoteSystem !== false,
                busy,
                disabled: !enabled,
                onChange: (next) => apply({ demoteSystem: next }),
              }),
              h(ToggleRow, {
                label: t('option.neutralize'),
                hint: t('option.neutralizeHint'),
                checked: config.neutralize !== false,
                busy,
                disabled: !enabled,
                onChange: (next) => apply({ neutralize: next }),
              }),
              h(ToggleRow, {
                label: t('option.ensureSystem'),
                hint: t('option.ensureSystemHint'),
                checked: config.ensureSystem === true,
                busy,
                disabled: !enabled,
                onChange: (next) => apply({ ensureSystem: next }),
              }),
              h(ToggleRow, {
                label: t('option.hideIdentity'),
                hint: t('option.hideIdentityHint'),
                checked: config.hideIdentity === true,
                busy,
                disabled: !enabled,
                onChange: (next) => apply({ hideIdentity: next }),
              }),

              h('div', { className: 'wbfix-meta' },
                h('span', { className: 'wbfix-dot', 'data-ok': v.fetchHookInstalled ? 'true' : 'false' }),
                h('span', null, v.fetchHookInstalled ? t('status.fetchOk') : t('status.fetchMissing')),
                h('span', { className: 'wbfix-dot', 'data-ok': v.patchPresent ? 'true' : 'false' }),
                h('span', null, v.patchPresent ? t('status.patchOk') : t('status.patchOptional')),
                !v.patchPresent
                  ? h('button', {
                      type: 'button',
                      className: 'wbfix-btn',
                      disabled: busy,
                      onClick: repair,
                    }, busy ? t('status.repairing') : t('status.repair'))
                  : null),
              // 主通道是 fetch 钩子；它挂了才是真故障，要给出可操作提示。
              !v.fetchHookInstalled
                ? h('div', { className: 'wbfix-meta' },
                    h('span', { className: 'wbfix-err' }, t('status.fetchMissingHint')))
                : null,
              // 兼容通道没打上不算故障 —— 只是「非 fetch 请求拦不到」。有原因就显示。
              !v.patchPresent && v.patchError
                ? h('div', { className: 'wbfix-meta' },
                    h('span', { className: 'wbfix-note-soft' }, v.patchError))
                : null,

              h('div', { className: 'wbfix-meta' },
                h('span', null,
                  stats.rewrites > 0
                    ? t('stats.label', { k: stats.demoted || 0, n: stats.hits || 0, m: stats.injected || 0 })
                    : t('stats.idle'))),

              h('div', { className: 'wbfix-meta' },
                h('span', null, v.meterPresent ? t('status.meterLinked') : t('status.standalone'))),

              h('p', { className: 'wbfix-note' }, t('restore.hint'))
            )
          : null,

        v ? h(PreviewCard, { t, preview }) : null,
        h(WhyCard, { t })
      )
    }

    function errorText(error) {
      if (error === null || error === undefined) return ''
      if (typeof error === 'string') return error
      if (typeof error.message === 'string') return error.message
      return String(error)
    }

    /* ------------------------------------------------------------------ *
     * 注册到 settings.section
     * ------------------------------------------------------------------ */

    return {
      inject: ['slots'],
      apply(ctx) {
        // ⚠️ 两个必须避开的坑（都会让宿主白屏 "Failed to load plugins"）：
        //
        // ① 不要给 slots.register 传 `locale` 选项。
        //    它的类型是 keyof LocaleNamespaceMap，未在该 map 里注册的
        //    namespace 会被宿主校验拒绝，而 slots.inject 的回调错误是
        //    **同步抛出**的 → 整个 client 半身加载失败 → 白屏。
        //
        // ② 不要在 inject 回调里做可能抛错的事（同上）。
        //
        // 文案改用本模块自带的字典（makeT 优先问宿主 locale，取不到就用
        // 内嵌 ZH/EN），因此完全不依赖宿主 locale 注册。

        const t = makeT(ctx)

        ctx.slots.inject('settings.section', () => {
          try {
            return ctx.slots.register({
              name: 'settings.section',
              // 独立 id：新条目会「加在」现有条目旁边。
              // 若复用已发布的 id 会替换掉那个页面 —— 绝不能撞车。
              id: SECTION_ID,
              order: 36,
              label: () => t('nav'),
            }, (props) => h(FixPanel, { ...props, t }))
          } catch (error) {
            // 注册失败只影响本插件这一页，绝不能让宿主 UI 挂掉
            console.error('[workbuddy-fix] slot registration failed:', error)
            return () => {}
          }
        })
      },
    }
  },
})
