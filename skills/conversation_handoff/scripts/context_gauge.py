#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
会话交接评估器 (context gauge)

从 Operit 的 room_db 备份中读取真实会话数据，量化判断一个对话是否
"值得生成总结并迁移到新对话"，并指出上下文体积主要花在哪里。

用法:
    python3 context_gauge.py                 # 列出所有对话 + 判定
    python3 context_gauge.py --chat 关键词    # 看某个对话的详细诊断
    python3 context_gauge.py --top 30        # 调整列出条数
    python3 context_gauge.py --zip <path>    # 指定备份文件

注意:
    - 数据来自 Operit 的 room_db 备份目录（默认
      /sdcard/Download/Operit/backup/room_db/；可用环境变量 OPERIT_BACKUP_DIR
      或 --zip 指定），因此可能滞后于当前对话（脚本会打印快照时间）。
    - token 数为估算值（中文约 0.67 token/字，英文约 1 token/3.8 字符）。
"""
import argparse
import datetime
import glob
import os
import re
import sqlite3
import sys
import zipfile

BACKUP_DIR = os.environ.get("OPERIT_BACKUP_DIR", "/sdcard/Download/Operit/backup/room_db")
WORK = "/tmp/operit_handoff"

CJK = re.compile(r"[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]")
THINK = re.compile(r"<think>.*?</think>", re.S)


def est_tokens(text):
    """粗估 token 数。"""
    if not text:
        return 0
    cjk = len(CJK.findall(text))
    other = len(text) - cjk
    return int(cjk * 0.67 + other / 3.8)


def load_db(zip_path=None):
    if zip_path is None:
        zips = sorted(glob.glob(os.path.join(BACKUP_DIR, "room_db_backup_*.zip")))
        if not zips:
            sys.exit(f"未找到备份: {BACKUP_DIR}/room_db_backup_*.zip")
        zip_path = zips[-1]
    os.makedirs(WORK, exist_ok=True)
    with zipfile.ZipFile(zip_path) as z:
        z.extractall(WORK)
    db = os.path.join(WORK, "app_database")
    if not os.path.exists(db):
        sys.exit(f"备份中未找到 app_database: {zip_path}")
    return db, zip_path


def analyze(con):
    c = con.cursor()
    chats = {}
    for row in c.execute("""
            SELECT id, title, updatedAt, inputTokens, currentWindowSize
            FROM chats"""):
        cid, title, upd, itok, win = row
        chats[cid] = {
            "id": cid, "title": title or "(无标题)", "updatedAt": upd or 0,
            "inputTokens": itok or 0, "window": win or 0,
            "msgs": 0, "user": 0, "ai": 0, "summary": 0,
            "chars": 0, "think_chars": 0, "tool_msgs": 0,
            "req_tokens": 0, "cached_tokens": 0, "reqs": 0,
        }

    for cid, sender, content, itok, ctok in c.execute("""
            SELECT chatId, sender, content, inputTokens, cachedInputTokens
            FROM messages"""):
        d = chats.get(cid)
        if d is None:
            continue
        content = content or ""
        d["msgs"] += 1
        d["chars"] += len(content)
        if sender == "user":
            d["user"] += 1
        elif sender == "summary":
            d["summary"] += 1
        else:
            d["ai"] += 1
        for m in THINK.findall(content):
            d["think_chars"] += len(m)
        # 工具调用/结果在库中以 <tool ...>...</tool> 结构内嵌
        if "<tool" in content or "tool_calls" in content:
            d["tool_msgs"] += 1
        if itok:
            d["req_tokens"] += itok
            d["cached_tokens"] += ctok or 0
            d["reqs"] += 1

    for d in chats.values():
        d["tokens_est"] = int(d["chars"] * 0.6)  # 中英混合正文粗估
        d["think_share"] = d["think_chars"] / d["chars"] if d["chars"] else 0
        d["tool_share"] = d["tool_msgs"] / d["msgs"] if d["msgs"] else 0
        d["hit"] = (d["cached_tokens"] / d["req_tokens"]
                    if d["req_tokens"] else None)
    return chats


def verdict(d):
    """返回 (等级, 分数, 原因列表)。"""
    reasons = []
    score = 0
    w = d["window"]
    if w >= 75000:
        score += 3
        reasons.append(f"活跃上下文 {w:,} tok，已达危险区")
    elif w >= 45000:
        score += 2
        reasons.append(f"活跃上下文 {w:,} tok，每轮回传成本偏高")
    elif w >= 25000:
        score += 1
        reasons.append(f"活跃上下文 {w:,} tok，需留意")

    if d["think_share"] >= 0.30:
        score += 2
        reasons.append(f"思考块占正文 {d['think_share']*100:.0f}%，是主要膨胀源")
    elif d["think_share"] >= 0.18:
        score += 1
        reasons.append(f"思考块占正文 {d['think_share']*100:.0f}%")

    if d["msgs"] >= 200:
        score += 2
        reasons.append(f"{d['msgs']} 条消息，历史冗长")
    elif d["msgs"] >= 100:
        score += 1
        reasons.append(f"{d['msgs']} 条消息")

    if d["hit"] is not None and d["hit"] < 0.85 and d["reqs"] >= 5:
        score += 1
        reasons.append(f"该对话缓存命中 {d['hit']*100:.1f}%，前缀不稳定")

    if d["tool_share"] >= 0.30:
        score += 1
        reasons.append(f"工具结果占 {d['tool_share']*100:.0f}%，可归档")

    if score >= 5:
        level = "强烈建议交接"
    elif score >= 3:
        level = "建议交接"
    elif score >= 2:
        level = "观察"
    else:
        level = "可继续"
    return level, score, reasons


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chat", help="按标题关键字查看单对话详情")
    ap.add_argument("--top", type=int, default=15)
    ap.add_argument("--zip", help="指定备份 zip")
    args = ap.parse_args()

    db, zp = load_db(args.zip)
    snap = datetime.datetime.fromtimestamp(os.path.getmtime(zp))
    print(f"数据快照: {os.path.basename(zp)}"
          f"  (备份时间 {snap:%Y-%m-%d %H:%M})")
    print("提示: 备份可能滞后于当前对话，判定结果仅用于趋势参考\n")

    con = sqlite3.connect(db)
    chats = analyze(con)
    con.close()

    items = list(chats.values())
    if args.chat:
        key = args.chat.lower()
        hits = [d for d in items if key in d["title"].lower()]
        if not hits:
            sys.exit(f"未找到标题含 {args.chat!r} 的对话")
        items = hits

    items.sort(key=lambda d: (d["window"], d["chars"]), reverse=True)

    if args.chat:
        for d in items:
            level, score, reasons = verdict(d)
            hit = f"{d['hit']*100:.1f}%" if d["hit"] is not None else "n/a"
            print(f"【{d['title']}】  判定: {level}  (分数 {score})")
            print(f"  消息 {d['msgs']} 条 (用户 {d['user']} / AI {d['ai']} / "
                  f"总结 {d['summary']})")
            print(f"  活跃窗口 {d['window']:,} tok   历史累计输入 "
                  f"{d['inputTokens']:,} tok   缓存命中 {hit}")
            print(f"  正文 {d['chars']:,} 字符 ≈ {d['tokens_est']:,} tok")
            print(f"  思考块 {d['think_chars']:,} 字符 "
                  f"({d['think_share']*100:.1f}%)   工具类消息 "
                  f"{d['tool_msgs']} 条 ({d['tool_share']*100:.1f}%)")
            print("  理由:")
            for r in reasons or ["无显著触发项"]:
                print(f"    - {r}")
            print()
        return

    print(f"{'判定':<12}{'窗口tok':>9}{'消息':>6}{'思考占比':>9}"
          f"{'工具占比':>9}{'命中':>8}  标题")
    for d in items[:args.top]:
        level, score, _ = verdict(d)
        hit = f"{d['hit']*100:.1f}%" if d["hit"] is not None else "-"
        print(f"{level:<12}{d['window']:>9,}{d['msgs']:>6}"
              f"{d['think_share']*100:>8.1f}%{d['tool_share']*100:>8.1f}%"
              f"{hit:>8}  {d['title'][:34]}")

    n_hand = sum(1 for d in items if verdict(d)[0].endswith("交接"))
    print(f"\n共 {len(items)} 个对话，其中 {n_hand} 个建议交接。")


if __name__ == "__main__":
    main()