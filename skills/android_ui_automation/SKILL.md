---
name: android_ui_automation
description: 在 Android 屏幕上定位控件并执行精确点击/输入。需读取界面结构、做多步 UI 操作，或界面 dump 过大导致定位不准时使用。
---

# Android UI 自动化

## 适用场景

- 需要在手机屏幕上定位并操作控件（点击、输入、滑动、跨 App 流程）
- 需要读取当前界面结构来判断下一步动作
- 直接导出完整 UI 树导致上下文膨胀、模型定位错元素时

## 核心原则

1. **永不使用 `detail=full`**：全量 UI 树单屏即 40 KB / 约 1 万 token，重 App 可达 5 万～12 万 token
2. **先裁剪，再决策**：界面信息必须先压缩成锚点列表才进入推理
3. **用序号和 bounds 操作**：不通读 XML，靠锚点的文本/类名/bounds 定位
4. **静态前缀零随机**：界面信息、时间戳、UUID、随机 session id 等易变内容，只允许出现在工具结果或当轮消息中，禁止写入 system prompt、本 Skill 正文或任何静态资产。静态前缀里任何一个字符变化，都会让整段缓存失效
5. **不要用采样参数来求稳定**：DeepSeek 默认 `thinking.type=enabled`，而 `temperature` / `top_p` 在 thinking 模式下不生效，该 API 也没有 `seed` 参数；`user_id` 用于 KVCache 隔离，**严禁填随机值**，否则缓存会被切碎

## 执行步骤

### 1. 获取界面信息

常规情况直接用平台工具（默认 `summary` 已是属性级裁剪版）：

```
Automatic_ui_base:get_page_info  format=xml  detail=summary
```

仅当需要原始全量树（例如 summary 丢了你需要的节点）时，才走 shell：

```
uiautomator dump /sdcard/ui_dump.xml
```

### 2. 压缩为锚点列表

若上一步用的是原始 XML，先裁剪，**不要直接读原始文件**：

```bash
python3 <Operit目录>/skills/android_ui_automation/scripts/ui_prune.py /sdcard/ui_dump.xml
```

输出格式：`序号|类名|文本|bounds|标记`，标记中 `C`=可点击、`L`=可长按、`S`=可滚动。
实测：40,501 bytes → 3,596 bytes（压缩率 91.1%，约 1 万 token → 900）。

只需体积统计时可加 `--stats`。

### 3. 定位并操作

- 优先用**可见文本**或**类名**匹配锚点
- 拿到 bounds 后取中心点，用 `tap(x, y)` 点击
- 能用 `click_element(resourceId / className / bounds)` 精确定位时优先用，少用坐标猜

### 4. 验证

每次操作后**重新取一次界面信息**确认结果，不要连续盲点。
多步任务建议组合调用：`tap → get_page_info`，一次输出完整操作序列。

### 5. 失败处理

单步失败最多重试 2 次；连续失败则停止，报告当前界面状态与已完成的步骤，不要继续乱点。

## 约束边界

- 不代替用户完成支付、删除授权、账号安全类操作
- 不修改系统设置
- 单次界面信息只保留必要锚点，禁止把完整 XML / UI 树粘贴进回复正文
- 环境信息（时间、电量、前台 Activity）由平台注入，不要自行构造或写入静态文本

## 期望输出

- 每一步：操作 + 目标锚点 + 结果（成功/失败/原因）
- 结束时：任务完成状态 + 最终界面确认

## 附带脚本

| 路径 | 用途 |
|---|---|
| `scripts/ui_prune.py` | 把原始 UI dump XML 裁剪为可交互锚点列表，输出压缩率统计 |

引用方式：`scripts/ui_prune.py`（相对 SKILL.md 所在目录），也可用绝对路径调用。
