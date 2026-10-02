# Operit Cache-Hit-Rate Playbook

**English** · [简体中文](README.zh-CN.md)

> A measurement-driven guide plus two ready-to-use **Operit Skills** for prompt-cache hygiene,
> conversation hand-off, and UI-tree pruning.
>
> It answers one question honestly: **"my cache hit rate looks low — is that actually a problem?"**
> (Short answer: usually not; and here is how to tell, what really costs you, and what to do.)

**Contents:** [What this is](#what-this-is) · [Key findings](#key-findings-all-measured) · [Layout](#repository-layout) · [Install](#installation) · [Usage](#usage) · [Optional automation](#optional-scheduled-patrol-with-the-workflow-package) · [Limitations](#limitations--caveats) · [FAQ](#faq) · [Disclaimer](#disclaimer) · [License](#license)

---

## What this is

A small, dependency-free toolkit derived from a real investigation on Operit (Android AI agent):

| Item | What it does |
|---|---|
| `skills/conversation_handoff/` | Decides **when a conversation should be summarized and migrated**, with a 7-section lossless hand-off template, self-filtering rules and a verification checklist |
| `skills/android_ui_automation/` | Rules for safe UI automation: **never use `detail=full`**, prune UI trees before reasoning, plus prompt-prefix hygiene principles |
| `scripts/context_gauge.py` | Reads the Operit `room_db` **backup** and reports per-conversation window size, message count, `think` ratio, tool-call ratio and cache hit rate |
| `scripts/ui_prune.py` | Compresses a raw UI dump into an actionable anchor list (**measured: 40,501 B → 3,596 B, 91.1 %**) |

> **Note:** the `SKILL.md` files are written in Chinese, matching the platform's user base. Everything is plain text — a Skill is a *text asset*, not a program.

It also settles a myth: a widely-shared snippet claiming it "enables DeepSeek context caching" is **not needed** — DeepSeek's context caching is on by default, requires no code changes, is best-effort ("100 % hit rate is not guaranteed"), and entries expire after hours to days. That snippet additionally has a broken URL, a broken list index, and cites a "1024-token cache threshold" that does not exist in DeepSeek's API.

---

## Key findings (all measured)

1. **A brand-new conversation's first request always has a 0 % hit rate.** That is arithmetic, not a fault. Judge a hit rate by the *trend inside one conversation*, never by a single request.
2. **A low overall rate usually comes from many short sessions**, not from one misbehaving feature. Measured on one account: long conversations sat at **94–99 %**, while short/one-off sessions sat at **75–89 %**.
3. **Prefix matching starts at the beginning**, therefore:
   - any change in the static prefix invalidates **everything after it**;
   - timestamps, UUIDs and random session IDs must **never** enter the system prompt or any static asset;
   - `user_id` must **never be random** — it is used for KVCache isolation, and random values shred the cache;
   - a random UUID in a **request header** is harmless; in the **prompt text** it breaks the prefix 100 % of the time.
4. **Sampling parameters cannot fix caching.** DeepSeek defaults to `thinking.type=enabled`, where `temperature` / `top_p` have no effect, and the API exposes **no `seed`**.
5. **Auto-summarization is a recurring cost — but only worth ~4–5 %.** Measured: the first request after a summary hit **51.97 %** vs **94.05 %** for regular requests (4.1× more uncached tokens). It is real but rarely the main cause; if you keep it, prefer the token-threshold trigger over the message-count trigger.
6. **Full UI trees are a hidden token sink.** `detail=full` is ~40 KB ≈ 10k tokens for a single screen; heavy apps reach 50k–120k tokens. Prune before reasoning — that is a 91.1 % reduction.
7. **`think` blocks grow with conversation length** (observed ratios rising 0 % → 26 % → 60 %+, with single messages exceeding 100k characters). Worse: **multiple `think` blocks inside one message break client-side folding**, so raw reasoning leaks into the message body. Root cause is in the client renderer — no data-layer flag exists. → **Hand off long conversations instead of pushing through.**

---

## Repository layout

```
README.md                 # this file (English)
README.zh-CN.md           # Chinese translation
LICENSE                   # MIT
.gitignore
skills/
├── conversation_handoff/
│   ├── SKILL.md                     # hand-off policy: thresholds, template, filters
│   └── scripts/context_gauge.py     # analyzer (Python 3 stdlib only)
└── android_ui_automation/
    ├── SKILL.md                     # UI automation rules + prefix hygiene
    └── scripts/ui_prune.py          # UI dump → anchor list
```

Dependency graph:

```
room_db backup (*.zip) ──▶ context_gauge.py ◀── conversation_handoff/SKILL.md
                                                └─produces─▶ <topic>-<date>.md

UI dump XML ──▶ ui_prune.py ◀── android_ui_automation/SKILL.md
```

---

## Installation

1. Copy **both** directories under `skills/` into Operit's Skill directory:
   `/sdcard/Download/Operit/skills/`
2. Verify the layout is `skills/<skill-name>/SKILL.md` (a Skill **must** be a folder containing `SKILL.md` — lowercase `skill.md` is also accepted). Then make sure the Skill's "AI visibility" toggle is enabled in the app settings.
3. Activate it when needed by having the agent call `use_package("<skill-name>")`.

> ⚠️ **Skills never run by themselves.** Only the `name` + `description` line (~40 tokens) sits permanently in the system prompt; the body is loaded only when the model explicitly calls `use_package`. "Automatic reminders" really means "the model happened to remember at the right moment."

**Requirements**

- Operit (Android) with agent / Skill support
- Python 3 — standard library only, no `pip install`
- `room_db` backups enabled in Operit (the analyzer's only data source)

Not the default backup location?

```bash
export OPERIT_BACKUP_DIR=<your backup dir>

# or point at a specific archive
python3 context_gauge.py --zip /path/to/room_db_backup_YYYY-MM-DD.zip
```

---

## Usage

```bash
# Whole-account check: list every conversation with a hand-off verdict
python3 skills/conversation_handoff/scripts/context_gauge.py

# Diagnose a single conversation
python3 skills/conversation_handoff/scripts/context_gauge.py --chat <title keyword>

# More rows / explicit archive
python3 skills/conversation_handoff/scripts/context_gauge.py --top 30
python3 skills/conversation_handoff/scripts/context_gauge.py --zip <archive>
```

Sample output:

```
verdict            window tok  msgs  think%  tools%   hit   title
suggest handoff        90,660    71   15.3%   26.8%  93.4%  <title>
strongly recommend     63,473   204   24.4%   25.5%  94.7%  <title>
15 conversations total, 10 flagged for hand-off.
```

**Default hand-off thresholds** (edit them directly in `SKILL.md`):

| Signal | Threshold |
|---|---|
| Active window `currentWindowSize` | ≥45K suggest · ≥75K strongly recommend |
| Message count | ≥100 remind · ≥200 strongly recommend |
| `think` share of message body | ≥18 % remind · ≥30 % strongly recommend |
| Tool-call messages | ≥30 % and the task is closed |
| Cache hit rate of that conversation | <85 % means an unstable prefix |

---

## Optional: scheduled patrol with the `workflow` package

You can build a timed patrol that checks conversations and writes a marker file, but know its limits first:

- **`currentWindowSize` is exposed by no tool at all** (neither the live database interface nor the backup), so a workflow can only judge **message count** (`extended_chat:list_chats` → `messageCount`). Window-size thresholds must be checked manually in the UI.
- Workflows have **no LLM node** (only trigger / execute / condition / logic / extract), so they can only do fixed numeric comparisons — no semantic judgement.
- If you don't want notifications, have the workflow write a marker file that the agent reads at session start.

---

## Limitations & caveats

- **Skills do not auto-execute**, do not run scripts by themselves, and do not write documents by themselves — every step requires the model to act.
- The analyzer reads **backups**, so it lags behind the current conversation (it prints the snapshot time). The live database lives in the app's private storage and is not readable without root.
- Token counts are **estimates** (Chinese ≈ 0.67 token/char, English ≈ 1 token / 3.8 chars).
- Operit's platform-side auto-memory has **no invalidation mechanism** and will accumulate stale facts; clean it manually.

---

## FAQ

**My hit rate shows ~75 %. Is something broken?**
Most likely not. Check whether that number is dominated by short/new conversations. Per-conversation trends are the meaningful signal.

**Do I need Operit for this?**
Yes — `context_gauge.py` parses Operit's `room_db` schema (`messages.cachedInputTokens`, `token_usage_records`). The *methodology* transfers to other agents; the script does not.

**Does this change any of my model settings?**
No. The analyzer is read-only and the Skills are text assets with no execution capability.

**Will the Skill remind me automatically?**
No. It surfaces as one line in the available-packages list, and only an explicit `use_package` call activates it. Treat it as a checklist the model can consult, not a scheduler.

---

## Disclaimer

Unofficial community notes, **not affiliated with or endorsed by Operit**. Setting names, tool names and paths may differ between app versions. Everything here is provided as-is, without warranty.

## License

[MIT](LICENSE)
