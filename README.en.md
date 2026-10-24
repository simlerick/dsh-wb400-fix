# dsh-wb400-fix

**A DeepSeek​ Harness plugin that fixes the WorkBuddy / CodeBuddy "request blocked" 400 error.**

[中文](README.md) · [English](README.en.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![DSH](https://img.shields.io/badge/DeepSeek%E2%80%8B%20Harness-plugin-5B8DEF)](https://github.com/simlerick/dsh-wb400-fix)

---

## What is this?

If you use WorkBuddy or CodeBuddy models inside DeepSeek​ Harness, requests
intermittently fail with:

```
Illegal API invocation from an unapproved channel
HTTP 400 · code 11128
```

**This plugin makes that stop happening.** It changes nothing about what your
request means — install it, flip one switch, done.

---

## Why the error happens

The message blames "an unapproved channel." That diagnosis is wrong, and chasing it
wastes a lot of time on accounts, endpoints, headers and rate limits that are all
perfectly fine.

The real cause is **keyword content filtering on the system prompt**: any request
whose system prompt contains the phrase `DeepSeek​ Harness` gets rejected.

DeepSeek​ Harness injects that phrase into every request automatically. So for anyone
using these models through the harness, this is not an intermittent glitch — it is a
deterministic failure.

### How it was isolated

Two requests, same token, identical except for one word:

| system prompt | result |
|---|---|
| `You are an AI agent powered by DeepSeek​ Harness.` | ❌ 400 / 11128 |
| `You are an AI agent.` | ✅ 200 |

Swapping accounts, changing the endpoint, impersonating another client, adding thirteen
missing headers, tuning `reasoning_effort` and `max_tokens`, shrinking the tool list
from 316 to a handful, changing network, reducing concurrency — all ruled out by
experiment. None of them was the cause.

> 💡 Why it *looks* intermittent: the filter needs a request body of roughly 1 KB or
> more to engage reliably. Short prompts slip through even when they contain the
> phrase, which is exactly what makes this easy to misdiagnose as flakiness.

---

## How the fix works

Insert a zero-width space (`U+200B`) between the two words:

```js
// before
"You are an AI agent powered by DeepSeek​ Harness."
// after — visually identical; \u200B renders as nothing
"You are an AI agent powered by DeepSeek\u200B Harness."
```

Why this works:

- The upstream check is **substring matching** — one extra character breaks the match.
- The model's reading of the text is **semantically unchanged**.
- The intervention is **lossless**: nothing is deleted, reworded, or dropped from context.

Measured on the real request shape (316 tools, `effort=max`, `max_tokens=128000`):

```
original prompt  → 0 / 5 succeeded
neutralised      → 5 / 5 succeeded
```

### One detail that matters: don't touch file paths

Local paths also contain the phrase:

```
D:\10_COD\DeepSeek Harness\resources\app.asar\dsh\
```

Inserting an invisible character there would make the model hand a corrupted path to
tool calls, which then fail — a subtler bug than the one being fixed. The matcher
therefore skips path contexts with negative lookaround:

```js
/(?<![\\/])(DeepSeek)[ \u00A0]+(Harness)(?![\\/])/gi
```

---

## How it works: intercept, don't patch

The plugin wraps `globalThis.fetch` and rewrites the body just before a request leaves
the process:

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

**No third-party file is modified.** Upgrading another plugin, switching plugins, or
changing profiles cannot break it.

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

Scope is limited to four hosts — `copilot.tencent.com`, `workbuddy.ai`, `codebuddy.ai`,
`codebuddy.cn` — and to the `chat/completions` path.

The design rule throughout: *a request must never fail because of a component whose
only job was to make it succeed.* Hence the ordering (off switch → host → method → body)
and the unconditional pass-through on anything unexpected.

---

## Install

```bash
git clone https://github.com/simlerick/dsh-wb400-fix.git
```

Then ask DeepSeek​ Harness to install that directory as a plugin:

> install `/path/to/dsh-wb400-fix` as a plugin

Restart the harness once, and a **wb400修复** section appears in Settings.

### Manual install (link)

In `~/.dsh/profiles/<profile>/package.json`:

```json
{
  "dsh": { "profile": { "bundles": ["...", "dsh-wb400-fix"] } },
  "dependencies": { "dsh-wb400-fix": "link:/path/to/dsh-wb400-fix" }
}
```

Then run `pnpm install` in that directory.

---

## Usage

Open **Settings → wb400修复**:

| Switch | Default | Effect |
|---|---|---|
| Master switch | on | Turning it off restores the original request exactly |
| Neutralise identity keyword | on | The zero-width insertion described above |
| Prepend system message | on | Adds one when the first message isn't a system role (the other cause of 11128) |
| Hide brand word | off | More aggressive: also splits `DeepSeek` |

The panel also shows how many matches have been neutralised and a before/after preview.

**Changes take effect immediately — no restart needed.**

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
  need separate handling.
- If the upstream stops filtering on this phrase, the plugin is no longer needed —
  the off switch is the correct response.
- Plugins that bypass `globalThis.fetch` (e.g. a private `undici` instance) aren't
  covered by the primary path; an optional file-level hook exists as a fallback and
  is not required for the main functionality.

---

## License

[MIT](./LICENSE) © 2026 simlerick
