# dsh-wb400-fix

**One line: stops the 400 error you get when using WorkBuddy / CodeBuddy models inside DeepSeek​ Harness.**

> **v1.1 (2026-10-30)** The upstream rule changed: it no longer matches keywords — it now
> rejects any `role="system"` message. The v1 zero-width trick **no longer works**.
> This version demotes the system message into a user message instead.
> See [Why it works](#why-it-works).

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
| **Demote system message** | **on** | **Core fix**: rewrites `role=system` into `role=user` with a prefix |
| Neutralise identity keyword | on | The old-rule trick; not required now, kept as a second line of defence |
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

### The v1 explanation is obsolete

v1 claimed "the upstream filters the system prompt by keyword — `DeepSeek​ Harness` gets rejected".
**That stopped being true on 2026-10-30.**

Measured against the same real 11.6 KB DSH system prompt:

| Attempt | Result |
|---|---|
| Send as-is | ❌ 400 |
| Insert zero-width space (the v1 fix) | ❌ 400 |
| Replace the phrase with `DeepSeek Agent` | ❌ 400 |
| Rewrite the first sentence | ❌ 400 |
| Prepend a paragraph | ❌ 400 |
| **Change the message role from system to user** | ✅ **200** |

So the upstream no longer looks at keywords at all.

### The new rule: it looks at `role`

The error text blames "an unapproved channel", but **that wording is misleading** — it sends you
chasing accounts, domains, headers and rate limits.

What actually happens: if `messages` contains a `role: "system"` entry whose content looks like
agent instructions, the request is rejected with

```json
{"code": 11128,
 "msg": "Illegal API invocation from an unapproved channel",
 "displayTips": {"en": "This call failed channel verification, possibly
   because it was not sent from an official client."}}
```

### Not a length limit — this matters

| Test | Result |
|---|---|
| 12,000 chars of neutral text as `role=system` | ✅ 200 |
| Real DSH system prompt, first 6,090 chars | ✅ 200 |
| Same prompt, first 6,590 chars | ❌ 400 |

A much longer neutral prompt passes, so there is no length threshold. And a segment-by-segment
bisect finds no fixed keyword either — this is a **content-based classification**, not something
you can fix by replacing one word.

### The fix

**Demote the system message to a user message**, with a marker prefix:

```js
// before
{ role: "system", content: "You are an AI agent powered by DeepSeek Harness. ..." }

// after
{ role: "user",   content: "【系统设定】\nYou are an AI agent powered by DeepSeek Harness. ..." }
```

- **Nothing is lost from the prompt**: 11,649 → 11,659 chars (only the prefix was added)
- Verified that the model still reads instructions living in the *second half* of the original system prompt
- Trade-off: the model treats the instructions as "something the user said up front", which is
  slightly weaker than a true system message

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
