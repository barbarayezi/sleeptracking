# -*- coding: utf-8 -*-
"""Medication × Health baseline analysis — 2026-09-04.

数据源：reports/_data/*.json（从 Render Turso 拉取的实时导出）
分析目标：为药物模块建立"用药档案" + 首次基线趋势（睡眠/恢复分/HRV/RHR 各时段对比）。
"""
import json, statistics
from datetime import datetime, timedelta
from collections import defaultdict

D = "D:/01_Projects/self_coding/sleep_traking/reports/_data/"
sleep = json.load(open(D + "sleep.json", encoding="utf-8"))
daily = json.load(open(D + "whoop_daily.json", encoding="utf-8"))
meals = json.load(open(D + "meals.json", encoding="utf-8"))
periods = json.load(open(D + "periods.json", encoding="utf-8"))

def hh(s, w):
    try:
        st = datetime.strptime(s, "%Y-%m-%dT%H:%M")
        wt = datetime.strptime(w, "%Y-%m-%dT%H:%M")
        if wt <= st: wt += timedelta(days=1)
        return round((wt - st).total_seconds() / 3600, 2)
    except Exception:
        return None

QUAL = {"good": 2, "average": 1, "poor": 0}
QNAME = {2: "good", 1: "average", 0: "poor"}

# ---- 睡眠按日聚合 ----
by_day = defaultdict(lambda: {"hours": [], "qual": [], "device": []})
for r in sleep:
    d = r["record_date"]
    h = hh(r.get("sleep_time"), r.get("wake_time"))
    if h: by_day[d]["hours"].append(h)
    if r.get("sleep_quality") in QUAL: by_day[d]["qual"].append(r["sleep_quality"])
    if r.get("device_score") is not None: by_day[d]["device"].append(r["device_score"])

days = sorted(by_day)
dmap = {}
for d in days:
    a = by_day[d]
    dmap[d] = {
        "hours": round(sum(a["hours"]) / len(a["hours"]), 2) if a["hours"] else None,
        "qual_num": max(QUAL[x] for x in a["qual"]) if a["qual"] else None,  # 按最好质量? 用最高(好)？
        "device": round(sum(a["device"]) / len(a["device"])) if a["device"] else None,
    }

daily_map = {}
for x in daily:
    d = x["record_date"]
    daily_map[d] = x

# 质量 = 当天所有记录取最差（保守口径，与 health_models 一致）
def worst_qual(dstr):
    qs = [QUAL[r["sleep_quality"]] for r in sleep if r["record_date"] == dstr and r.get("sleep_quality") in QUAL]
    if not qs: return None
    return QNAME[min(qs)]

def mean(xs):
    xs = [x for x in xs if x is not None]
    return round(sum(xs) / len(xs), 2) if xs else None

def med(xs):
    xs = [x for x in xs if x is not None]
    return round(statistics.median(xs), 1) if xs else None

def fmt(x):
    return "--" if x is None else str(x)

# ---- 时段分段：2026-07-22~08-15（早期）、08-16~08-31（中期）、09-01~09-04（近 4 天）----
def seg_stats(label, ds):
    print(f"\n### {label}（{ds[0]} ~ {ds[-1]}，{len(ds)} 天）")
    hrs = [dmap[d]["hours"] for d in ds if d in dmap and dmap[d]["hours"] is not None]
    q0 = [1 for d in ds if d in dmap and worst_qual(d) == "good"]
    rec = [daily_map[d]["recovery_score"] for d in ds if d in daily_map and daily_map[d].get("recovery_score") is not None]
    hrv = [daily_map[d]["hrv"] for d in ds if d in daily_map and daily_map[d].get("hrv") is not None]
    rhr = [daily_map[d]["resting_heart_rate"] for d in ds if d in daily_map and daily_map[d].get("resting_heart_rate") is not None]
    strain = [daily_map[d]["strain"] for d in ds if d in daily_map and daily_map[d].get("strain") is not None]
    dev = [dmap[d]["device"] for d in ds if d in dmap and dmap[d]["device"] is not None]
    good_n = len([d for d in ds if d in dmap and worst_qual(d) == "good"])
    qual_days = len([d for d in ds if d in dmap and worst_qual(d) is not None])
    print(f"  睡眠时长 均 {fmt(mean(hrs))} h | 中位 {fmt(med(hrs))} h")
    print(f"  睡眠质量 良好占比 {good_n}/{qual_days} = {round(good_n/qual_days*100) if qual_days else 0}%")
    print(f"  手环分   {fmt(mean(dev))}")
    print(f"  恢复分   {fmt(mean(rec))} | HRV {fmt(mean(hrv))} ms | RHR {fmt(mean(rhr))} | strain {fmt(mean(strain))}")

d_all = days
s1 = [d for d in d_all if d <= "2026-08-15"]
s2 = [d for d in d_all if "2026-08-16" <= d <= "2026-08-31"]
s3 = [d for d in d_all if d >= "2026-09-01"]

print("=" * 60)
print("睡眠+Whoop 各时段基线（2026-07-22 起记）")
print("=" * 60)
seg_stats("A. 早期（7/22 - 8/15）", s1)
seg_stats("B. 中期（8/16 - 8/31）", s2)
seg_stats("C. 近 4 天（9/01 - 9/04）", s3)

# ---- 近 14 天逐日表 ----
print("\n" + "=" * 60)
print("近 14 天逐日明细（睡眠 / 恢复 / HRV / RHR / 手环分）")
print("=" * 60)
last14 = d_all[-14:]
print(f"日期 | 时长h | 质量 | 手环 | 恢复分 | HRV | RHR")
for d in last14:
    m = dmap.get(d, {})
    w = worst_qual(d)
    wmap = {"good": "良", "average": "中", "poor": "差"}
    dm = daily_map.get(d, {})
    print(f"{d} | {fmt(m.get('hours'))} | {wmap.get(w or '', '--')} | {fmt(m.get('device'))}"
          f" | {fmt(dm.get('recovery_score'))} | {fmt(dm.get('hrv'))} | {fmt(dm.get('resting_heart_rate'))}")

# ---- 饮食健康分（最近有记录日期）----
print("\n" + "=" * 60)
print("饮食健康分 / 经期天数概览")
print("=" * 60)
meals_by_date = defaultdict(list)
for m in meals:
    if m.get("health_score") is not None:
        meals_by_date[m["meal_date"]].append(m["health_score"])
ms_days = sorted(meals_by_date)
if ms_days:
    recent = ms_days[-10:]
    print("最近 10 个有 AI 健康分的饮食日：")
    for d in recent:
        scores = meals_by_date[d]
        print(f"  {d}  {len(scores)} 餐  avg={round(sum(scores)/len(scores),1)}")
print(f"经期记录 {len(periods)} 条")

# ---- 睡眠问题 top ----
print("\n" + "=" * 60)
print("睡眠问题统计（睡眠模块勾选，top10）")
print("=" * 60)
prob_counter = defaultdict(int)
for r in sleep:
    import json as _j
    try:
        probs = _j.loads(r.get("sleep_problems") or "[]")
    except Exception:
        probs = []
    for p in probs:
        prob_counter[p] += 1
NAMES = {"insomnia": "失眠", "dreams": "多梦", "sweats": "多汗", "waking": "频醒", "early_waking": "早醒"}
for k, v in sorted(prob_counter.items(), key=lambda x: -x[1])[:10]:
    print(f"  {NAMES.get(k, k)} × {v}")
