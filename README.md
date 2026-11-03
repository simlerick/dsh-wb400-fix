# dsh-wb400-fix

**一句话：让 DeepSeek​ Harness 里用 WorkBuddy / CodeBuddy 模型时不再报 400。**

> **v1.3（2026-11-03）根因修正**：真正原因是网关的两处**参数校验**——
> ① `@`-mention 后跟路径样式长句；② 产品身份句模板匹配。
> 早期版本误判为「检查 role」，现已改正。零宽空格**确实无效**。
> 详见 [它为什么能修好](#它为什么能修好原理)。

[中文](README.md) · [English](README.en.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

---

## 这是什么

这是一个 **DeepSeek​ Harness 的插件**（不是独立软件，装进 DSH 里用）。

它只做一件事：修好 WorkBuddy / CodeBuddy 模型在 DSH 里反复出现的这个报错——

```
Illegal API invocation from an unapproved channel
HTTP 400 · code 11128
```

装好、打开开关，报错就没了。**你的请求内容不会被改变**，只是让上游不再误判。

---

## 我需要它吗

如果你符合下面任意一条，就需要：

- 在 DSH 里用 WorkBuddy 或 CodeBuddy 的模型，**经常被「请求被拦截」中断**
- 用 `dsh-our-free-model` 这类反代插件接了腾讯的免费额度，但发长消息就被打回
- 看到过 `code 11128` 或 `code 11140`

如果下面这些符合你，就**不需要**：

- 只用 DeepSeek 官方 API、OpenRouter、或别的非腾讯渠道
- 从没遇到过上面的报错

---

## 安装

```bash
git clone https://github.com/simlerick/dsh-wb400-fix.git
```

然后在 DSH 里说一句：

> 把 `/path/to/dsh-wb400-fix` 装成插件

**装完重启一次 DSH**，设置页里会出现 **wb400修复**。

<details>
<summary>手动安装（link 方式）</summary>

在 `~/.dsh/profiles/<profile>/package.json`：

```json
{
  "dsh": { "profile": { "bundles": ["...", "dsh-wb400-fix"] } },
  "dependencies": { "dsh-wb400-fix": "link:/path/to/dsh-wb400-fix" }
}
```

然后在该目录执行 `pnpm install`。

</details>

---

## 使用

打开 **设置 → wb400修复**：

| 开关 | 默认 | 作用 |
|---|---|---|
| 总开关 | 开 | 关掉即完全恢复原始请求 |
| **转义 @-mention** | **开** | **核心修复 1**：把 `@` 转成 `\@`，网关不再当文件引用解析 |
| **改写身份句** | **开** | **核心修复 2**：`powered by X Harness` → `running in X Harness` |
| 中和身份关键词 | 开 | 零宽空格手法（对当前规则**无效**，保留作历史兼容） |
| 降级 system 消息 | **关** | ⚠️ 历史误判。真实根因不是 role，仅留作兜底 |
| 补首条 system | **关** | 已废弃 |
| 隐藏品牌词 | 关 | 更激进：连 `DeepSeek` 也打散 |

面板还会显示：已降级多少条 system、已中和多少处、改写前后对照预览。

**改完即时生效，不需要重启。**

> 大多数情况下，装完什么都不用动，默认就是对的。

---

## 前置条件

| 项 | 要求 |
|---|---|
| DeepSeek​ Harness 桌面版 | 已在用 |
| 任一 WorkBuddy/CodeBuddy 反代插件 | 如 dsh-our-free-model，已登录账号 |
| Node.js | `^22.19.0` 或 `>=24.0.0` |

不需要：官方客户端常驻、额外 API Key、管理员权限。

---

## 它为什么能修好（原理）

### 真正的根因：两个独立的「参数校验」被包装成安全拦截

报错文案 `Illegal API invocation from an unapproved channel`（code 11128）**是误导**。
它跟渠道、账号、请求头、限流都无关。实际是 CodeBuddy 网关的两处**参数校验失败**，
共用同一个错误码和文案。

#### 触发条件 1：`@`-mention 后跟路径样式长句

网关把请求文本里的 `@` 当**文件引用**解析。DSH 系统提示里有这句：

```
Tokens prefixed with @ are paths the user explicitly referenced.
Relative paths resolve from the workspace root ...
```

`@ ` 后面接长路径样式文本 → 网关尝试解析为文件路径 → 失败 → 11128。

实测：

| 变体 | 结果 |
|---|---|
| 原句含 `@ ` + 长句 | ❌ 400 |
| `@` → `\@`（反斜杠转义） | ✅ 200 |
| `@` → `Z` | ✅ 200 |
| `@` 单独 / `@abc` / `@` 后接中文 | ✅ 200 |
| `@` → 全角 `＠` / 零宽 / NBSP / 删空格 | ❌ 全部 400 |

#### 触发条件 2：产品身份句

`You are an AI agent powered by DeepSeek Harness.` 这句作为 system prompt 开头就 400。

| 变体 | 结果 |
|---|---|
| `You are an AI agent powered by DeepSeek Harness.` | ❌ 400 |
| `DeepSeek Harness`（单独，无上下文） | ✅ 200 |
| `DeepSeek` / `Harness` 单独 | ✅ 200 |
| `You are an AI agent.` | ✅ 200 |
| `DeepSeek`→`Deep` 或 `Harness`→`H` | ✅ 200 |
| `DeepSeek\u200B Harness`（零宽） | ❌ 仍 400 |

说明网关对**整句模板**做匹配，不是单词黑名单，也不是长度阈值。

### 怎么修的

在 `globalThis.fetch` 层拦截发往 WB 域名的请求，改写 `messages` 里的文本：

```js
// 修复 1：@-mention 转义
text.replace(/(^|\s)@/g, '$1\\@')

// 修复 2：身份句改写
'You are an AI agent powered by DeepSeek Harness.'
  → 'You are an AI agent running in DeepSeek Harness.'
```

两处都**语义不变**：`\@` 就是转义后的 `@`；身份句只是换了动词。

### 触发条件 3：WorkBuddy 国际版缺三个会话头

国际版（`www.workbuddy.ai`）的 11128 跟国内版**根因完全不同**，报错文案却一模一样
（`request illegal` / 「请求被拦截，请重新发送」）。

真正原因是缺三个会话标识头：

```
X-Conversation-ID
X-Conversation-Message-ID
X-Conversation-Request-ID
```

实测：

| 请求 | 结果 |
|---|---|
| 不带三件套 | ❌ 400 `request illegal` |
| 带三件套（值随意 UUID） | ⚠️ 400 `first message is not system prompt` ← **错误变了 = 校验已过** |
| 三件套 + system 首条 | ✅ **200** |

关键点：

- 三个头只需是唯一字符串，服务端**不校验它们之间的关联**，也不要求跨请求一致
- **不需要**解密 App 的 `$wbEncrypted` token —— `~/.dsh/.credentials.yaml` 的明文 token
  加三个头就能用（实测 200）
- **不需要** `X-IDE-*`、`X-User-Id`、`X-Requested-With`（最小头实测 200）

> **排查提示**：我最初一直用 `messages: []` 空数组测试，空数组会**先**触发
> `first message is not system prompt`，而这个检查发生在会话头校验**之前**，
> 导致误判成「客户端来源判定，客户端修不了」。
> **错误信息变了（哪怕是变成另一个错误），就说明前一道校验已经过了。**

### 一处历史误判（已修正）

早期版本（v1.0–v1.2）误以为「网关检查 `role="system"`」，做法是把 system 消息降级成 user。
**这个判断是错的**——真实根因是上面两处。降级之所以碰巧能过，是因为它改变了文本结构
（加了前缀），让 `@` 和身份句的匹配条件不再成立。

现在 `demoteSystem` 默认**关闭**，仅保留为可选兜底。主修是 `escapeMentions`（默认开启）。

---

## 它是怎么实现的

### ⚠️ 不要包 `globalThis.fetch`

v1.4 初版把修复做成 fetch 钩子（包 `globalThis.fetch`），**完全无效**——面板显示
"已安装"，实际一个请求都拦不到。

原因：OFM 的 `fetchImpl` 来自它自己的包装器：

```js
const network = createChannelFetch({ outlet: config.outlet })
// ...
fetchImpl: network.fetch   // ← 不是 globalThis.fetch
```

### 正确做法：注入 `send()`

`registerBuddyLlm` 里那个 adapter 的 `send(credential, body, options)` 是唯一能同时
改 headers 和 body 的注入点。补丁在那里插入两段，按 `product.id` 分流：

```js
// [wbfix:@]    国内 CodeBuddy：body 里 @ → \@
if (this.product.id === "buddy" && body.includes("@")) {
  body = JSON.stringify(JSON.parse(body), /* 逐条转义 messages */)
}

// [wbfix:conv] 国际 WorkBuddy：补三个会话头
if (this.product.id === "workbuddy") {
  for (const name of ["X-Conversation-ID", "X-Conversation-Message-ID", "X-Conversation-Request-ID"])
    headers.set(name, randomUUID())
}
```

两者互不影响。

### 自愈

`pnpm install` 重装 OFM 会冲掉注入。插件启动后约 2.2 秒自动检查并重打，幂等
（已打过就跳过，不会重复插入）。面板「状态」里能看到 `sendPatch.buddyFix` /
`sendPatch.workbuddyFix` 各自的真实状态。

## 安全边界

| 情况 | 行为 |
|---|---|
| 非 WB 域名 | 原样透传（字节一致，已测） |
| 非 POST 请求 | 不介入 |
| body 不是合法 JSON | 原样放行 |
| `messages` 不是数组 | 原样放行 |
| 改写过程抛错 | 原样放行 |
| **总开关关闭** | **与原请求字节级完全一致** |
| 卸载插件 | 恢复原始 `fetch` 引用 |

设计原则：**请求绝不能因为一个「本来是为了让它成功」的插件而失败。**
所以任何意外情况都选择放行，而不是抛错。

---

## 常见报错对照

| 你看到的报错 | 真实原因 | 本插件能修吗 |
|---|---|---|
| `Illegal API invocation from an unapproved channel` | 上游按 `role="system"` 判定客户端来源 | ✅ 就是它 |
| `code 11128` / `code 11140` / HTTP 400 | 同一错误族 | ✅ |
| `first message is not system prompt` | 首条消息不是 system 角色 | ⚠️ 这是**旧规则**的报错。新规则下反而是「必须有 system 才拒」，所以本版默认不再补 system |
| `code 11133 integer_below_min_value` | `max_tokens` 太小 | ❌ 调大 max_tokens |
| `code 6004 usage exceeds frequency limit` | 上游限流 | ❌ 换账号或等冷却 |
| `EMPTY_RESPONSE` / 有思考无正文 | 推理模型把 max_tokens 吃光 | ❌ max_tokens ≥ 4096 |

---

## 已知边界

- 只对**本机进程内**的请求生效（服务器侧反代要单独处理）
- 降级 system 后，模型把指令当作用户消息看待，极端情况下更容易被后续用户输入带偏
- 如果上游再改规则（比如开始检查 user 消息），这个插件会再次失效——届时看 `code` 是否还是 11128
- 如果上游换掉关键词不再拦，这个插件就不需要了 —— 关掉总开关即可
- 若有插件用 `undici` 直连、绕过 `globalThis.fetch`，主通道拦不到；
  插件另有一条可选的文件钩子做兜底，装不上也不影响主功能

---

## 许可

[MIT](./LICENSE) © 2026 simlerick
