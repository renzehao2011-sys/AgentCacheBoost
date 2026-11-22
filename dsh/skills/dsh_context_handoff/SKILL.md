---
name: dsh_context_handoff
description: 判断一个 DSH 会话何时该总结并迁移到新会话（含缓存命中率体检、上下文窗口与思考膨胀读数）；提供量化阈值、无损交接模板与自过滤规则。当对话很长、命中率异常、思考膨胀或要开不相关新任务时使用。
---

# 会话交接（DSH 版）

Operit 版 `conversation_handoff` 的 DSH 移植：阈值来自实测，数据源换成 DSH 自己的会话日志。

## 数据源（先跑，不要凭感觉）

```bash
node ~/.dsh/skills/dsh_context_handoff/scripts/context_gauge.mjs
node ~/.dsh/skills/dsh_context_handoff/scripts/context_gauge.mjs --chat 关键词
node ~/.dsh/skills/dsh_context_handoff/scripts/context_gauge.mjs --current --json
```

读的是 `$DSH_HOME/sessions/<cwd-slug>/session-<uuid>/session.v4.jsonl.zstd`（多帧 zstd，脚本用 Node 内置 zlib 解，零依赖）。每一步的 `usage` 里有 `inputTokens` / `cacheReadTokens` / `outputTokens`，所以窗口和命中率是**实测**，不是估的。

## 关键结论（DSH 实测同款）

1. **首条请求必然 0% 命中**，数学必然。看同一会话内的趋势，别盯单条。
2. **整体命中率低，通常来自"短会话占比高"**，而不是某个功能在拖后腿。
3. **前缀从头比对**：静态前缀（system prompt、AGENTS.md、prompt-inject、Skill 正文）里任何字符变化 → 之后全部失效。时间戳、UUID、随机 session id 禁止进静态资产；`user_id` 别填随机值。
4. **`inputTokens` 不含缓存部分**，实际 prompt 长度 ≈ `inputTokens + cacheReadTokens`。脚本按这个算窗口。
5. **思考膨胀比思考占比更有意义**：脚本给的是"后半程/前半程思考字符倍数"，≥1.8 开始留意，≥2.5 说明在膨胀。

## 量化阈值（脚本已内置）

| 信号 | 留意 | 建议交接 |
|---|---|---|
| 当前窗口（input+cacheRead） | ≥45K | ≥75K（峰值 ≥120K 直接强建议） |
| 用户消息数 | ≥100 | ≥200 |
| 思考累计字符 | ≥50K | ≥120K |
| 思考膨胀倍数 | ≥1.8x | ≥2.5x |
| 该会话常规命中率 | <85% 且 prompt>20K | 说明前缀不稳，先查静态资产 |
| 工具输出累计 | >200K 字符 | 先裁剪再继续 |

**语义触发（优先级高于数值）**：任务已闭环要换目标 / 新需求与旧上下文无关 / 同一背景解释超 2 次 / 试错已收敛只剩结论。

## 执行步骤

1. 跑体检器，看触发项
2. 按模板起草交接文档，**先落盘**
3. 路径：`/root/workspace/handoff/<主题>-<日期>.md`（或用户指定目录）
4. 新会话首条消息 = 背景 + 当前目标 + 交接文档路径
5. 旧会话不删

## 交接文档模板

```markdown
# 交接：<主题>
日期 / 原会话标题：

## 1. 目标（当前仍在推进的）
## 2. 已确认的事实与结论（每条带依据）
## 3. 关键约束与决策（为什么这么定）
## 4. 产物与位置（路径 / 命令 / 配置项）
## 5. 未决问题与下一步（卡在哪）
## 6. 已排除的方案与原因
## 7. 关键标识符（ID / Key 名 / 版本号 / 阈值）
```

## 自过滤

**丢弃**：`reasoning`/think 正文、原始工具输出（日志、大列表、文件全文）、失败尝试、客套与重复确认、已被总结过的内容。

**保留**：最终决策 + 理由、约束与禁止项、确切路径命令配置键、未完成 TODO 与阻塞点、用户偏好与否决意见、已排除方案及原因。

## 无损校验

- [ ] 每个结论都能指向依据（文件 / 命令输出 / 用户原话）
- [ ] 文档里每个路径都真实存在
- [ ] 未决问题都写明卡在哪
- [ ] 没有"以后再补"的占位
- [ ] 不含 think 块和原始工具输出
- [ ] 只读本文档就能继续推进

## 约束边界

- 先落盘再开新会话
- 不把交接文档塞进 system prompt / Skill 正文（破坏前缀缓存）
- 不改用户的静态配置去"优化命中率"——先给数据，让用户决定

## 附带脚本

| 路径 | 用途 |
|---|---|
| `scripts/context_gauge.mjs` | 读 DSH 会话日志，出窗口 / 命中率 / 思考膨胀 / 交接判定 |
