# local-cache-gauge · 缓存体检

dsh-go 手机 App 的本地小插件：把当前会话的**缓存命中率**和**上下文窗口**直接显示在界面上。

## 显示什么

| 位置 | 内容 |
|---|---|
| 输入框上方状态条 | `命中 94.4% · 69K`，点一下打开面板 |
| 每个回合的脚注 | 该回合自己的命中率与窗口 |
| 面板「缓存体检」 | 常规命中、当前窗口、峰值、首条命中、步数、思考累计、工具输出、每步命中率曲线；两个按钮：复制体检结果 / 刷新 |

## 数据从哪来

读 `$DSH_HOME/sessions/<cwd-slug>/session-<id>/session.v4.jsonl.zstd` 里每步的 `usage`：

- `inputTokens` 不含缓存部分，实际 prompt 长度 ≈ `inputTokens + cacheReadTokens`
- 常规命中率 = Σ`cacheReadTokens` / Σ(`inputTokens` + `cacheReadTokens`)，**跳过首条请求**（首条必然是 0%，不是故障）

只读会话日志，不写、不改、不上传。

## 安装

```sh
P="${DSH_HOME:-$HOME/.dsh}/dsh-go/plugins/local-cache-gauge"
mkdir -p "$P"
cp -r ./* "$P"/          # 把本目录内容复制进去
node "${DSH_HOME:-$HOME/.dsh}/skills/dsh-go-plugin/kit/bin/check.mjs" "$P" --load
dsh plugin --profile web add "$P"
```

装的是指向该目录的链接，**目录不能删**。改了 `lib/` 里的代码要在 App 的「引擎」页重启引擎才生效。

卸载：

```sh
dsh plugin --profile web remove local-cache-gauge
rm -rf "$P"
```

## 限制

- 窗口 = 该步发出的 prompt token，和客户端 `currentWindowSize` 同量级但不完全相等。
- 会话日志按帧追加，插件尽量还原多帧；极端情况下最后一次写入可能读不到，会沿用上一次读数。
- 每 15 秒刷新一次，不做后台轮询之外的事。
