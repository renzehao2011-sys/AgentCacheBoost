# AgentCacheBoost · DSH 适配版

对 [renzehao2011-sys/AgentCacheBoost](https://github.com/renzehao2011-sys/AgentCacheBoost) 的评估与改写。原仓库是给 **Operit（Android AI Agent）** 写的：两个 Skill + 两个脚本。

## 有用吗

**方法论有用，脚本原样跑不了。**

| 部分 | 结论 |
|---|---|
| 前缀卫生那几条（时间戳/UUID 不进静态前缀、`user_id` 不填随机值、采样参数救不了命中率） | 对 DSH 完全成立，直接沿用 |
| "首条请求必然 0% 命中"、"整体命中低多是短会话占比" | 成立，而且 DSH 日志里能实测验证 |
| `conversation_handoff/SKILL.md` 的阈值与模板 | 阈值需按 DSH 重新标定，模板可留 |
| `android_ui_automation/SKILL.md` 的方法（先裁剪再决策） | 成立，但工具名与流程要换成 `mcp__phone__*` |
| `context_gauge.py` | **不能用**：它解析 Operit 的 `room_db` 备份（`messages.cachedInputTokens`、`token_usage_records`）。DSH 没有这个库 |
| `ui_prune.py` | 能用，且有个小 bug（见下） |

它自己还顺手证伪了网上那段"开启 DeepSeek 上下文缓存"的脚本——这点也是对的，缓存默认开启。

## 改了什么

| 改动 | 说明 |
|---|---|
| `context_gauge.py` → `context_gauge.mjs` | 换数据源：读 `$DSH_HOME/sessions/**/session.v4.jsonl.zstd`（多帧 zstd，Node 内置 zlib 解，零依赖）。从每步 `usage` 取 `inputTokens` / `cacheReadTokens` / `outputTokens`，所以**窗口和命中率是实测值**，不是 Operit 那种"窗口读不到"。 |
| 阈值按 DSH 重新标定 | 原版"`think` 占正文 ≥18%/≥30%"在 DSH 里几乎永久触发（实测单会话思考 21K 字符、正文只有 607 字符，占比 97% 但完全正常）。改成**思考累计字符 + 前后半程膨胀倍数**，本机实测 20K 字符 / 1.0x，不误报。 |
| 新增可读信号 | 当前窗口、峰值窗口、常规命中率、首条命中率（单独标出"必然是 0%"）、工具输出累计 KB。 |
| `ui_prune.py` 修 bug | 原来标记用属性首字母，`checkable` 和 `clickable` 都是 `C`（实测输出 `C,C`）。改成映射表：C 可点 / L 长按 / S 可滚 / K 可勾选 / E 选中。 |
| 两个 SKILL.md 重写 | 换成 dsh-go 实际工具（`mcp__phone__screen` / `collect` / `tap` / `intent` / `handoff`、`uiautomator dump` 只在需要原始树时用），交接落盘路径改到工作区 `handoff/`。 |

## 用法

```bash
# 全量体检
node skills/dsh_context_handoff/scripts/context_gauge.mjs

# 单会话 / 最近会话 / JSON
node skills/dsh_context_handoff/scripts/context_gauge.mjs --chat 插件
node skills/dsh_context_handoff/scripts/context_gauge.mjs --current
node skills/dsh_context_handoff/scripts/context_gauge.mjs --json

# UI dump 裁剪
python3 skills/dsh_ui_anchors/scripts/ui_prune.py /sdcard/ui_dump.xml
```

装成 DSH 技能（本机已装）：

```bash
cp -r skills/dsh_context_handoff skills/dsh_ui_anchors ~/.dsh/skills/
```

之后新会话的可用技能列表里会出现 `dsh_context_handoff` 与 `dsh_ui_anchors`。

## 本机实测输出

```
判定          窗口    峰值    消息  思考    膨胀   命中    标题
留意          69K     69K     9     21K     1.0x   94.4%   下载并运行 dsh-purge 插件
```

- 首条命中 0.0%（新会话必然，不是故障）
- 常规命中 94.4%
- 末条窗口 69K tok

## 已知限制

- 窗口是"该步发出的 prompt token"，不是客户端的 `currentWindowSize`；两者同量级但不完全相等。
- 会话日志按帧追加；脚本尽量还原多帧，极端情况下最后一条可能缺失（`badLines` 会显示）。
- 缓存命中率是整会话累计，别拿单步判断好坏。
- `ui_prune.py` 仍需要 `android_shell` 能跑 `uiautomator dump`；用 MCP 的 `screen`/`collect` 就不需要它。

## 许可

沿用原仓库 MIT。
