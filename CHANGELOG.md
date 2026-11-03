# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.4.0] - 2026-11-03

### 支持 WorkBuddy 国际版（www.workbuddy.ai）

国际版的 11128 跟国内版**根因完全不同**，报错文案却一模一样。

**真正原因：缺少三个会话标识头。**

```
X-Conversation-ID
X-Conversation-Message-ID
X-Conversation-Request-ID
```

实测矩阵（真实凭据）：

| 请求 | 结果 |
|---|---|
| 不带三件套 | ❌ 400 `request illegal` |
| 带三件套（值随意 UUID） | ⚠️ 400 `first message is not system prompt`（**错误变了 = 校验已过**） |
| 三件套 + system 首条 | ✅ **200** |

关键点：

- 三个头只需是唯一字符串，服务端**不校验它们之间的关联**，也不要求跨请求一致
- **不需要**解密 App 的 `$wbEncrypted` token —— `~/.dsh/.credentials.yaml` 的明文 token 加三个头就能用
- **不需要** `X-IDE-*`、`X-User-Id`、`X-Requested-With`（最小头实测 200）

### 关键修正：为什么必须改 pack.js 而不是包 fetch

v1.4 初版把修复做成 `fetch` 钩子（包 `globalThis.fetch`），**完全无效**。

原因：OFM 的 `fetchImpl` 来自 `createChannelFetch()`：

```js
const network = createChannelFetch({ outlet: config.outlet })
// ...
fetchImpl: network.fetch   // ← 自定义包装器，不是 globalThis.fetch
```

所以包 `globalThis.fetch` 的钩子**一个请求都拦不到**，面板却显示"已安装"。

现在改为直接注入 `registerBuddyLlm` 的 `send()` —— 唯一能同时改 headers 和 body 的位置：

```js
// [wbfix:@]    国内：body 里 @ → \@
// [wbfix:conv] 国际：headers 补三个 X-Conversation-*
```

按 `product.id` 分流，两者互不影响。

### 新增自愈

`pnpm install` 重装 OFM 会冲掉 `pack.js` 里的注入。插件启动后 2.2 秒自动检查并重打，幂等（已打过就跳过）。

### 三个渠道对照（同一个 11128，三种不同原因）

| 渠道 | 真实原因 | 修法 |
|---|---|---|
| CodeBuddy 国内 | `@`-mention 路径解析 + 身份句模板 | body 改写 |
| WorkBuddy 国际 | 缺三个会话头 | 补 header |
| 早期误判 | 以为检查 `role=system` | 错的，已废弃 |

---

## [1.3.0] - 2026-11-03

### 根因修正：两个参数校验，不是 role 检查

用户朋友（Windows 版实现）实测定位出真实原因，我逐条复现验证：

**触发条件 1：`@`-mention 后跟路径样式长句**

CodeBuddy 网关把请求文本里的 `@` 当文件引用解析。DSH 系统提示有：

```
Tokens prefixed with \@ are paths the user explicitly referenced.
Relative paths resolve from the workspace root ...
```

`@ ` + 长句 → 网关当路径解析 → 失败 → 11128。

实测矩阵：

| 变体 | 结果 |
|---|---|
| 原句含 `@ ` + 长句 | ❌ 400 |
| `@` → `\@`（反斜杠转义） | ✅ 200 |
| `@` → `Z` | ✅ 200 |
| `@` 单独 / `@abc` / `@` 后接中文 | ✅ 200 |
| `@` → 全角 `＠` / 零宽 / NBSP / 删空格 | ❌ 全部 400 |

**触发条件 2：产品身份句模板匹配**

| 变体 | 结果 |
|---|---|
| `You are an AI agent powered by DeepSeek​ Harness.` | ❌ 400 |
| `You are an AI agent running in DeepSeek​ Harness.` | ✅ 200 |
| `DeepSeek​ Harness`（单独） | ✅ 200 |
| `DeepSeek` / `Harness` 单独 | ✅ 200 |
| `DeepSeek\u200B Harness`（零宽） | ❌ 仍 400 |

注意：DSH 实际发的是 `running in`，本来就 200。这条修复是为 `powered by` 变体兜底。

### 改动

- **新增 `escapeMentions`（默认开）**：`text.replace(/(^|\s)@/g, '$1\\@')`
- **新增身份句改写**：`powered by` → `running in`
- **`demoteSystem` 默认关闭**：这是早期误判（以为网关检查 `role="system"`），
  降级成 user 只是碰巧绕过，不是根因。仅留作兜底开关。
- **删除废弃 UI**：`补首条 system`、`隐藏品牌词` 两个按钮及相关文案/后端字段
- `fetch-hook` 的 `changed` 判定补齐 `mentions` / `identity`

### 验证

真实 11.6KB DSH system prompt + 真实凭据 → 200，`role` 保持 `system`（不靠降级）。

---

## [1.2.0] - 2026-10-30

### 上游规则变更，核心修复重写（重要）

腾讯把 `11128` 的判定规则从「**关键词匹配**」换成了「**检查 `role`**」。
v1 的零宽空格手法**已经彻底失效** —— 实测同一份 11.6KB system prompt：

| 手法 | 结果 |
|---|---|
| 插零宽空格（v1 核心手法） | ❌ 400 |
| 整词替换成 `DeepSeek Agent` | ❌ 400 |
| 改第一句 / 加前缀 | ❌ 400 |
| **system 消息降级为 user 消息** | ✅ **200** |

新规则只看「`messages` 里有没有像 agent 指令的 `role="system"`」，与关键词无关；
也不是长度限制（12000 字元中性文本作为 system 可以通过）。

### 改动

- **新增 `demoteSystem`（默认开启）**：把 `role: "system"` 改写成 `role: "user"`，
  并加 `【系统设定】` 前缀。**提示词一字不丢**（11649 → 11659 字，只多了前缀）。
- `ensureSystem` 默认改为 **false**，且 `demoteSystem` 开启时**强制忽略** ——
  补一条 system 等于把刚拆掉的雷装回去。
- 关键词中和保留为双保险（对新规则无效，但成本近乎为零）。
- `fetch-hook` 的 `changed` 判定必须包含 `demoted`，否则降级后仍会发出原 body
  （这是本次最容易踩的坑）。
- 面板新增「降级 system 消息」开关；统计新增「已降级 system N 条」。
- 中英文 README 的原理章节按新规则重写，并明确标注 v1 的解释已过时。

### 验证

真实 DSH system prompt（11649 字）+ 真实凭据：
- 原样作为 system → 400
- 降级为 user → 200
- 降级后模型仍能正确回答只存在于 system prompt 后半段的内容

---

## [1.1.1] - 2026-10-24

### 发布整理

首个公开发布版本（仓库 `simlerick/dsh-wb400-fix`）。

- 包名改为 `dsh-wb400-fix`（原 `@balong/dsh-workbuddy-fix` 为本地临时命名，对应 scope 与仓库均不存在）。
- 修正作者、仓库、主页、issue 链接与 LICENSE 署名。
- README 移除不存在的演示动图与音频来源说明，补上公开仓库的克隆安装方式。
- 声明 `private: true` 移除（此前用于防止误发 npm）。

---

## [1.1.0] - 2026-10-21

### 架构改动（重要）

**不再依赖 dsh-our-free-model 的文件结构。** 旧版必须往 OFM 的
`vendor/channel-pack/pack.js` 插一行钩子 —— 这意味着 OFM 升级改结构、
用户装的不是 OFM（而是别的 WB 反代插件）、或者插件与 OFM 不在同一个
profile，钩子就插不进去，表现为面板一直显示「pack.js 未打钩子」且
点「补打钩子」也无效。

v1.1.0 把主通道改成**包 `globalThis.fetch`**：在 `chat/completions`
请求发出前改写 body。不修改任何文件，因此对**任何走 fetch 发 WB 请求的
反代插件**都有效，与 OFM 版本/路径/profile 无关。

- 新增 `src/fetch-hook.mjs`
- 命中范围：`copilot.tencent.com` / `workbuddy.ai` / `codebuddy.ai` / `codebuddy.cn`
  的 `chat/completions`
- 安全边界：非 WB 域名/非 POST/非 JSON/解析失败/rewrite 抛错 → 一律原样透传
- 关掉总开关后 body 与原请求字节级一致
- pack.js 行钩子降级为**可选兼容通道**（兜底非 fetch 请求），打不上不再算故障，
  面板显示「旧版钩子未打上（不影响使用）」

### 自检
- 新增 `_out/selftest-fetch-hook.mjs`：7 项全通过（拦截改写 / 非 WB 透传 /
  关闭后字节一致 / 非 JSON 放行 / GET 不介入 / rewrite 异常不拖垮 / 可卸载）

## [1.0.1] - 2026-10-21

### 修复
- **面板不再吞掉错误原因**：之前「pack.js 未打钩子」只显示结论，不显示为什么，用户只能盲点「补打钩子」。现在会直接显示具体原因（OFM 未安装 / pack.js 路径不存在 / 锚点不匹配），并区分「OFM 升版导致锚点消失」这种补打也修不了的情况。
- **运行时钩子缺失时给出可操作提示**，而不是只报状态。

### 新增
- `diagnose.mjs` 独立诊断脚本：逐项检查 DSH_HOME、profile、OFM 安装、pack.js、钩子与锚点，并明确告知卡在哪一步、怎么修。只读，不改文件。

## [1.0.0] — 2026-10-21

首个公开版本。

### 新增

- **一键修复 WorkBuddy / CodeBuddy 400 错误**（`Illegal API invocation from an
  unapproved channel` / code `11128`）。
  - 真因是上游对 system prompt 做**关键词**内容风控，命中 `DeepSeek Harness` 即拒；
  - 修法是在两个词之间插入零宽空格 `U+200B` —— 语义不变、上下文不丢、完全无损；
  - 实测：原文 **0/5 失败** → 中和后 **5/5 通过**（真实 DSH 请求形状）。
- **设置页独立面板**（`settings.section`，导航名 `wb400修复`），4 个开关：
  总开关 / 中和身份关键词 / 补首条 system / 隐藏品牌词。
- **文件路径保护**：匹配器带前后负向断言 `(?<![\\/])…(?![\\/])`，
  不会把 `D:\...\DeepSeek Harness\...` 这类真实路径改坏。
- **与 dsh-workbuddy-meter 联动**：共享状态文件
  `~/.dsh/workbuddy-meter/lexicon.json`，任一方改开关另一方立即跟随。
  两个插件可同时安装，也可只装其一。
- **补丁自愈**：pnpm 重装 OFM 会冲掉 `pack.js` 里的钩子行，插件启动时自动重打。

### 修复（开发过程中踩到并修掉的四个真 bug）

1. **宿主白屏**：给 `slots.register` 传 `locale` 选项，namespace 未在宿主
   `LocaleNamespaceMap` 中注册 → 校验同步抛错 → 整个 client 半身加载失败
   → `Failed to load plugins`。已移除该选项，并给所有注册点加 `try/catch`，
   保证最坏只是「这一页打不开」，绝不拖垮宿主 UI。
2. **路由全 400**：`connection.fetch` 的 handler 必须返回**标准 `Response`**；
   返回 `{ status, headers, body }` 普通对象会被宿主判为无效请求。
3. **文案显示成 key**：内嵌字典用扁平点号键，而 `pick()` 只按下钻查找
   → 全部回退成 `state.on` 这种原始 key。已改为两种风格都支持。
4. `apply()` 中段曾因清理脚本的正则误删导致 `ReferenceError`，已重写。

### 验证

- Host 侧路由与联动：**10/10**
- 钩子端到端（散文中和 / 路径保护 / 统计 / 关开关不改写）：**6/6**
- 设置页面板：真浏览器渲染确认，4 个开关 + 中文文案
- 旧插件 `dsh-workbuddy-meter`：自测通过、路由 200，未受影响
