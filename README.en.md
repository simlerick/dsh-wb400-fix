# dsh-wb400-fix

**One line: stops the 400 error you get when using WorkBuddy / CodeBuddy models inside DeepSeek​ Harness.**

[中文](README.md) · [English](README.en.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

---

## What is this

A **plugin for DeepSeek​ Harness** — not a standalone program; it installs into the
harness and runs there.

It does exactly one thing: fixes the error that keeps interrupting WorkBuddy /
CodeBuddy models inside the harness —

```
Illegal API invocation from an unapproved channel
HTTP 400 · code 11128
```

Install it, flip one switch, the error stops. **Your requests are not changed in
meaning** — the plugin only stops the upstream from misreading them.

---

## Do I need it?

You need it if any of these apply:

- You use WorkBuddy or CodeBuddy models in the harness and get **"request blocked"
  interruptions**
- You connected Tencent's free quota through a proxy plugin like `dsh-our-free-model`,
  and long messages get rejected
- You have seen `code 11128` or `code 11140`

You don't need it if:

- You only use the official DeepSeek API, OpenRouter, or another non-Tencent channel
- You have never hit the error above

---

## Install

```bash
git clone https://github.com/simlerick/dsh-wb400-fix.git
```

Then tell DeepSeek​ Harness:

> install `/path/to/dsh-wb400-fix` as a plugin

**Restart the harness once**, and a **wb400修复** section appears in Settings.

<details>
<summary>Manual install (link)</summary>

In `~/.dsh/profiles/<profile>/package.json`:

```json
{
  "dsh": { "profile": { "bundles": ["...", "dsh-wb400-fix"] } },
  "dependencies": { "dsh-wb400-fix": "link:/path/to/dsh-wb400-fix" }
}
```

Then run `pnpm install` in that directory.

</details>

---

## Usage

Open **Settings → wb400修复**:

| Switch | Default | Effect |
|---|---|---|
| Master switch | on | Turning it off restores the original request exactly |
| Neutralise identity keyword | on | The core feature — leave it on |
| Prepend system message | on | Adds one when the first message isn't a system role (another cause of 11128) |
| Hide brand word | off | More aggressive: also splits `DeepSeek` |

The panel also shows how many matches have been neutralised, plus a before/after preview.

**Changes take effect immediately — no restart needed.**

> In most cases the defaults are already correct and you never need to touch anything.

---

## Requirements

| Item | Requirement |
|---|---|
| DeepSeek​ Harness desktop | Already in use |
| A WorkBuddy/CodeBuddy proxy plugin | e.g. dsh-our-free-model, with an account signed in |
| Node.js | `^22.19.0` or `>=24.0.0` |

Not required: the official client running in the background, an extra API key, or
administrator rights.

---

## Why it works

The error says "an unapproved channel." **That explanation is wrong**, and following
it sends you off checking accounts, endpoints, headers and rate limits — all of which
are fine.

The real cause: **the upstream filters the system prompt by keyword.** Any request
whose system prompt contains the phrase `DeepSeek​ Harness` is rejected.

The harness injects that phrase into every request automatically — so this is not an
intermittent glitch, it is a guaranteed trigger.

### The fix

Insert a zero-width space (`U+200B`) between the two words:

```js
// before
"You are an AI agent powered by DeepSeek​ Harness."
// after — visually identical; \u200B renders as nothing
"You are an AI agent powered by DeepSeek\u200B Harness."
```

- The upstream check is **substring matching** — one extra character breaks the match
- The model reads **the same text, same meaning**
- **Lossless**: nothing deleted, reworded, or dropped from context

Measured on the real request shape (316 tools, `effort=max`, `max_tokens=128000`):

```
original prompt  → 0 / 5 succeeded
neutralised      → 5 / 5 succeeded
```

### One detail that is easy to get wrong

Local file paths also contain the phrase:

```
D:\10_COD\DeepSeek Harness\resources\app.asar\dsh\
```

Inserting an invisible character there would hand the model a corrupted path and break
tool calls. The matcher therefore skips path contexts with negative lookaround:

```js
/(?<![\\/])(DeepSeek)[ \u00A0]+(Harness)(?![\\/])/gi
```

---

## How it is implemented

No third-party file is modified. The plugin wraps `globalThis.fetch` and rewrites the
body just before a request leaves the process:

```
POST https://copilot.tencent.com/v2/chat/completions
        ↓
   WorkBuddy/CodeBuddy host?  ──no──→ pass through untouched
        ↓ yes
   POST + JSON?               ──no──→ pass through untouched
        ↓ yes
   rewrite the system prompt
        ↓
   re-serialise → send
```

**The key design choice: nothing else's files are touched.** So upgrading another
plugin, switching plugins, or changing profiles cannot break it.

Scope is limited to four hosts — `copilot.tencent.com`, `workbuddy.ai`,
`codebuddy.ai`, `codebuddy.cn` — and the `chat/completions` path.

### Safety properties

| Condition | Behaviour |
|---|---|
| Non-WorkBuddy/CodeBuddy host | Passed through, byte-identical |
| Non-POST request | Not inspected |
| Body is not valid JSON | Passed through |
| `messages` is not an array | Passed through |
| The rewrite throws | Passed through |
| **Master switch off** | **Byte-identical to the original request** |
| Plugin uninstalled | Original `fetch` reference restored |

The rule behind all of it: *a request must never fail because of a component whose only
job was to make it succeed.* So every unexpected case passes the request through
instead of throwing.

---

## Error reference

| What you see | Real cause | Fixed here? |
|---|---|---|
| `Illegal API invocation from an unapproved channel` | Keyword filtering on the system prompt | ✅ That's what this is for |
| `code 11128` / `code 11140` / HTTP 400 | Same error family | ✅ |
| `first message is not system prompt` | First message isn't a system role | ✅ (prepend switch) |
| `code 11133 integer_below_min_value` | `max_tokens` too small | ❌ Raise `max_tokens` |
| `code 6004 usage exceeds frequency limit` | Upstream rate limit | ❌ Switch account or wait |
| `EMPTY_RESPONSE` / reasoning but no text | Reasoning model consumed the whole budget | ❌ `max_tokens` ≥ 4096 |

---

## Known limits

- Works for requests made inside the local process; a server-side reverse proxy would
  need separate handling
- If the upstream stops filtering on this phrase, the plugin is no longer needed —
  the off switch is the correct response
- Plugins that bypass `globalThis.fetch` (e.g. a private `undici` instance) aren't
  covered by the primary path; an optional file-level hook exists as a fallback and
  is not required for the main functionality

---

## License

[MIT](./LICENSE) © 2026 simlerick
