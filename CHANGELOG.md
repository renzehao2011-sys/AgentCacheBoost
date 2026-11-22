# 变更记录

## v0.2.0 — DSH 适配版

新增 `dsh/` 目录，把仓库从 Operit 专用扩到 **DSH（DeepSeek Harness）**，原 Operit 内容保持不变。

### 新增

- `dsh/skills/dsh_context_handoff/`：交接判定 Skill，数据源换成 DSH 会话日志
  - `scripts/context_gauge.mjs`：读 `$DSH_HOME/sessions/**/session.v4.jsonl.zstd`（多帧 zstd，Node 内置 zlib，零依赖），从每步 `usage` 取实测窗口与命中率
- `dsh/skills/dsh_ui_anchors/`：手机 UI 锚点规范，工具换成 dsh-go 的 `mcp__phone__*`
  - `scripts/ui_prune.py`：沿用原裁剪器
- `dsh/dsh-go-plugin/local-cache-gauge/`：dsh-go 原生插件，输入框上方状态条 + 回合脚注 + 体检面板

### 修正

- `ui_prune.py` 标记字母冲突：原实现取属性首字母，`checkable` 与 `clickable` 都输出 `C`（实测 `C,C`）。改为映射表：C 可点 / L 长按 / S 可滚 / K 可勾选 / E 选中。
- 交接阈值按 DSH 重新标定：原「`think` 占正文 ≥18%」在 DSH 里几乎永久触发（实测单会话思考 21K 字符对正文 607 字符 = 97%，属正常）。改为「思考累计字符 + 前后半程膨胀倍数」。

### 不变

- 原 `skills/conversation_handoff`、`skills/android_ui_automation`、`scripts/context_gauge.py` 全部保留，供 Operit 用户继续使用。
