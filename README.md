# dsh-wb400-fix

**一句话：让 DeepSeek​ Harness 里用 WorkBuddy / CodeBuddy 模型时不再报 400。**

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
| 中和身份关键词 | 开 | 核心功能，保持开启即可 |
| 补首条 system | 开 | 首条不是 system 时补一条（11128 的另一个成因） |
| 隐藏品牌词 | 关 | 更激进：连 `DeepSeek` 也打散 |

面板还会显示：已中和多少处、改写前后对照预览。

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

报错文案说「未获批准的渠道」，**这个说法是错的**，会把人带偏去查账号、域名、请求头、限流。

真正原因是：**上游在对 system prompt 做关键词内容风控**。
只要 system prompt 里出现 `DeepSeek​ Harness` 这个词组，请求就被拒。

而 DSH 每次请求都会自动带上这句话 —— 所以这不是偶发故障，是必然触发。

### 怎么修的

在 `DeepSeek` 和 `Harness` 之间插一个零宽空格 `U+200B`：

```js
// 改写前
"You are an AI agent powered by DeepSeek​ Harness."
// 改写后（肉眼完全一样，\u200B 不可见）
"You are an AI agent powered by DeepSeek\u200B Harness."
```

- 上游做的是**子串匹配**，中间多一个字符就不再命中
- 模型看到的**语义完全不变**
- **无损**：没有删减、没有改写、没有丢上下文

实测（真实请求形状：316 tools + `effort=max` + `max_tokens=128000`）：

```
原始 prompt   → 0/5 全部失败
插入零宽后    → 5/5 全部成功
```

### 一个容易踩的细节

本地路径里也含这个词组：

```
D:\10_COD\DeepSeek Harness\resources\app.asar\dsh\
```

往路径里插零宽字符会让模型拿到坏路径、工具调用失败。
所以匹配器带前后负向断言，**主动跳过路径语境**：

```js
/(?<![\\/])(DeepSeek)[ \u00A0]+(Harness)(?![\\/])/gi
```

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
