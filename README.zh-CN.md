# Operit 缓存命中率治理 · 中文说明

[English](README.md) · **简体中文**

> 一份**以实测数据为唯一依据**的缓存命中率治理指南，外加两个可直接使用的 **Operit Skill**：
> 处理前缀卫生、长对话交接、UI 树裁剪。
>
> 它只回答一个问题：**"我的缓存命中率看起来很低——这真的是问题吗？"**
> （答案是：通常不是。下面告诉你怎么判断、真正花钱的是哪一块、以及该怎么办。）

**目录：** [这是什么](#这是什么) · [关键结论](#关键结论全部来自实测) · [目录结构](#目录结构) · [安装](#安装) · [用法](#用法) · [可选的定时巡检](#可选的定时巡检workflow-包) · [已知限制](#已知限制) · [常见问题](#常见问题) · [免责声明](#免责声明) · [许可](#许可)

---

## 这是什么

一套**零第三方依赖**的小工具，来自一次在 Operit（Android AI Agent）上的真实排查：

| 条目 | 作用 |
|---|---|
| `skills/conversation_handoff/` | 判断**一个对话何时该总结并迁移**；含 7 节无损交接模板、自过滤规则、无损校验清单 |
| `skills/android_ui_automation/` | UI 自动化规范：**永不使用 `detail=full`**、先裁剪再决策，以及前缀卫生原则 |
| `scripts/context_gauge.py` | 读 Operit 的 `room_db` **备份**，输出每个对话的窗口大小、消息条数、`think` 占比、工具占比、缓存命中率 |
| `scripts/ui_prune.py` | 把原始 UI dump 压成可操作的锚点列表（**实测 40,501 B → 3,596 B，压缩 91.1 %**） |

> Skill 是**纯文本资产**，不是程序：平台只把 `SKILL.md` 的 `name` + `description` 注入可用包列表，正文在模型主动 `use_package` 时才载入。

顺便证伪一个流传较广的说法：网上那段号称"开启 DeepSeek 上下文缓存"的脚本**是多余的**——DeepSeek 的上下文缓存**默认开启、无需改代码**，且是 best-effort（官方明确"不保证 100 % 命中率"），缓存项数小时到数天后自动清除。该脚本还同时存在 URL 错误、取值下标错误，并引用了一个 DeepSeek API 中并不存在的"1024 token 缓存门槛"。

---

## 关键结论（全部来自实测）

1. **新对话的首条请求必然 0 % 命中**——这是数学必然，不是故障。判断好坏要看**同一对话内的趋势**，别看单条请求。
2. **总体命中率低，通常来自"短对话占比高"**，而不是某个功能在拖后腿。同一账号实测：长对话 **94–99 %**，短/一次性对话 **75–89 %**。
3. **前缀匹配是从头比对的**，因此：
   - 静态前缀里任何一个字符变化 → **之后的内容全部失效**；
   - 时间戳、UUID、随机 session id **禁止**写进 system prompt 或任何静态资产；
   - **`user_id` 严禁填随机值**——它用于 KVCache 隔离，随机值会把缓存切碎；
   - 随机 UUID 放在**请求头**无影响；放进 **prompt 文本**里 = 100 % 破坏前缀。
4. **采样参数救不了命中率。** DeepSeek 默认 `thinking.type=enabled`，此时 `temperature` / `top_p` 不生效，且该 API **没有 `seed` 参数**。
5. **自动总结是固定扣血点，但只值约 4–5 %。** 实测：总结后首条命中 **51.97 %**，常规请求 **94.05 %**（未命中量 4.1 倍）。它真实存在，却很少是主因；如果要保留，优先关掉"按消息数触发"而不是阈值触发。
6. **完整 UI 树是隐藏的 token 黑洞。** `detail=full` 单屏约 40 KB ≈ 1 万 token，重 App 可达 5–12 万 token。先裁剪再推理——能省 91.1 %。
7. **`think` 会随对话变长而膨胀**（实测占比 0 % → 26 % → 60 %+，单条消息可超 10 万字符）。更麻烦的是：**一条消息里出现多段 `think` 会撑破客户端的折叠渲染**，导致原始思考内容直接裸露在正文里（根因在客户端渲染层，数据层没有任何字段可改）。→ **长对话及时交接，别硬扛。**

---

## 目录结构

```
README.md                 # 英文版
README.zh-CN.md           # 本文件（中文版）
LICENSE                   # MIT
.gitignore
skills/
├── conversation_handoff/
│   ├── SKILL.md                     # 交接规范：阈值、模板、自过滤
│   └── scripts/context_gauge.py     # 评估器（仅 Python 3 标准库）
└── android_ui_automation/
    ├── SKILL.md                     # UI 自动化规范 + 前缀卫生
    └── scripts/ui_prune.py          # UI dump → 锚点列表
```

依赖关系：

```
room_db 备份 (*.zip) ──▶ context_gauge.py ◀── conversation_handoff/SKILL.md
                                              └─产出─▶ <主题>-<日期>.md

UI dump XML ──▶ ui_prune.py ◀── android_ui_automation/SKILL.md
```

---

## 安装

1. 把 `skills/` 下的**两个目录整体**复制到 Operit 的 Skill 目录：`/sdcard/Download/Operit/skills/`
2. 确认结构为 `skills/<skill名>/SKILL.md`（Skill **必须**是文件夹且内含 `SKILL.md`，小写 `skill.md` 也认）。然后在软件设置里确认该 Skill 的"AI 可见性"开关是开启的。
3. 需要时让 Agent 调用 `use_package("<skill名>")` 激活。

> ⚠️ **Skill 不会自己运行。** 常驻在系统提示里的只有 `name` + `description` 那一行（约 40 token），正文只在模型主动 `use_package` 时才载入。"自动提醒"的真实含义是"模型在合适的时刻恰好想起了它"。

**依赖**

- Operit（Android），需支持 Agent / Skill
- Python 3 —— 只用标准库，无需 `pip install`
- 已在 Operit 中开启 `room_db` 备份（评估器唯一的数据源）

备份不在默认位置时：

```bash
export OPERIT_BACKUP_DIR=<你的备份目录>

# 或直接指定某个归档
python3 context_gauge.py --zip /path/to/room_db_backup_YYYY-MM-DD.zip
```

---

## 用法

```bash
# 全局体检：列出所有对话并给出交接判定
python3 skills/conversation_handoff/scripts/context_gauge.py

# 单对话诊断
python3 skills/conversation_handoff/scripts/context_gauge.py --chat <标题关键词>

# 调整行数 / 指定归档
python3 skills/conversation_handoff/scripts/context_gauge.py --top 30
python3 skills/conversation_handoff/scripts/context_gauge.py --zip <归档文件>
```

输出示例：

```
判定              窗口tok    消息   思考占比   工具占比    命中   标题
建议交接           90,660    71    15.3%    26.8%   93.4%  <标题>
强烈建议交接        63,473   204    24.4%    25.5%   94.7%  <标题>
共 15 个对话，其中 10 个建议交接。
```

**默认交接阈值**（直接在 `SKILL.md` 里改）：

| 信号 | 阈值 |
|---|---|
| 活跃窗口 `currentWindowSize` | ≥45K 建议 · ≥75K 强烈建议 |
| 消息条数 | ≥100 提醒 · ≥200 强烈建议 |
| `think` 占正文比 | ≥18 % 提醒 · ≥30 % 强烈建议 |
| 工具类消息占比 | ≥30 % 且任务已闭环 |
| 该对话缓存命中率 | <85 % 说明前缀不稳 |

---

## 可选的定时巡检（`workflow` 包）

可以搭一个定时巡检，但先看清它的边界：

- **活跃窗口 `currentWindowSize` 没有任何工具能读到**（实时接口和备份都没有）→ 巡检**只能判消息条数**（`extended_chat:list_chats` → `messageCount`），窗口阈值只能人工看 UI。
- 工作流**没有 LLM 节点**（只有 trigger / execute / condition / logic / extract），只能做固定数值比较，做不了语义判断。
- 如果不想要通知，可以让它"达标就写一个标记文件"，由 Agent 在会话开局读取并提示。

---

## 已知限制

- **Skill 不会自动执行**，不会自己跑脚本、不会自己写文档——每一步都需要模型主动动手。
- 评估器读的是**备份**，会滞后于当前对话（脚本会打印快照时间）；实时数据库在应用私有目录，无 root 读不到。
- token 数为**估算值**（中文 ≈ 0.67 token/字，英文 ≈ 1 token / 3.8 字符）。
- Operit 平台侧的自动记忆**没有失效机制**，会累积过期事实，需要人工清理。

---

## 常见问题

**UI 上显示命中率约 75 %，是不是坏了？**
大概率没有。先确认这个数字是不是被"短对话/新对话"主导。**同一对话内的趋势**才是有意义的信号。

**不使用 Operit 能用吗？**
评估器不行——它解析的是 Operit 的 `room_db` 表结构（`messages.cachedInputTokens`、`token_usage_records`）。但**方法论本身可以迁移**到其他 Agent。

**会改动我的模型设置吗？**
不会。评估器是只读的，Skill 是纯文本资产，没有执行能力。

**它会自动提醒我吗？**
不会。它只常驻在可用包列表里一行，必须由模型显式 `use_package` 才生效。把它当成一份"模型可以查阅的检查清单"，不是定时器。

---

## 免责声明

非官方社区整理，**与 Operit 官方无隶属或背书关系**。设置项名称、工具名与路径可能随版本变化。本文内容按原样提供，不作任何担保。

## 许可

[MIT](LICENSE)