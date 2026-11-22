# DSH / dsh-go 适配版

[English](README.md) · **简体中文**

把仓库根目录那套 Operit 方法论移植到 **DeepSeek Harness（DSH）** 与手机 App **dsh-go**。原 Operit 内容全部保留、互不影响。

## 和 Operit 版的差别

| 项 | Operit 版 | DSH 版 |
|---|---|---|
| 数据源 | `room_db` 备份 | `$DSH_HOME/sessions/<slug>/session-<id>/session.v4.jsonl.zstd` |
| 读取方式 | Python 解析 sqlite 备份 | Node 内置 `zlib` 解多帧 zstd，零依赖 |
| 能测到什么 | 消息条数、命中率、工具占比 | **每步 prompt token、窗口、峰值、每步命中率、思考字符膨胀** |
| 窗口 | `currentWindowSize` 读不到 | `inputTokens + cacheReadTokens` 实测 |
| think 指标 | 占正文 ≥18 % / ≥30 % | 累计字符 ≥50K / ≥120K + 前后半程膨胀倍数 |
| UI 操作 | Operit 工具 + `detail=full` | `mcp__phone__*`（`screen` / `collect` / `tap` / `intent`）+ 必要时 `uiautomator dump` |

为什么 think 指标要换：Operit 的"思考占正文比"在 DSH 里几乎永久触发。实测一个健康会话思考 **50K 字符**、正文只有几百字符，占比 99 % 却是正常的——真正有意义的是"思考累计多少"和"后半程比前半程涨了多少"。

## 内容

| 路径 | 用途 |
|---|---|
| `skills/dsh_context_handoff/SKILL.md` | 交接判定：阈值、7 节无损模板、自过滤、校验清单 |
| `skills/dsh_context_handoff/scripts/context_gauge.mjs` | 体检器：窗口 / 命中率 / 思考膨胀 / 交接判定 |
| `skills/dsh_ui_anchors/SKILL.md` | 手机 UI 锚点规范：先裁剪再决策、靠编号而不是坐标 |
| `skills/dsh_ui_anchors/scripts/ui_prune.py` | UI dump XML → 锚点列表（`C` 可点 / `L` 长按 / `S` 可滚 / `K` 可勾选 / `E` 选中） |
| `dsh-go-plugin/local-cache-gauge/` | dsh-go 原生插件：状态条 + 回合脚注 + 体检面板 |

## 安装

```bash
# 技能
cp -r skills/dsh_context_handoff skills/dsh_ui_anchors "${DSH_HOME:-$HOME/.dsh}/skills/"

# 插件
P="${DSH_HOME:-$HOME/.dsh}/dsh-go/plugins/local-cache-gauge"
mkdir -p "$P" && cp -r dsh-go-plugin/local-cache-gauge/* "$P"/
node "${DSH_HOME:-$HOME/.dsh}/skills/dsh-go-plugin/kit/bin/check.mjs" "$P" --load
dsh plugin --profile web add "$P"
```

手机本机引擎的 profile 是 `web`。装的是指向该目录的链接，**目录不能删**。装完重启一次引擎（App「引擎」页）——插件代码是加载时读入的。

卸载：

```bash
dsh plugin --profile web remove local-cache-gauge
rm -rf "$P"
```

## 用法

```bash
node skills/dsh_context_handoff/scripts/context_gauge.mjs            # 全部会话
node skills/dsh_context_handoff/scripts/context_gauge.mjs --chat 插件 # 单会话
node skills/dsh_context_handoff/scripts/context_gauge.mjs --current  # 最近活跃
node skills/dsh_context_handoff/scripts/context_gauge.mjs --json

python3 skills/dsh_ui_anchors/scripts/ui_prune.py /sdcard/ui_dump.xml
```

输出：

```
判定          窗口    峰值    消息  思考    膨胀   命中    标题
强烈建议交接  110K    110K    17    50K     1.1x   97.3%   下载并运行 dsh-purge 插件
```

- **窗口** = 该步 `inputTokens + cacheReadTokens`（`inputTokens` 不含缓存部分）
- **命中** = Σ`cacheReadTokens` / Σ(`inputTokens` + `cacheReadTokens`)，**跳过首条**（首条必然 0 %）
- **膨胀** = 后半程平均思考字符 / 前半程平均

## 插件显示什么

| 位置 | 内容 |
|---|---|
| 输入框上方状态条 | `命中 97.3% · 110K`，点一下开面板 |
| 回合脚注 | 该回合自己的命中率与窗口 |
| 面板「缓存体检」 | 常规命中、当前窗口、峰值、首条命中、步数、思考累计、工具输出、每步命中率曲线；复制结果 / 刷新 |

只读会话日志，不写、不改、不上传。

## 已知限制

- 窗口是该步发出的 prompt token，与客户端 `currentWindowSize` 同量级但不完全相等。
- 会话日志按帧追加；极端情况下最后一次写入读不到时，插件沿用上一次读数。
- `ui_prune.py` 需要 `android_shell` 能跑 `uiautomator dump`；日常用 `mcp__phone__screen` / `collect` 就不需要它。
- 插件每 15 秒刷新一次，不做其它后台动作。
