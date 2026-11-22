#!/usr/bin/env node
// DSH 版上下文体检器（替代 Operit 的 context_gauge.py）
// 数据源：$DSH_HOME/sessions/<cwd-slug>/session-<uuid>/session.v4.jsonl.zstd
// 零依赖，只用 Node 内置 zlib（Node >= 22.15 / 24 有 zstd）。
//
// 用法：
//   node context_gauge.mjs                 # 全部会话体检
//   node context_gauge.mjs --top 30
//   node context_gauge.mjs --chat 关键词    # 单会话诊断（匹配标题/目录/id）
//   node context_gauge.mjs --current       # 只跑最近更新的那个会话
//   node context_gauge.mjs --json
//   node context_gauge.mjs --dir /自定义/sessions

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const args = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = args.indexOf(name);
  if (i === -1) return dflt;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const TOP = Number(opt('--top', 20)) || 20;
const CHAT = opt('--chat', null);
const CURRENT = !!opt('--current', false);
const JSON_OUT = !!opt('--json', false);

const DSH_HOME = process.env.DSH_HOME || path.join(process.env.HOME || '/root', '.dsh');
const SESS_ROOT = String(opt('--dir', path.join(DSH_HOME, 'sessions')));

// ---------- 读会话日志（多帧 zstd / 明文 jsonl 都吃） ----------
function decompress(buf) {
  // 先试一次性解压；多帧拼接时会截断，用流式再补一次
  let best = Buffer.alloc(0);
  try {
    best = zlib.zstdDecompressSync(buf);
  } catch { /* 忽略，走流式 */ }
  try {
    const out = zlib.zstdDecompressSync(buf, { finishFlush: zlib.constants.ZSTD_E_CONTINUE });
    if (out.length > best.length) best = out;
  } catch { /* 忽略 */ }
  return best;
}

function readEvents(file) {
  const raw = fs.readFileSync(file);
  let text;
  if (file.endsWith('.zstd') || (raw[0] === 0x28 && raw[1] === 0xb5)) {
    text = decompress(raw).toString('utf8');
  } else {
    text = raw.toString('utf8');
  }
  const evs = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { evs.push(JSON.parse(line)); } catch { bad += 1; }
  }
  return { evs, bad };
}

// ---------- 会话发现 ----------
function findSessions(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const slug of fs.readdirSync(root)) {
    const slugDir = path.join(root, slug);
    if (!fs.statSync(slugDir).isDirectory()) continue;
    for (const sd of fs.readdirSync(slugDir)) {
      if (!sd.startsWith('session-')) continue;
      const dir = path.join(slugDir, sd);
      if (!fs.statSync(dir).isDirectory()) continue;
      const log = ['session.v4.jsonl.zstd', 'session.v4.jsonl', 'session.jsonl']
        .map((f) => path.join(dir, f))
        .find((f) => fs.existsSync(f));
      if (!log) continue;
      out.push({ slug, id: sd, dir, log, mtime: fs.statSync(log).mtimeMs, size: fs.statSync(log).size });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// ---------- 指标 ----------
const est = (s) => Math.ceil((s || '').length * 0.67); // 中文为主的粗估

function analyze(file) {
  const { evs, bad } = readEvents(file);
  const meta = evs.find((e) => e.type === 'session')?.data || {};
  const titles = evs.filter((e) => e.type === 'session/title').map((e) => e.data?.title).filter(Boolean);
  const title = titles.at(-1) || path.basename(path.dirname(path.dirname(file)));

  let userMsgs = 0, asstMsgs = 0, toolCalls = 0, toolResultBytes = 0;
  let thinkChars = 0, textChars = 0, toolCallChars = 0;
  const thinkPerStep = [];
  const steps = []; // {turn, step, input, cacheRead, out}
  let lastTime = 0, firstTime = 0;

  for (const e of evs) {
    const t = e.time || 0;
    if (t && !firstTime) firstTime = t;
    if (t > lastTime) lastTime = t;

    if (e.type === 'user/message') userMsgs += 1;

    if (e.type === 'assistant/message') {
      asstMsgs += 1;
      let stepThink = 0;
      const content = e.data?.message?.content || [];
      for (const c of content) {
        if (c.type === 'reasoning') { thinkChars += (c.text || '').length; stepThink += (c.text || '').length; }
        else if (c.type === 'text') textChars += (c.text || '').length;
        else if (c.type === 'tool-call') {
          toolCalls += 1;
          toolCallChars += JSON.stringify(c.arguments ?? '').length;
        }
      }
      thinkPerStep.push(stepThink);
      const u = e.data?.usage;
      if (u) steps.push({ turn: e.data.turn, step: e.data.step, input: u.inputTokens || 0, cacheRead: u.cacheReadTokens || 0, out: u.outputTokens || 0 });
    }

    if (e.type === 'tool/result') {
      const m = e.data?.message;
      toolResultBytes += JSON.stringify(m?.content ?? '').length + JSON.stringify(e.data?.meta ?? '').length;
    }
  }

  // 缓存命中：首条请求必然 0%，趋势看后续
  const warm = steps.slice(1);
  const sum = (arr, k) => arr.reduce((a, x) => a + x[k], 0);
  const warmPrompt = sum(warm, 'input') + sum(warm, 'cacheRead');
  const hitRate = warmPrompt ? (sum(warm, 'cacheRead') / warmPrompt) * 100 : 0;
  const firstHit = steps[0] ? (steps[0].cacheRead / Math.max(1, steps[0].input + steps[0].cacheRead)) * 100 : 0;

  // 窗口大小：把 input + cacheRead 当成该轮实际发出的 prompt 长度
  const windows = steps.map((s) => s.input + s.cacheRead);
  const windowMax = windows.length ? Math.max(...windows) : 0;
  const windowLast = windows.length ? windows.at(-1) : 0;

  const thinkRatio = thinkChars + textChars ? (thinkChars / (thinkChars + textChars)) * 100 : 0;
  const thinkAvg = thinkPerStep.length ? Math.round(thinkChars / thinkPerStep.length) : 0;
  const thinkMax = thinkPerStep.length ? Math.max(...thinkPerStep) : 0;
  // 思考膨胀：后半程平均 / 前半程平均。>2 说明随对话变长在膨胀（Operit 那条结论的 DSH 版信号）
  const half = Math.floor(thinkPerStep.length / 2);
  const avgOf = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const firstHalf = avgOf(thinkPerStep.slice(0, half));
  const secondHalf = avgOf(thinkPerStep.slice(half));
  const thinkGrowth = firstHalf > 20 ? secondHalf / firstHalf : 0;
  const toolRatio = asstMsgs ? (toolCalls / asstMsgs) * 100 : 0;

  // ---------- 交接判定 ----------
  const reasons = [];
  let score = 0;
  if (windowLast >= 75000 || windowMax >= 120000) { score += 3; reasons.push(`窗口 ${fmt(windowLast)} / 峰值 ${fmt(windowMax)}`); }
  else if (windowLast >= 45000) { score += 1; reasons.push(`窗口 ${fmt(windowLast)}`); }
  if (userMsgs >= 200) { score += 3; reasons.push(`消息 ${userMsgs}`); }
  else if (userMsgs >= 100) { score += 1; reasons.push(`消息 ${userMsgs}`); }
  if (thinkTotalScore(thinkChars) >= 2) { score += 2; reasons.push(`思考累计 ${fmt(thinkChars)} 字符`); }
  else if (thinkTotalScore(thinkChars) === 1) { score += 1; reasons.push(`思考累计 ${fmt(thinkChars)} 字符`); }
  if (thinkGrowth >= 2.5) { score += 2; reasons.push(`思考膨胀 ${thinkGrowth.toFixed(1)}x`); }
  else if (thinkGrowth >= 1.8) { score += 1; reasons.push(`思考膨胀 ${thinkGrowth.toFixed(1)}x`); }
  if (hitRate && hitRate < 85 && warmPrompt > 20000) { score += 1; reasons.push(`命中率 ${hitRate.toFixed(1)}%（前缀不稳）`); }
  if (toolResultBytes > 200000) { score += 1; reasons.push(`工具输出 ${(toolResultBytes / 1024).toFixed(0)}K 字符`); }

  const verdict = score >= 4 ? '强烈建议交接' : score >= 2 ? '建议交接' : score >= 1 ? '留意' : '健康';

  return {
    title, id: meta.id || '', cwd: meta.cwd || '', preset: meta.agentPreset || '',
    model: evs.find((e) => e.type === 'model/selection')?.data?.model || '',
    steps: steps.length, userMsgs, asstMsgs, toolCalls,
    windowLast, windowMax, hitRate, firstHit,
    thinkRatio, thinkTotal: thinkChars, thinkAvg, thinkMax, thinkGrowth, toolRatio, toolResultKB: Math.round(toolResultBytes / 1024),
    lastTime, firstTime, badLines: bad,
    verdict, reasons,
  };
}

const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : String(n));
const thinkTotalScore = (ch) => (ch >= 120000 ? 2 : ch >= 50000 ? 1 : 0);

// ---------- 输出 ----------
const all = findSessions(SESS_ROOT);
if (!all.length) {
  console.error(`没有在 ${SESS_ROOT} 找到会话日志。用 --dir 指定 sessions 目录。`);
  process.exit(2);
}

let picked = all;
if (CURRENT) picked = all.slice(0, 1);
if (CHAT) {
  const kw = String(CHAT).toLowerCase();
  picked = all.filter((s) => {
    const r = analyze(s.log);
    return [r.title, r.cwd, r.id, s.slug].some((v) => String(v || '').toLowerCase().includes(kw));
  });
}

const rows = picked.map((s) => ({ ...analyze(s.log), file: s.log, mtime: s.mtime }));

if (JSON_OUT) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

const pad = (s, n) => {
  const w = [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return String(s) + ' '.repeat(Math.max(0, n - w));
};

console.log(`DSH 上下文体检 · ${rows.length} 个会话 · 源 ${SESS_ROOT}\n`);
console.log(pad('判定', 14) + pad('窗口', 8) + pad('峰值', 8) + pad('消息', 6) + pad('思考', 8) + pad('膨胀', 7) + pad('命中', 8) + '标题');
for (const r of rows.slice(0, TOP)) {
  console.log(
    pad(r.verdict, 14) + pad(fmt(r.windowLast), 8) + pad(fmt(r.windowMax), 8) +
    pad(r.userMsgs, 6) + pad(fmt(r.thinkTotal), 8) + pad(r.thinkGrowth ? `${r.thinkGrowth.toFixed(1)}x` : '-', 7) +
    pad(r.hitRate ? `${r.hitRate.toFixed(1)}%` : '-', 8) + (r.title || '').slice(0, 40),
  );
}

const need = rows.filter((r) => r.verdict.includes('交接'));
console.log(`\n共 ${rows.length} 个会话，其中 ${need.length} 个建议交接。`);
for (const r of need.slice(0, 5)) {
  console.log(`- ${r.title}: ${r.reasons.join(' / ')}`);
}
if (rows[0]) {
  console.log(`\n最近活跃：${rows[0].title}`);
  console.log(`  首条命中 ${rows[0].firstHit.toFixed(1)}%（新会话/新前缀必然 0%，不是故障）`);
  console.log(`  常规命中 ${rows[0].hitRate.toFixed(1)}%  ·  末条窗口 ${fmt(rows[0].windowLast)} tok  ·  步骤 ${rows[0].steps}`);
}
