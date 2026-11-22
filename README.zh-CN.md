# AgentCacheBoost · 缓存命中率治理

[English](README.md) · **简体中文**

> 一份**以实测数据为唯一依据**的缓存命中率治理指南，覆盖**两套 Agent 环境**：
> Operit（原版）与 **DSH / dsh-go**（DeepSeek Harness，v0.2.0 起新增）。
>
> 它只回答一个问题：**"我的缓存命中率看起来很低——这真的是问题吗？"**
> （答案是：通常不是。下面告诉你怎么判断、真正花钱的是哪一块、以及该怎么办。）

**目录：** [这是什么](#这是什么) · [关键结论](#关键结论全部来自实测) · [目录结构](#目录结构) · [安装](#安装) · [用法](#用法) · [实测数据](#实测数据) · [已知限制](#已知限制) · [常见问题](#常见问题) · [变更记录](#变更记录) · [许可](#许可)

---

## 这是什么

同一套方法论，两个落地版本：

| 环境 | 状态 | 交付物 | 数据源 |
|---|---|---|---|
| **Operit**（Android AI Agent） | 原版，保持可用 | `skills/conversation_handoff`、`skills/android_ui_automation`、`scripts/context_gauge.py` | Operit `room_db` 备份 |
| **DSH / dsh-go**（DeepSeek Harness，手机原生） | v0.2.0 新增 | `dsh/skills/dsh_context_handoff`、`dsh/skills/dsh_ui_anchors`、`dsh/dsh-go-plugin/local-cache-gauge` | DSH 会话日志 `session.v4.jsonl.zstd` |

两边都回答同一件事，但**指标能测到什么不一样**：

- Operit 侧：活跃窗口 `currentWindowSize` 读不到，只能看消息条数与命中率；
- DSH 侧：每一步的 `usage` 都在日志里，**窗口和命中率是实测值**，还能看到思考字符的膨胀趋势。

> Skill 是**纯文本资产**，不是程序：平台只把 `SKILL.md` 的 `name` + `description` 注入可用包列表，正文在模型主动加载时才进入上下文。

顺便证伪一个流传较广的说法：网上那段号称"开启 DeepSeek 上下文缓存"的脚本**是多余的**——DeepSeek 的上下文缓存**默认开启、无需改代码**，且是 best-effort（官方明确"不保证 100 % 命中率"），缓存项数小时到数天后自动清除。该脚本还同时存在 URL 错误、取值下标错误，并引用了一个 DeepSeek API 中并不存在的"1024 token 缓存门槛"。

---

## 关键结论（全部来自实测）

1. **新对话的首条请求必然 0 % 命中**——这是数学必然，不是故障。判断好坏要看**同一对话内的趋势**，别看单条请求。
2. **总体命中率低，通常来自"短对话占比高"**，而不是某个功能在拖后腿。同一账号实测：长对话 **94–99 %**，短/一次性对话 **75–89 %**；DSH 侧单会话稳定在 **94–97 %**。
3. **前缀匹配是从头比对的**，因此：
   - 静态前缀里任何一个字符变化 → **之后的内容全部失效**；
   - 时间戳、UUID、随机 session id **禁止**写进 system prompt、`AGENTS.md`、`prompt-inject.md` 或任何静态资产；
   - **`user_id` 严禁填随机值**——它用于 KVCache 隔离，随机值会把缓存切碎；
   - 随机 UUID 放在**请求头**无影响；放进 **prompt 文本**里 = 100 % 破坏前缀。
4. **采样参数救不了命中率。** DeepSeek 默认 `thinking.type=enabled`，此时 `temperature` / `top_p` 不生效，且该 API **没有 `seed` 参数**。
5. **自动总结是固定扣血点，但只值约 4–5 %。** 实测：总结后首条命中 **51.97 %**，常规请求 **94.05 %**。它真实存在，却很少是主因；要保留就优先关掉"按消息数触发"。
6. **完整 UI 树是隐藏的 token 黑洞。** `detail=full` 单屏约 40 KB ≈ 1 万 token，重 App 可达 5–12 万 token。先裁剪再推理——实测能省 **91.1 %**。
7. **思考会随对话变长而膨胀**，而且"思考占正文的比例"这个指标在 DSH 里会骗人：实测一个正常会话思考 **50K 字符**、正文只有几百字符，占比 99 % 却完全健康。改用**思考累计字符 + 前后半程膨胀倍数**（≥1.8x 留意，≥2.5x 说明真在膨胀）。

---

## 目录结构

```
README.md / README.zh-CN.md   # 本文件
CHANGELOG.md                  # 版本变更
LICENSE
skills/                       # ── Operit 版（原版，未改动）
├── conversation_handoff/
│   ├── SKILL.md
│   └── scripts/context_gauge.py     # 读 room_db 备份
└── android_ui_automation/
    ├── SKILL.md
    └── scripts/ui_prune.py          # UI dump XML → 锚点
dsh/                          # ── DSH / dsh-go 版（v0.2.0）
├── README.zh-CN.md / README.md
├── skills/
│   ├── dsh_context_handoff/
│   │   ├── SKILL.md
│   │   └── scripts/context_gauge.mjs   # 读 DSH 会话日志，零依赖
│   └── dsh_ui_anchors/
│       ├── SKILL.md
│       └── scripts/ui_prune.py
└── dsh-go-plugin/
    └── local-cache-gauge/              # dsh-go 原生插件
        ├── package.json
        ├── cordis.patch.yml
        ├── lib/index.js
        └── README.md
```

两套的 `ui_prune.py` 是同一份逻辑，DSH 那份修了标记字母冲突（详见 [CHANGELOG](CHANGELOG.md)）。

---

## 安装

### Operit

1. 把 `skills/` 下**两个目录整体**复制到 `/sdcard/Download/Operit/skills/`
2. 确认结构为 `skills/<skill名>/SKILL.md`，并在软件设置里开启该 Skill 的"AI 可见性"
3. 需要时让 Agent 调用 `use_package("<skill名>")` 激活

### DSH / dsh-go

```bash
# 1) 两个技能
cp -r dsh/skills/dsh_context_handoff dsh/skills/dsh_ui_anchors "${DSH_HOME:-$HOME/.dsh}/skills/"

# 2) 原生插件（手机本机引擎的 profile 是 web）
P="${DSH_HOME:-$HOME/.dsh}/dsh-go/plugins/local-cache-gauge"
mkdir -p "$P" && cp -r dsh/dsh-go-plugin/local-cache-gauge/* "$P"/
node "${DSH_HOME:-$HOME/.dsh}/skills/dsh-go-plugin/kit/bin/check.mjs" "$P" --load
dsh plugin --profile web add "$P"
```

装完**重启一次引擎**（App 的「引擎」页）：插件代码是加载时读入的。之后输入框上方会出现 `命中 97.3% · 110K`。

依赖：Node ≥ 22.15（内置 zstd）；Python 3 只用标准库。

---

## 用法

```bash
# DSH：全量体检 / 单会话 / 最近会话 / JSON
node dsh/skills/dsh_context_handoff/scripts/context_gauge.mjs
node dsh/skills/dsh_context_handoff/scripts/context_gauge.mjs --chat 关键词
node dsh/skills/dsh_context_handoff/scripts/context_gauge.mjs --current --json

# Operit：全局体检 / 单对话 / 指定备份
python3 skills/conversation_handoff/scripts/context_gauge.py
python3 skills/conversation_handoff/scripts/context_gauge.py --chat <标题关键词>
python3 skills/conversation_handoff/scripts/context_gauge.py --zip <room_db 归档>

# UI dump 裁剪（两边通用）
python3 dsh/skills/dsh_ui_anchors/scripts/ui_prune.py /sdcard/ui_dump.xml
python3 dsh/skills/dsh_ui_anchors/scripts/ui_prune.py /sdcard/ui_dump.xml --stats
```

**交接阈值**（DSH 版脚本已内置；Operit 版直接在 `SKILL.md` 里改）：

| 信号 | 留意 | 建议交接 |
|---|---|---|
| 当前窗口（`input` + `cacheRead`） | ≥45K | ≥75K（峰值 ≥120K 直接强建议） |
| 用户消息数 | ≥100 | ≥200 |
| 思考累计字符 | ≥50K | ≥120K |
| 思考膨胀倍数（后半程 / 前半程） | ≥1.8x | ≥2.5x |
| 该会话常规命中率 | <85 % 且 prompt > 20K | 说明前缀不稳，先查静态资产 |
| 工具输出累计 | >200K 字符 | 先裁剪再继续 |

---

## 实测数据

DSH 侧，一个真实长会话（81 步）：

```
判定          窗口    峰值    消息  思考    膨胀   命中    标题
强烈建议交接  110K    110K    17    50K     1.1x   97.3%   下载并运行 dsh-purge 插件

首条命中 0.0%（新会话必然，不是故障）
常规命中 97.3%  ·  末条窗口 110K tok
```

Operit 侧（原版 README 的数据，保留）：

```
判定              窗口tok    消息   思考占比   工具占比    命中   标题
建议交接           90,660    71    15.3%    26.8%   93.4%  <标题>
强烈建议交接        63,473   204    24.4%    25.5%   94.7%  <标题>
```

UI 裁剪：`40,501 B → 3,596 B`（91.1 %）。

---

## 已知限制

- **Skill 不会自动执行**，不会自己跑脚本——每一步都要模型主动动手。
- DSH 侧的"窗口"是该步实际发出的 prompt token（`inputTokens + cacheReadTokens`），与客户端的 `currentWindowSize` 同量级但不完全相等。
- 会话日志按帧追加，脚本尽量还原多帧；极端情况下最后一条可能缺失。
- Operit 侧读的是**备份**，会滞后；实时库在应用私有目录，无 root 读不到。
- token 数为**估算值**（中文 ≈ 0.67 token/字，英文 ≈ 1 token / 3.8 字符）。
- 插件的读数是**只读**的：不改模型设置、不改会话、不上传任何东西。

---

## 常见问题

**UI 上显示命中率约 75 %，是不是坏了？**
大概率没有。先确认这个数字是不是被"短对话/新对话"主导。**同一对话内的趋势**才是有意义的信号。

**不用 Operit / 不用 DSH 能用吗？**
方法论通用，但评估器要改：Operit 版解析 `room_db`，DSH 版解析会话日志。换平台要换数据源那一层。

**会改动我的模型设置吗？**
不会。评估器与插件都是只读的，Skill 是纯文本资产。

**它会自动提醒我吗？**
Skill 不会。DSH 插件会——它常驻状态条，每 15 秒刷新一次读数。

---

## 变更记录

见 [CHANGELOG.md](CHANGELOG.md)。最新：**v0.2.0** 新增 DSH 适配版，原 Operit 内容不变。

## 免责声明

非官方社区整理，**与 Operit、DeepSeek 官方均无隶属或背书关系**。设置项名称、工具名与路径可能随版本变化。本文内容按原样提供，不作任何担保。

## 许可

[MIT](LICENSE)
