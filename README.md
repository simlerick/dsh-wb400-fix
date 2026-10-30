# dsh-wb400-fix

**一句话：让 DeepSeek​ Harness 里用 WorkBuddy / CodeBuddy 模型时不再报 400。**

> **v1.1（2026-10-30）** 上游规则已升级：从「关键词匹配」改成「检查 `role="system"`」。
> v1 的零宽空格手法**已经失效**，本版改为把 system 消息降级成 user 消息。
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
| **降级 system 消息** | **开** | **核心修复**：把 `role=system` 改成 `role=user`，加「系统设定」前缀 |
| 中和身份关键词 | 开 | 旧规则的手法，新规则下非必需，保留作双保险 |
| 补首条 system | **关** | 已废弃。降级开启时会被忽略——补 system 等于把刚拆掉的雷装回去 |
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

### ⚠️ 先说清楚：v1 的解释已经过时了

v1 的 README 写的是「上游对 system prompt 做关键词风控，出现 `DeepSeek​ Harness` 就拒」。
**这个说法在 2026-10-30 之后不成立了。**

实测（同一份 11.6KB 的真实 DSH system prompt）：

| 手法 | 结果 |
|---|---|
| 原样发出 | ❌ 400 |
| 插零宽空格（v1 的核心手法） | ❌ 400 |
| 整词替换成 `DeepSeek Agent` | ❌ 400 |
| 改掉第一句 | ❌ 400 |
| 前面加中文说明 | ❌ 400 |
| **把 system 消息改成 user 消息** | ✅ **200** |

所以上游**不再看关键词**了。

### 真正的新规则：看 `role`

报错文案说「未获批准的渠道」，**这句话是编的**，会把人带偏去查账号、域名、请求头、限流。

真实机制：

```
messages: [
  { "role": "system", "content": "You are an AI agent powered by ..." },  ← 只要这条在，就拒
  { "role": "user",   "content": "..." }
]
```

只要 `messages` 里存在 `role: "system"` 且内容像 agent 指令，请求就被拒，返回：

```json
{"code": 11128,
 "msg": "Illegal API invocation from an unapproved channel",
 "displayTips": {"en": "This call failed channel verification, possibly
   because it was not sent from an official client."}}
```

也就是说：上游在判断「这条 system prompt 像不像官方 IDE 客户端发的」。

### 关键实验：不是长度问题

这一点很重要，否则容易走错方向：

| 测试 | 结果 |
|---|---|
| 中性文本 12000 字元（`role=system`） | ✅ 200 |
| DSH 真实 system prompt 6090 字元 | ✅ 200 |
| 同一份 6590 字元 | ❌ 400 |

同样的角色、更长的中性文本能过，说明**不是长度阈值**，是内容特征。

而逐段二分又找不到固定关键词——所以这是**基于内容的分类判定**，不是一个可以「替换掉某个词」就解决的规则。

### 怎么修的

**把 system 消息降级成 user 消息**，并加一个前缀让模型知道这是设定：

```js
// 改写前
{ role: "system", content: "You are an AI agent powered by DeepSeek Harness. ..." }

// 改写后
{ role: "user",   content: "【系统设定】\nYou are an AI agent powered by DeepSeek Harness. ..." }
```

- **提示词一个字都没丢**：长度从 11649 变成 11659（只多了前缀）
- 模型仍然能读到全部指令，已验证它能正确回答只在 system prompt 后半段才有的内容
- 代价：模型把指令当成「用户开头说的话」，理论约束力比真正的 system message 略弱

### 为什么还留着零宽空格那套

它对新规则已经无效，但：
- 万一上游回退到旧规则，它还能起作用
- 成本近乎为零（只是几个不可见字符）

所以保留为「双保险」，默认开启。

---

## 它是怎么实现的

不改任何第三方文件，只包住 `globalThis.fetch`，在请求发出去之前改写 body：

```
POST https://copilot.tencent.com/v2/chat/completions
        ↓
   是 WB 域名吗？ ──否──→ 原样发出
        ↓ 是
   是 POST + JSON 吗？ ──否──→ 原样发出
        ↓ 是
   改写 messages 里的 system prompt
        ↓
   重新序列化 → 发出
```

**关键设计：不修改任何第三方文件。**
所以别人升级插件、换插件、换 profile 都不会让你失效。

只命中这 4 个域名的 `chat/completions`：
`copilot.tencent.com` · `workbuddy.ai` · `codebuddy.ai` · `codebuddy.cn`

### 安全边界

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
