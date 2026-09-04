#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
直连 Turso 批量回填每日固定服药记录（绕过 HTTP，单次连接写完）。

用法:
    python scripts/backfill_medications_direct.py --start 2026-08-15 --end 2026-09-03
    python scripts/backfill_medications_direct.py --dry-run

读取项目根 .env 的 TURSO_URL / TURSO_AUTH_TOKEN，建立单个 libsql 连接，
按 (medication_name, administration_slot) 幂等查缺后批量 INSERT。
"""
import argparse
import datetime as dt
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_env():
    """从根目录 .env 读取 TURSO_* 注入环境（不依赖 python-dotenv）。"""
    env_path = os.path.join(ROOT, ".env")
    if not os.path.exists(env_path):
        raise SystemExit(".env 不存在，无法直连 Turso")
    with open(env_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip().strip('"').strip("'")
            if k in ("TURSO_URL", "TURSO_AUTH_TOKEN") and v:
                os.environ.setdefault(k, v)


# 每日固定方案： (name, dosage, unit, category, slot, time)
PLAN = [
    ("鱼油", 2, "粒", "supplement", "morning", "08:00"),
    ("健视佳", 1, "粒", "supplement", "morning", "08:00"),
    ("草酸艾司西酞普兰口服溶液", 1, "支", "antidepressant", "morning", "08:00"),
    ("解郁除烦胶囊", 3, "粒", "antidepressant", "morning", "08:00"),
    ("解郁除烦胶囊", 3, "粒", "antidepressant", "evening", "20:00"),
]


def daterange(start_str, end_str):
    s = dt.date.fromisoformat(start_str)
    e = dt.date.fromisoformat(end_str)
    while s <= e:
        yield s.isoformat()
        s += dt.timedelta(days=1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2026-08-15")
    ap.add_argument("--end", default="2026-09-03")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    load_env()
    url = os.environ.get("TURSO_URL")
    token = os.environ.get("TURSO_AUTH_TOKEN")
    if not url or not token:
        raise SystemExit("TURSO_URL / TURSO_AUTH_TOKEN 缺失")

    import libsql

    print(f"连接 Turso: {url}")
    conn = libsql.connect(url, auth_token=token)

    total_added = 0
    dates = list(daterange(args.start, args.end))
    print(f"范围 {args.start}..{args.end}  共 {len(dates)} 天  {'[DRY-RUN]' if args.dry_run else ''}")

    for d in dates:
        # 现有 (name, slot) 集合
        cur = conn.execute(
            "SELECT medication_name, administration_slot FROM medication_records WHERE record_date = ?",
            (d,),
        )
        have = {(r[0], r[1]) for r in cur.fetchall()}
        to_add = [p for p in PLAN if (p[0], p[4]) not in have]
        if not to_add:
            continue
        if args.dry_run:
            print(f"  {d}: 拟补 {len(to_add)} 条 -> " + ", ".join(f"{p[0]}({p[4]})" for p in to_add))
            continue
        for (name, dosage, unit, cat, slot, t) in to_add:
            conn.execute(
                """INSERT INTO medication_records
                   (record_date, record_time, medication_name, dosage,
                    dosage_unit, category, administration_slot, notes)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (d, t, name, float(dosage), unit, cat, slot,
                 "回填：自 2026-08-15 起每日固定方案"),
            )
            total_added += 1
        conn.commit()
        print(f"  {d}: +{len(to_add)} 条")

    if not args.dry_run:
        conn.commit()
    conn.close()
    print(f"完成：{'拟补' if args.dry_run else '已补'} {total_added} 条")


if __name__ == "__main__":
    main()
