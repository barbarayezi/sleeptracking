#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
回填每日固定服药记录到 Sleep Tracker（Turso 生产库）。

用法:
    python scripts/backfill_medications.py --start 2026-08-15 --end 2026-09-03
    python scripts/backfill_medications.py --start 2026-08-15 --end 2026-09-03 --dry-run
    python scripts/backfill_medications.py --date 2026-08-15          # 单天

机制:
    - 先 GET /api/medications?date=YYYY-MM-DD 拿当天已有记录
    - 用 (medication_name, administration_slot) 去重，只 POST 缺失的
    - 幂等：重复运行不会插入重复记录

固定服药方案（用户 2026-08-15 起）:
    早 08:00  鱼油 2 粒            (supplement)
    早 08:00  健视佳 1 粒          (supplement)
    早 08:00  草酸艾司西酞普兰口服溶液 1 支 (antidepressant)
    早 08:00  解郁除烦胶囊 3 粒    (antidepressant)
    晚 20:00  解郁除烦胶囊 3 粒    (antidepressant)
"""
import argparse
import datetime as dt
import json
import ssl
import sys
import urllib.request

BASE = "https://sleeptracking.onrender.com"

# 关闭 SSL 校验（Render/cloudflare 在本机偶发握手失败，数据非敏感）
_CTX = ssl.create_default_context()
_CTX.check_hostname = False
_CTX.verify_mode = ssl.CERT_NONE

# 每日固定方案： (name, dosage, unit, category, slot, time)
PLAN = [
    ("鱼油", 2, "粒", "supplement", "morning", "08:00"),
    ("健视佳", 1, "粒", "supplement", "morning", "08:00"),
    ("草酸艾司西酞普兰口服溶液", 1, "支", "antidepressant", "morning", "08:00"),
    ("解郁除烦胶囊", 3, "粒", "antidepressant", "morning", "08:00"),
    ("解郁除烦胶囊", 3, "粒", "antidepressant", "evening", "20:00"),
]


def _http(method, url, body=None, retries=4):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    last_err = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                url,
                data=data,
                method=method,
                headers={
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
            )
            with urllib.request.urlopen(req, timeout=30, context=_CTX) as r:
                raw = r.read().decode("utf-8")
                return r.status, (json.loads(raw) if raw else None)
        except Exception as e:  # 偶发 SSL EOF，重试
            last_err = e
            if attempt < retries - 1:
                import time
                time.sleep(1.0 + attempt)
    raise last_err


def existing_for(date_str):
    try:
        status, data = _http("GET", f"{BASE}/api/medications?date={date_str}")
    except Exception as e:
        print(f"  {date_str}: GET 失败 {e}", file=sys.stderr)
        return None  # 未知 -> 后续视为需补，但单条 POST 仍幂等
    if status != 200 or not isinstance(data, list):
        return None
    # key = (name, slot)
    return {(x.get("medication_name"), x.get("administration_slot")): x for x in data}


def backfill_date(date_str, dry_run=False, verbose=True):
    have = existing_for(date_str)
    if have is None:
        # 拿不到现状，跳过以免盲写（下一轮重跑会再试）
        if verbose:
            print(f"  {date_str}: 状态未知，跳过（下次重跑）", file=sys.stderr)
        return 0
    to_add = [p for p in PLAN if (p[0], p[4]) not in have]
    if not to_add:
        if verbose:
            print(f"  {date_str}: 已完整 ({len(have)} 条)，跳过")
        return 0
    if dry_run:
        if verbose:
            print(f"  {date_str}: 将补 {len(to_add)} 条 -> "
                  + ", ".join(f"{p[0]}({p[4]})" for p in to_add))
        return len(to_add)
    added = 0
    import time
    for (name, dosage, unit, cat, slot, t) in to_add:
        payload = {
            "record_date": date_str,
            "record_time": t,
            "medication_name": name,
            "dosage": dosage,
            "dosage_unit": unit,
            "category": cat,
            "administration_slot": slot,
            "notes": "回填：自 2026-08-15 起每日固定方案",
        }
        try:
            status, _ = _http("POST", f"{BASE}/api/medications", payload)
            if status == 201:
                added += 1
                if verbose:
                    print(f"  {date_str}: + {name} {dosage}{unit} ({slot}) [{status}]")
            else:
                if verbose:
                    print(f"  {date_str}: ! {name} 返回 {status}", file=sys.stderr)
        except Exception as e:
            if verbose:
                print(f"  {date_str}: ! {name} 异常 {e}", file=sys.stderr)
        time.sleep(0.3)  # 节流，避免触发 Render 限流
    return added


def daterange(start_str, end_str):
    s = dt.date.fromisoformat(start_str)
    e = dt.date.fromisoformat(end_str)
    while s <= e:
        yield s.isoformat()
        s += dt.timedelta(days=1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", help="起始日期 YYYY-MM-DD")
    ap.add_argument("--end", help="结束日期 YYYY-MM-DD（含）")
    ap.add_argument("--date", help="单天回填 YYYY-MM-DD（与 --start/--end 互斥）")
    ap.add_argument("--dry-run", action="store_true", help="只打印将要补的记录，不写入")
    args = ap.parse_args()

    if args.date:
        dates = [args.date]
    elif args.start and args.end:
        dates = list(daterange(args.start, args.end))
    else:
        ap.error("必须提供 --date 或 --start/--end")

    print(f"模式: {'DRY-RUN' if args.dry_run else 'WRITE'}  日期数: {len(dates)}")
    total = 0
    for d in dates:
        total += backfill_date(d, dry_run=args.dry_run)
    print(f"完成：{'拟补' if args.dry_run else '已补'} {total} 条记录")


if __name__ == "__main__":
    main()
