# -*- coding: utf-8 -*-
"""临时诊断：Whoop 云端 vs 应用侧 Turso，定位三天无睡眠数据的责任方。"""
import os, sys, socket
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
socket.setdefaulttimeout(20)

from datetime import datetime, timedelta, timezone
from whoop.client import WhoopClient

START = (datetime.now(timezone.utc) - timedelta(days=14)).strftime("%Y-%m-%d")


def main():
    print("=" * 64)
    print("[1] Whoop 云端 API 直连（绕过本应用代码）")
    print("=" * 64)
    client = WhoopClient()
    if not client.is_authenticated():
        print("FATAL: 无有效 Whoop token（未授权或刷新失败）")
        return
    print("token: OK")

    cycles = client.get_all_cycle_data(start_date=START) or []
    cycles_sorted = sorted(cycles, key=lambda c: c.get("start") or "", reverse=True)
    print(f"\n[cycle] 近14天共 {len(cycles_sorted)} 条，最近 8 条:")
    for c in cycles_sorted[:8]:
        sc = c.get("score") or {}
        print(f"  start={c.get('start')}  end={c.get('end')}"
              f"  strain={sc.get('strain')}  kj={sc.get('kilojoule')}  state={c.get('score_state')}")

    sleeps = client.get_all_sleep_data(start_date=START) or []
    sleeps_sorted = sorted(sleeps, key=lambda s: s.get("start") or "", reverse=True)
    print(f"\n[sleep] 近14天共 {len(sleeps_sorted)} 条，最近 8 条:")
    for s in sleeps_sorted[:8]:
        print(f"  start={s.get('start')}  end={s.get('end')}"
              f"  nap={s.get('nap')}  state={s.get('score_state')}  id={s.get('id')}")

    recs = client.get_all_recovery_data(start_date=START) or []
    recs_sorted = sorted(recs, key=lambda r: r.get("created_at") or "", reverse=True)
    print(f"\n[recovery] 近14天共 {len(recs_sorted)} 条，最近 5 条:")
    for r in recs_sorted[:5]:
        sc = r.get("score") or {}
        print(f"  created={r.get('created_at')}  recovery={sc.get('recovery_score')}  state={r.get('score_state')}")

    print("\n" + "=" * 64)
    print("[2] 应用侧 Turso 数据库")
    print("=" * 64)
    from database import get_connection
    conn = get_connection()

    try:
        rs = conn.execute(
            "SELECT key, value FROM _meta WHERE key IN ('last_whoop_sync','last_whoop_sync_error')")
        meta = {r[0]: r[1] for r in rs.fetchall()}
        print(f"last_whoop_sync       = {meta.get('last_whoop_sync')!r}  (北京时间)")
        print(f"last_whoop_sync_error = {meta.get('last_whoop_sync_error')!r}")
    except Exception as e:
        print(f"_meta 查询失败: {e}")

    def cols(table):
        rs = conn.execute(f"PRAGMA table_info({table})")
        return [r[1] for r in rs.fetchall()]

    try:
        c_all = cols("whoop_daily_metrics")
        pick = [c for c in ["record_date", "recovery_score", "strain", "kilojoule",
                            "hrv_rmssd_milli", "hrv", "resting_heart_rate"] if c in c_all]
        rs = conn.execute(
            f"SELECT {', '.join(pick)} FROM whoop_daily_metrics ORDER BY record_date DESC LIMIT 8")
        print(f"\nwhoop_daily_metrics 最近 8 行  cols={pick}:")
        for r in rs.fetchall():
            print("  " + "  ".join(str(x) for x in r))
    except Exception as e:
        print(f"whoop_daily_metrics 查询失败: {e}")

    try:
        c_all = cols("sleep_records")
        pick = [c for c in ["id", "record_date", "record_type", "sleep_time", "wake_time",
                            "source", "whoop_id", "sleep_quality"] if c in c_all]
        rs = conn.execute(
            f"SELECT {', '.join(pick)} FROM sleep_records ORDER BY record_date DESC, id DESC LIMIT 10")
        print(f"\nsleep_records 最近 10 行  cols={pick}:")
        for r in rs.fetchall():
            print("  " + "  ".join(str(x) for x in r))
    except Exception as e:
        print(f"sleep_records 查询失败: {e}")


main()
