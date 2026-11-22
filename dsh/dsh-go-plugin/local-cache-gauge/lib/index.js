// local-cache-gauge — 在 dsh-go 里显示当前会话的缓存命中率与上下文窗口。
// 数据源：$DSH_HOME/sessions/<cwd-slug>/session-<id>/session.v4.jsonl.zstd 里每步的 usage。
// 只读，不改任何会话数据。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

export const name = 'local-cache-gauge'

const DSH_HOME = process.env.DSH_HOME || path.join(process.env.HOME || '/root', '.dsh')
const SESS_ROOT = path.join(DSH_HOME, 'sessions')
const REFRESH_MS = 15_000

const cache = new Map() // sessionId -> { at, metrics }

function findLog(sessionId) {
  if (!fs.existsSync(SESS_ROOT)) return null
  const want = sessionId ? `session-${sessionId}` : null
  let newest = null
  for (const slug of fs.readdirSync(SESS_ROOT)) {
    const slugDir = path.join(SESS_ROOT, slug)
    let st
    try { st = fs.statSync(slugDir) } catch { continue }
    if (!st.isDirectory()) continue
    if (want) {
      const dir = path.join(slugDir, want)
      if (!fs.existsSync(dir)) continue
      for (const f of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
        const p = path.join(dir, f)
        if (fs.existsSync(p)) return p
      }
      continue
    }
    for (const sd of fs.readdirSync(slugDir)) {
      if (!sd.startsWith('session-')) continue
      for (const f of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
        const p = path.join(slugDir, sd, f)
        try {
          const m = fs.statSync(p)
          if (!newest || m.mtimeMs > newest.mtimeMs) newest = { mtimeMs: m.mtimeMs, p }
        } catch { /* 跳过 */ }
      }
    }
  }
  return newest ? newest.p : null
}

function decompress(buf) {
  let best = Buffer.alloc(0)
  try { best = zlib.zstdDecompressSync(buf) } catch { /* 走下面的续帧 */ }
  try {
    const more = zlib.zstdDecompressSync(buf, { finishFlush: zlib.constants.ZSTD_E_CONTINUE })
    if (more.length > best.length) best = more
  } catch { /* 忽略 */ }
  return best
}

function compute(file) {
  const raw = fs.readFileSync(file)
  const text = raw[0] === 0x28 && raw[1] === 0xb5 ? decompress(raw).toString('utf8') : raw.toString('utf8')
  const steps = []
  const thinkPerStep = new Map() // turn -> chars
  let toolCalls = 0
  let toolChars = 0

  for (const line of text.split('\n')) {
    if (!line) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e.type === 'assistant/message') {
      const turn = e.data?.turn ?? 0
      let think = 0
      for (const c of e.data?.message?.content || []) {
        if (c.type === 'reasoning') think += (c.text || '').length
        else if (c.type === 'tool-call') toolCalls += 1
      }
      thinkPerStep.set(turn, (thinkPerStep.get(turn) || 0) + think)
      const u = e.data?.usage
      if (u) steps.push({ turn, input: u.inputTokens || 0, cacheRead: u.cacheReadTokens || 0 })
    } else if (e.type === 'tool/result') {
      toolChars += JSON.stringify(e.data?.message?.content ?? '').length
    }
  }

  const windows = steps.map((s) => s.input + s.cacheRead)
  const warm = steps.slice(1)
  const warmPrompt = warm.reduce((a, s) => a + s.input + s.cacheRead, 0)
  const hit = warmPrompt ? (warm.reduce((a, s) => a + s.cacheRead, 0) / warmPrompt) * 100 : 0
  const firstHit = steps[0] ? (steps[0].cacheRead / Math.max(1, steps[0].input + steps[0].cacheRead)) * 100 : 0

  const perStepHit = steps.map((s) => {
    const total = s.input + s.cacheRead
    return total ? Math.round((s.cacheRead / total) * 1000) / 10 : 0
  })

  const thinkTotal = [...thinkPerStep.values()].reduce((a, b) => a + b, 0)
  const turns = [...thinkPerStep.keys()].sort((a, b) => a - b)

  return {
    steps: steps.length,
    turns: turns.length,
    window: windows.at(-1) || 0,
    peak: windows.length ? Math.max(...windows) : 0,
    hit,
    firstHit,
    perStepHit,
    thinkTotal,
    toolCalls,
    toolKB: Math.round(toolChars / 1024),
    turnHit: new Map(steps.map((s) => [s.turn, {
      hit: (s.input + s.cacheRead) ? (s.cacheRead / (s.input + s.cacheRead)) * 100 : 0,
      window: s.input + s.cacheRead,
    }])),
  }
}

function metrics(sessionId) {
  const key = sessionId || '_newest'
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < 5_000) return hit.metrics
  const file = findLog(sessionId)
  if (!file) return null
  let m = null
  try { m = compute(file) } catch { m = null }
  // 读失败（正在写入）时沿用上次结果
  const prev = hit?.metrics
  if (!m) return prev || null
  cache.set(key, { at: Date.now(), metrics: m })
  return m
}

const fmtK = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : String(n))
const pct = (n) => `${n.toFixed(n >= 99.95 ? 0 : 1)}%`

function tone(hit) {
  if (!hit) return 'info'
  if (hit >= 90) return 'good'
  if (hit >= 80) return 'warn'
  return 'bad'
}

function stripText(m, zh) {
  if (!m) return zh ? '暂无数据' : 'No data'
  return zh ? `命中 ${pct(m.hit)} · ${fmtK(m.window)}` : `Hit ${pct(m.hit)} · ${fmtK(m.window)}`
}

export function apply(ctx) {
  ctx.inject(['dshGo'], (ctx) => {
    // 输入框上方的状态条
    ctx.dshGo.strip('gauge', (scope, emit, caps) => {
      const zh = !String(caps?.locale || '').startsWith('en')
      const tick = () => emit({ text: stripText(metrics(scope?.sessionId), zh), icon: 'chart' })
      tick()
      const timer = setInterval(tick, REFRESH_MS)
      if (timer.unref) timer.unref()
      return () => clearInterval(timer)
    })

    // 每轮脚注：这一轮自己的命中率与窗口
    ctx.dshGo.turnNote?.('gauge-note', (scope, emit, caps) => {
      const zh = !String(caps?.locale || '').startsWith('en')
      const tick = () => {
        const m = metrics(scope?.sessionId)
        if (!m) return
        const out = {}
        for (const [turn, v] of m.turnHit) {
          out[String(turn)] = {
            text: zh ? `${pct(v.hit)} · ${fmtK(v.window)}` : `${pct(v.hit)} · ${fmtK(v.window)}`,
            tone: v.hit === 0 ? 'muted' : v.hit >= 90 ? 'good' : v.hit >= 80 ? 'warn' : 'bad',
          }
        }
        emit(out)
      }
      tick()
      const timer = setInterval(tick, REFRESH_MS)
      if (timer.unref) timer.unref()
      return () => clearInterval(timer)
    })

    // 体检面板
    ctx.dshGo.panel('gauge-panel', {
      view: (scope, caps) => {
        const zh = !String(caps?.locale || '').startsWith('en')
        return {
          type: 'stack',
          title: zh ? '缓存体检' : 'Cache gauge',
          children: [
            {
              type: 'row',
              children: [
                { type: 'metric', label: zh ? '常规命中' : 'Warm hit', value: { $: 'data.hit' }, tone: { $: 'data.hitTone' } },
                { type: 'metric', label: zh ? '当前窗口' : 'Window', value: { $: 'data.window' } },
                { type: 'metric', label: zh ? '峰值' : 'Peak', value: { $: 'data.peak' } },
              ],
            },
            {
              type: 'keyValue',
              items: [
                [zh ? '首条命中' : 'First', { $: 'data.firstHit' }],
                [zh ? '请求步数' : 'Steps', { $: 'data.steps' }],
                [zh ? '思考累计' : 'Thinking', { $: 'data.think' }],
                [zh ? '工具输出' : 'Tool output', { $: 'data.tool' }],
              ],
            },
            {
              type: 'chart',
              kind: 'line',
              categories: { $: 'data.cats' },
              series: [{ name: zh ? '每步命中率' : 'Hit per step', values: { $: 'data.series' } }],
              unit: '%',
              caption: zh ? '首条必然是 0%，看后续趋势' : 'First request is always 0%; watch the trend',
            },
            { type: 'callout', text: { $: 'data.verdict' }, tone: { $: 'data.verdictTone' } },
            {
              type: 'actions',
              items: [
                { label: zh ? '复制体检结果' : 'Copy result', action: 'copy' },
                { label: zh ? '刷新' : 'Refresh', action: 'refresh' },
              ],
            },
          ],
        }
      },
      data: (scope, emit, caps) => {
        const zh = !String(caps?.locale || '').startsWith('en')
        const push = () => {
          const m = metrics(scope?.sessionId)
          if (!m) {
            emit({ hit: '—', hitTone: 'info', window: '—', peak: '—', firstHit: '—', steps: '—', think: '—', tool: '—', cats: [], series: [], verdict: zh ? '还没有这一步的日志，发一条消息再看' : 'No log yet; send a message first', verdictTone: 'info' })
            return
          }
          const last = m.perStepHit.slice(-12)
          const verdict = m.window >= 75000
            ? (zh ? '窗口已过 75K，建议交接' : 'Window above 75K; consider handoff')
            : m.hit && m.hit < 85
              ? (zh ? '命中偏低，先查静态前缀有没有变动' : 'Low hit rate; check the static prefix')
              : (zh ? '状态正常' : 'Healthy')
          emit({
            hit: pct(m.hit),
            hitTone: tone(m.hit),
            window: fmtK(m.window),
            peak: fmtK(m.peak),
            firstHit: m.firstHit ? pct(m.firstHit) : '0%',
            steps: String(m.steps),
            think: zh ? `${fmtK(m.thinkTotal)} 字` : `${fmtK(m.thinkTotal)} ch`,
            tool: `${m.toolKB}K`,
            cats: last.map((_, i) => `#${m.perStepHit.length - last.length + i + 1}`),
            series: last,
            verdict,
            verdictTone: m.window >= 75000 ? 'warn' : m.hit && m.hit < 85 ? 'warn' : 'good',
          })
        }
        push()
        const timer = setInterval(push, REFRESH_MS)
        if (timer.unref) timer.unref()
        return () => clearInterval(timer)
      },
      actions: {
        refresh: () => ({ refresh: true }),
        copy: (scope, event) => {
          const m = metrics(scope?.sessionId)
          if (!m) return { toast: '暂无数据' }
          const text = [
            `常规命中 ${pct(m.hit)}（首条 ${pct(m.firstHit)}，必然 0%）`,
            `当前窗口 ${m.window} tok · 峰值 ${m.peak} tok`,
            `步数 ${m.steps} · 思考累计 ${m.thinkTotal} 字符 · 工具输出 ${m.toolKB}K`,
          ].join('\n')
          return { copy: text, toast: '已复制' }
        },
      },
    })
  })
}
