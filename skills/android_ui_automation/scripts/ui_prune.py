#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
UI 树裁剪器：把 uiautomator/Accessibility 导出的原始 XML 压缩成"可交互锚点列表"。
用法:
    python3 ui_prune.py <dump.xml>            # 打印精简列表 + 压缩比统计
    python3 ui_prune.py <dump.xml> --stats    # 只打印统计
设计原则:
    - 只保留"有语义"的节点：clickable / long-clickable / scrollable / 有 text / 有 content-desc
    - 只保留 5 个高价值属性：序号、类名短名、文本、bounds、可点击性
    - 丢弃 layout 参数、package、checkable、enabled 之外的噪音属性
"""
import sys
import xml.etree.ElementTree as ET

KEEP_FLAGS = ("clickable", "long-clickable", "scrollable", "checkable", "selected")


def prune(path):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        src = f.read()

    root = ET.fromstring(src)
    lines = []
    total_nodes = 0

    for node in root.iter("node"):
        total_nodes += 1
        text = (node.get("text") or "").strip()
        desc = (node.get("content-desc") or "").strip()
        cls = (node.get("class") or "").split(".")[-1]
        bounds = node.get("bounds") or ""
        flags = [k for k in KEEP_FLAGS if node.get(k) == "true"]

        # 丢弃纯容器 / 布局占位节点
        if not text and not desc and not flags:
            continue
        if node.get("visible-to-user") == "false":
            continue

        label = text or desc
        tag = ",".join(f[0].upper() for f in flags) or "-"
        lines.append(f"{len(lines)}|{cls}|{label}|{bounds}|{tag}")

    body = "\n".join(lines)
    return src, body, total_nodes, len(lines)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1

    path = sys.argv[1]
    src, body, total_nodes, kept = prune(path)
    full_b, min_b = len(src.encode("utf-8")), len(body.encode("utf-8"))
    # 粗估 token：英文/XML 约 4 字符 1 token，中文约 1.5 字符 1 token
    ratio = (1 - min_b / full_b) * 100 if full_b else 0

    print("=== 统计 ===")
    print(f"原始:   {full_b:>9,} bytes   节点 {total_nodes}")
    print(f"裁剪后: {min_b:>9,} bytes   锚点 {kept}")
    print(f"压缩率: {ratio:.1f}%   体积降至 {min_b/full_b*100:.1f}%")
    print(f"粗估 token: {full_b//4:,} -> {min_b//4:,}")

    if "--stats" not in sys.argv:
        print("\n=== 精简锚点列表 ===")
        print("序号|类名|文本|bounds|标记(C=可点 S=可滚)")
        print(body)

    return 0


if __name__ == "__main__":
    sys.exit(main())
