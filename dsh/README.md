# DSH / dsh-go edition

**English** · [简体中文](README.zh-CN.md)

The Operit playbook in the repository root, ported to **DeepSeek Harness (DSH)** and the **dsh-go** phone app. The Operit content stays as it was; the two editions do not interfere.

## How it differs from the Operit edition

| | Operit | DSH |
|---|---|---|
| Data source | `room_db` backup | `$DSH_HOME/sessions/<slug>/session-<id>/session.v4.jsonl.zstd` |
| Reader | Python parsing a sqlite backup | Node stdlib `zlib`, multi-frame zstd, zero dependencies |
| What you can measure | message count, hit rate, tool ratio | **per-step prompt tokens, window, peak, per-step hit rate, thinking growth** |
| Window | `currentWindowSize` is unreadable | `inputTokens + cacheReadTokens`, measured |
| Thinking metric | ≥18 % / ≥30 % of message text | total chars ≥50K / ≥120K plus second-half vs first-half growth |
| UI control | Operit tools + `detail=full` | `mcp__phone__*` (`screen` / `collect` / `tap` / `intent`) + `uiautomator dump` when a raw tree is needed |

Why the thinking metric had to change: "thinking as a share of message text" fires almost permanently on DSH. A healthy session measured **50K characters of thinking** against a few hundred characters of visible text — 99 % and completely normal. What actually matters is how much thinking accumulates and how much the second half grew over the first.

## Contents

| Path | What it does |
|---|---|
| `skills/dsh_context_handoff/SKILL.md` | Hand-off decision: thresholds, 7-section lossless template, self-filtering, checklist |
| `skills/dsh_context_handoff/scripts/context_gauge.mjs` | Gauge: window / hit rate / thinking growth / hand-off verdict |
| `skills/dsh_ui_anchors/SKILL.md` | Phone UI anchor rules: prune before reasoning, use element ids instead of coordinates |
| `skills/dsh_ui_anchors/scripts/ui_prune.py` | UI dump XML → anchor list (`C` clickable / `L` long-press / `S` scrollable / `K` checkable / `E` selected) |
| `dsh-go-plugin/local-cache-gauge/` | Native dsh-go plugin: status strip + turn notes + gauge panel |

## Install

```bash
# Skills
cp -r skills/dsh_context_handoff skills/dsh_ui_anchors "${DSH_HOME:-$HOME/.dsh}/skills/"

# Plugin
P="${DSH_HOME:-$HOME/.dsh}/dsh-go/plugins/local-cache-gauge"
mkdir -p "$P" && cp -r dsh-go-plugin/local-cache-gauge/* "$P"/
node "${DSH_HOME:-$HOME/.dsh}/skills/dsh-go-plugin/kit/bin/check.mjs" "$P" --load
dsh plugin --profile web add "$P"
```

The on-device engine uses the `web` profile. What gets installed is a link to that directory — **do not delete the directory**. Restart the engine once (App → Engine) afterwards: plugin code is read at load time.

Uninstall:

```bash
dsh plugin --profile web remove local-cache-gauge
rm -rf "$P"
```

## Usage

```bash
node skills/dsh_context_handoff/scripts/context_gauge.mjs             # all sessions
node skills/dsh_context_handoff/scripts/context_gauge.mjs --chat x    # one session
node skills/dsh_context_handoff/scripts/context_gauge.mjs --current   # most recent
node skills/dsh_context_handoff/scripts/context_gauge.mjs --json

python3 skills/dsh_ui_anchors/scripts/ui_prune.py /sdcard/ui_dump.xml
```

Output:

```
verdict        window  peak   msgs  think  growth  hit     title
hand off now   110K    110K   17    50K    1.1x    97.3%   download and run a plugin
```

- **window** = that step's `inputTokens + cacheReadTokens` (`inputTokens` excludes the cached part)
- **hit** = Σ`cacheReadTokens` / Σ(`inputTokens` + `cacheReadTokens`), **skipping the first request** (which is always 0 %)
- **growth** = average thinking chars in the second half / first half

## What the plugin shows

| Where | What |
|---|---|
| Status strip above the composer | `Hit 97.3% · 110K`; tap to open the panel |
| Turn note | That turn's own hit rate and window |
| Panel "Cache gauge" | Warm hit, current window, peak, first-request hit, steps, total thinking, tool output, per-step hit curve; copy / refresh |

It only reads the session log. No writes, no modification, no uploads.

## Limitations

- The window is the prompt tokens actually sent on that step, same order of magnitude as the client's `currentWindowSize` but not identical.
- The session log is appended frame by frame; if the last write cannot be read, the plugin keeps the previous reading.
- `ui_prune.py` needs `android_shell` to run `uiautomator dump`; for day-to-day use `mcp__phone__screen` / `collect` makes it unnecessary.
- The plugin refreshes every 15 seconds and does nothing else in the background.
