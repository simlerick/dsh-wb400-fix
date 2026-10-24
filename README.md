# dsh-wb400-fix

**一个 DeepSeek​ Harness 插件：修好 WorkBuddy / CodeBuddy 的「请求被拦截」400 错误。**

[中文](README.md) · [English](README.en.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![DSH](https://img.shields.io/badge/DeepSeek%E2%80%8B%20Harness-plugin-5B8DEF)](https://github.com/simlerick/dsh-wb400-fix)

---

## 一句话说明

在 DeepSeek​ Harness 里用 WorkBuddy / CodeBuddy 的免费模型时，会时不时报这个错：

```
Illegal API invocation from an unapproved channel
HTTP 400 · code 11128
```

**这个插件让它不再发生**，而且不改变你请求的任何语义 —— 装好、打开开关就行。

---

## 它修的是什么

报错文案说「未获批准的渠道」，听起来像渠道/账号/网络问题，
**但它跟渠道一点关系都没有**。

真正的原因：**上游在对 system prompt 做关键词内容风控**。
只要你发的 system prompt 里出现 `DeepSeek Harness` 这个词组，请求就被拒。

而 DeepSeek​ Harness 每次请求都会自动带上这句话，所以只要你在 DSH 里用 WB 的模型，
就必然会踩到 —— 这不是偶发故障，是稳定复现。

### 怎么确认的

用同一个 token 发两次请求，**只改 system prompt 里的一个词**：

| system prompt | 结果 |
|---|---|
| `You are an AI agent powered by DeepSeek Harness.` | ❌ 400 / 11128 |
| `You are an AI agent.` | ✅ 200 |

换账号、换域名、换客户端身份、补齐 13 个请求头、调 `reasoning_effort`、
调 `max_tokens`、减少工具数量、换网络、降并发 —— 全部排除过，都不是原因。

> 💡 为什么它看起来「时好时坏」：关键词要配合**请求体够大**（约 >1KB）才稳定触发。
> 短 prompt 即使带关键词也会被放过，这是最容易误判成偶发故障的地方。

---

## 怎么修的：插入一个不可见的字符

在 `DeepSeek` 和 `Harness` 之间插一个零宽空格 `U+200B`：

```js
// 改写前
"You are an AI agent powered by DeepSeek Harness."
// 改写后（肉眼完全一样，\u200B 不可见）
"You are an AI agent powered by DeepSeek\u200B Harness."
```

为什么这样能修：

- 上游做的是**子串匹配**，中间多一个字符就不再命中
- 模型看到的内容**语义完全不变**（零宽空格本来就不参与token语义）
- **无损**：没有删减、没有改写、没有丢上下文

实测（真实请求形状：316 tools + `effort=max` + `max_tokens=128000`）：

```
原始 prompt   → 0/5 全部失败
插入零宽后    → 5/5 全部成功
```

### 一个必须处理的细节：文件路径不能碰

本地路径里也含这个词组：

```
D:\10_COD\DeepSeek Harness\resources\app.asar\dsh\
```

如果往路径里插零宽字符，模型会把坏路径传给工具调用，直接失败。
所以匹配器带前后负向断言，**主动跳过路径语境**：

```js
/(?<![\\/])(DeepSeek)[ \u00A0]+(Harness)(?![\\/])/gi
```

---

## 怎么做到的：拦截请求，不改任何文件

插件包住 `globalThis.fetch`，在请求真正发出去之前改写 body：

```
POST https://copilot.tencent.com/v2/chat/completions
        ↓
   是 WB 域名吗？ ──否──→ 原样发出（零开销）
        ↓ 是
   是 POST + JSON 吗？ ──否──→ 原样发出
        ↓ 是
   改写 messages 里的 system prompt
        ↓
   重新序列化 → 发出
```

**关键设计：不修改任何第三方文件。**
所以别人升级插件、换插件、换 profile 都不会让你失效。

### 安全边界

| 情况 | 行为 |
|---|---|
| 非 WorkBuddy/CodeBuddy 域名 | 原样透传（body 字节一致，已测） |
| 非 POST 请求 | 不介入 |
| body 不是合法 JSON | 原样放行 |
| `messages` 不是数组 | 原样放行 |
| 改写过程抛错 | 原样放行 |
| **总开关关闭** | **与原请求字节级完全一致** |
| 卸载插件 | 恢复原始 `fetch` 引用 |

只命中这 4 个域名的 `chat/completions`：
`copilot.tencent.com` · `workbuddy.ai` · `codebuddy.ai` · `codebuddy.cn`

---

## 安装

```bash
git clone https://github.com/simlerick/dsh-wb400-fix.git
```

然后让 DSH 把这个目录装成插件：

> 把 `/path/to/dsh-wb400-fix` 装成插件

装完**重启一次 DSH**，设置页里会出现 **wb400修复**。

### 手动安装（link 方式）

在 `~/.dsh/profiles/<profile>/package.json` 里：

```json
{
  "dsh": { "profile": { "bundles": [ "...", "dsh-wb400-fix" ] } },
  "dependencies": { "dsh-wb400-fix": "link:/path/to/dsh-wb400-fix" }
}
```

然后在该目录执行 `pnpm install`。

---

## 使用

打开 **设置 → wb400修复**：

| 开关 | 默认 | 作用 |
|---|---|---|
| 总开关 | 开 | 关掉即完全恢复原始请求 |
| 中和身份关键词 | 开 | 即上面的零宽空格替换 |
| 补首条 system | 开 | 首条不是 system 时补一条（11128 的另一个成因） |
| 隐藏品牌词 | 关 | 更激进：连 `DeepSeek` 也打散 |

面板还会显示：已中和多少处、改写前后对照预览、当前状态。

**改完即时生效，不需要重启。**

---

## 前置条件

| 项 | 要求 |
|---|---|
| DeepSeek​ Harness 桌面版 | 已在用 |
| 任一 WorkBuddy/CodeBuddy 反代插件 | 如 dsh-our-free-model，已登录账号 |
| Node.js | `^22.19.0` 或 `>=24.0.0` |

不需要：官方客户端常驻、额外 API Key、管理员权限。

---

## 常见报错对照

| 你看到的报错 | 真实原因 | 本插件能修吗 |
|---|---|---|
| `Illegal API invocation from an unapproved channel` | 上游按关键词风控 system prompt | ✅ 就是它 |
| `code 11128` / `code 11140` / HTTP 400 | 同一错误族 | ✅ |
| `first message is not system prompt` | 首条消息不是 system 角色 | ✅（「补首条 system」开关） |
| `code 11133 integer_below_min_value` | `max_tokens` 太小 | ❌ 调大 max_tokens |
| `code 6004 usage exceeds frequency limit` | 上游限流 | ❌ 换账号或等冷却 |
| `EMPTY_RESPONSE` / 有思考无正文 | 推理模型把 max_tokens 吃光 | ❌ max_tokens ≥ 4096 |

---

## 已知边界

- 只对**本机进程内**的请求生效（服务器侧反代要单独处理）
- 如果上游换掉关键词不再拦，这个插件就不需要了 —— 关掉总开关即可
- 若有插件用 `undici` 直连、绕过 `globalThis.fetch`，主通道拦不到；
  插件另有一条可选的文件钩子做兜底，装不上也不影响主功能

---

## 许可

[MIT](./LICENSE) © 2026 simlerick
