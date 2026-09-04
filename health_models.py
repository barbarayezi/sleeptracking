"""
Health metrics data layer.

Stores and queries cross-source daily health data:
  - whoop_daily_metrics : Whoop recovery (full) + daily strain / HR
  - whoop_workouts      : Whoop workout sessions
  - health_metrics      : Apple Health / external (steps, active energy, distance, ...)

get_health_overview() joins everything by date into one series for the dashboard.
"""

from datetime import datetime, timedelta
from database import get_connection


# ── Helpers ──────────────────────────────────────────

def _hours_between(sleep_time, wake_time):
    """Return sleep duration in hours from two 'YYYY-MM-DDTHH:MM' strings."""
    if not sleep_time or not wake_time:
        return None
    try:
        s = datetime.strptime(sleep_time, "%Y-%m-%dT%H:%M")
        w = datetime.strptime(wake_time, "%Y-%m-%dT%H:%M")
        if w <= s:
            w += timedelta(days=1)
        return round((w - s).total_seconds() / 3600.0, 2)
    except (ValueError, TypeError):
        return None


def _row_to_dict(row):
    if row is None:
        return None
    return {k: row[k] for k in row.keys()}


# ── Apple Health metrics (steps, etc.) ──────────────

def upsert_health_metric(metric_date, metric_type, value, source="apple_health"):
    """Insert or replace a health metric for a (date, type, source). Idempotent."""
    conn = get_connection()
    conn.execute(
        "DELETE FROM health_metrics WHERE metric_date = ? AND metric_type = ? AND source = ?",
        (metric_date, metric_type, source),
    )
    conn.execute(
        """INSERT INTO health_metrics (metric_date, metric_type, value, source, updated_at)
           VALUES (?, ?, ?, ?, datetime('now','localtime'))""",
        (metric_date, metric_type, float(value), source),
    )
    conn.commit()
    conn.close()


def bulk_upsert_health_metrics(rows, source="apple_health"):
    """rows = list of (metric_date, metric_type, value). Idempotent per (date,type)."""
    conn = get_connection()
    for metric_date, metric_type, value in rows:
        conn.execute(
            "DELETE FROM health_metrics WHERE metric_date = ? AND metric_type = ? AND source = ?",
            (metric_date, metric_type, source),
        )
        conn.execute(
            """INSERT INTO health_metrics (metric_date, metric_type, value, source, updated_at)
               VALUES (?, ?, ?, ?, datetime('now','localtime'))""",
            (metric_date, metric_type, float(value), source),
        )
    conn.commit()
    conn.close()
    return len(rows)


def get_health_metrics(metric_type, from_date=None, to_date=None):
    conn = get_connection()
    q = "SELECT metric_date, value FROM health_metrics WHERE metric_type = ?"
    params = [metric_type]
    if from_date:
        q += " AND metric_date >= ?"
        params.append(from_date)
    if to_date:
        q += " AND metric_date <= ?"
        params.append(to_date)
    q += " ORDER BY metric_date"
    rows = conn.execute(q, params).fetchall()
    conn.close()
    return [{"date": r["metric_date"], "value": r["value"]} for r in rows]


# ── Whoop daily / workouts ───────────────────────────

def get_whoop_daily(from_date=None, to_date=None):
    conn = get_connection()
    q = "SELECT * FROM whoop_daily_metrics"
    params = []
    if from_date or to_date:
        q += " WHERE 1=1"
        if from_date:
            q += " AND record_date >= ?"
            params.append(from_date)
        if to_date:
            q += " AND record_date <= ?"
            params.append(to_date)
    q += " ORDER BY record_date"
    rows = conn.execute(q, params).fetchall()
    conn.close()
    return [_row_to_dict(r) for r in rows]


def get_workouts(from_date=None, to_date=None):
    conn = get_connection()
    q = "SELECT * FROM whoop_workouts"
    params = []
    if from_date or to_date:
        q += " WHERE 1=1"
        if from_date:
            q += " AND record_date >= ?"
            params.append(from_date)
        if to_date:
            q += " AND record_date <= ?"
            params.append(to_date)
    q += " ORDER BY record_date, start_time"
    rows = conn.execute(q, params).fetchall()
    conn.close()
    return [_row_to_dict(r) for r in rows]


def get_period_days(from_date=None, to_date=None):
    conn = get_connection()
    q = "SELECT record_date, is_period_start, flow, phase FROM period_records"
    params = []
    if from_date or to_date:
        q += " WHERE 1=1"
        if from_date:
            q += " AND record_date >= ?"
            params.append(from_date)
        if to_date:
            q += " AND record_date <= ?"
            params.append(to_date)
    q += " ORDER BY record_date"
    rows = conn.execute(q, params).fetchall()
    conn.close()
    return [{"date": r["record_date"], "is_period_start": r["is_period_start"],
             "flow": r["flow"], "phase": r["phase"]} for r in rows]


# ── Combined overview ───────────────────────────────

def get_health_overview(from_date, to_date):
    """Join sleep + Whoop + Apple Health + period + meal into one per-date series.

    Returns { from, to, days: [...], insights: [...] }.
    Each day dict may contain: date, sleep_hours, sleep_quality, device_score,
    recovery_score, resting_heart_rate, hrv, spo2_percentage, skin_temp_celsius,
    strain, kilojoule, avg_heart_rate, max_heart_rate, workout_count, workout_strain,
    sports (list), steps, active_energy_kj, distance_km, is_period, phase,
    meal_health_score (0–10 daily avg), meal_health_rating (good/average/poor majority).
    """
    conn = get_connection()

    # 1) Sleep records grouped by date
    sleep_by_date = {}
    q = "SELECT * FROM sleep_records WHERE record_date >= ? AND record_date <= ? ORDER BY record_date"
    for r in conn.execute(q, (from_date, to_date)).fetchall():
        d = r["record_date"]
        agg = sleep_by_date.setdefault(d, {"sleep_hours": 0.0, "qualities": [], "device_scores": [],
                                           "recovery_score": None, "resting_heart_rate": None,
                                           "hrv": None, "spo2_percentage": None,
                                           "skin_temp_celsius": None, "steps": 0})
        hrs = _hours_between(r["sleep_time"], r["wake_time"])
        if hrs is not None:
            agg["sleep_hours"] += hrs
        if r["sleep_quality"]:
            agg["qualities"].append(r["sleep_quality"])
        if r["device_score"] is not None:
            agg["device_scores"].append(r["device_score"])
        if r["steps"] is not None and r["steps"] != '':
            try:
                agg["steps"] += float(r["steps"])
            except (ValueError, TypeError):
                pass
        for fld in ("recovery_score", "resting_heart_rate", "hrv", "spo2_percentage", "skin_temp_celsius"):
            if r[fld] is not None and agg[fld] is None:
                agg[fld] = r[fld]

    # 1b) Meal records aggregated per date — health_score (numeric 0-10) and health_rating
    meal_by_date = {}
    for r in conn.execute(
        "SELECT meal_date, health_rating, health_score FROM meal_records WHERE meal_date >= ? AND meal_date <= ?",
        (from_date, to_date),
    ).fetchall():
        d = r["meal_date"]
        agg = meal_by_date.setdefault(d, {"scores": [], "ratings": []})
        if r["health_score"] is not None:
            try:
                agg["scores"].append(float(r["health_score"]))
            except (ValueError, TypeError):
                pass
        if r["health_rating"]:
            agg["ratings"].append(r["health_rating"])

    # 2) Whoop daily
    daily_by_date = {}
    for r in conn.execute(
        "SELECT * FROM whoop_daily_metrics WHERE record_date >= ? AND record_date <= ? ORDER BY record_date",
        (from_date, to_date),
    ).fetchall():
        daily_by_date[r["record_date"]] = _row_to_dict(r)

    # 3) Workouts aggregated per date
    workouts_by_date = {}
    for r in conn.execute(
        "SELECT * FROM whoop_workouts WHERE record_date >= ? AND record_date <= ? ORDER BY record_date",
        (from_date, to_date),
    ).fetchall():
        d = r["record_date"]
        agg = workouts_by_date.setdefault(d, {"count": 0, "strain": 0.0, "sports": []})
        agg["count"] += 1
        if r["strain"] is not None:
            agg["strain"] += r["strain"]
        if r["sport_name"]:
            agg["sports"].append(r["sport_name"])

    # 4) Health metrics (steps / active energy / distance) pivoted per date
    health_by_date = {}
    for r in conn.execute(
        "SELECT metric_date, metric_type, value FROM health_metrics WHERE metric_date >= ? AND metric_date <= ?",
        (from_date, to_date),
    ).fetchall():
        d = r["metric_date"]
        health_by_date.setdefault(d, {})[r["metric_type"]] = r["value"]

    # 5) Period days
    period_by_date = {}
    for p in get_period_days(from_date, to_date):
        period_by_date[p["date"]] = p

    # 5b) Medication records per date (schema v12+) — daily pill log.
    # Counts by category so the overview can render an adherence strip and
    # the correlation endpoint can group complete vs incomplete days.
    medication_by_date = {}
    for r in conn.execute(
        "SELECT record_date, category FROM medication_records "
        "WHERE record_date >= ? AND record_date <= ?",
        (from_date, to_date),
    ).fetchall():
        d = r["record_date"]
        agg = medication_by_date.setdefault(
            d, {"supplement": 0, "antidepressant": 0, "other": 0, "total": 0})
        cat = r["category"] if r["category"] in ("supplement", "antidepressant") else "other"
        agg[cat] += 1
        agg["total"] += 1

    conn.close()

    # Build continuous date range
    start = datetime.strptime(from_date, "%Y-%m-%d")
    end = datetime.strptime(to_date, "%Y-%m-%d")
    days = []
    cur = start
    while cur <= end:
        d = cur.strftime("%Y-%m-%d")
        day = {"date": d}
        s = sleep_by_date.get(d)
        if s:
            day["sleep_hours"] = round(s["sleep_hours"], 2) if s["sleep_hours"] else None
            day["sleep_quality"] = _best_quality(s["qualities"])
            day["device_score"] = round(sum(s["device_scores"]) / len(s["device_scores"])) if s["device_scores"] else None
            day["recovery_score"] = s["recovery_score"]
            day["resting_heart_rate"] = s["resting_heart_rate"]
            day["hrv"] = s["hrv"]
            day["spo2_percentage"] = s["spo2_percentage"]
            day["skin_temp_celsius"] = s["skin_temp_celsius"]
        wd = daily_by_date.get(d)
        if wd:
            day["strain"] = wd["strain"]
            day["kilojoule"] = wd["kilojoule"]
            day["avg_heart_rate"] = wd["avg_heart_rate"]
            day["max_heart_rate"] = wd["max_heart_rate"]
            # fill recovery from daily too if sleep lacked it
            for fld in ("recovery_score", "resting_heart_rate", "hrv", "spo2_percentage", "skin_temp_celsius"):
                if day.get(fld) is None and wd.get(fld) is not None:
                    day[fld] = wd[fld]
        wk = workouts_by_date.get(d)
        if wk:
            day["workout_count"] = wk["count"]
            day["workout_strain"] = round(wk["strain"], 1)
            day["sports"] = wk["sports"]
        hm = health_by_date.get(d)
        if hm:
            day["steps"] = hm.get("steps")
            day["active_energy_kj"] = hm.get("active_energy_kj")
            day["distance_km"] = hm.get("distance_km")
        # Fallback to manually-entered steps from sleep records when Apple Health is absent
        if day.get("steps") is None and s and s.get("steps"):
            day["steps"] = s["steps"]
        pd = period_by_date.get(d)
        if pd:
            day["is_period"] = bool(pd["is_period_start"]) or (pd["flow"] not in (None, "", "none"))
            day["phase"] = pd["phase"] or ("period" if day.get("is_period") else None)
        # Meal health score aggregation
        ml = meal_by_date.get(d)
        if ml:
            if ml["scores"]:
                day["meal_health_score"] = round(sum(ml["scores"]) / len(ml["scores"]), 1)
            if ml["ratings"]:
                # majority vote: good=3, average=2, poor=1
                rating_map = {"good": 3, "average": 2, "poor": 1}
                scored = [rating_map.get(r, 2) for r in ml["ratings"]]
                day["meal_health_rating_num"] = round(sum(scored) / len(scored), 1)
                # back-convert majority for display
                avg_r = sum(scored) / len(scored)
                if avg_r >= 2.5:
                    day["meal_health_rating"] = "good"
                elif avg_r >= 1.5:
                    day["meal_health_rating"] = "average"
                else:
                    day["meal_health_rating"] = "poor"
        md = medication_by_date.get(d)
        if md:
            day["medication_taken_total"] = md["total"]
            day["medication_supplement"] = md["supplement"]
            day["medication_antidepressant"] = md["antidepressant"]
            day["medication_other"] = md["other"]
        days.append(day)
        cur += timedelta(days=1)

    insights = _compute_insights(days)
    return {"from": from_date, "to": to_date, "days": days, "insights": insights}


def _best_quality(qualities):
    """Pick the worst quality among the day's records (conservative)."""
    if not qualities:
        return None
    order = {"poor": 0, "average": 1, "good": 2}
    return min(qualities, key=lambda q: order.get(q, 1))


def _compute_insights(days):
    """Generate a few human-readable correlation insights."""
    insights = []

    # Sleep hours vs strain
    hi = [d for d in days if d.get("sleep_hours") and d.get("strain") is not None and d["strain"] >= 14]
    lo = [d for d in days if d.get("sleep_hours") and d.get("strain") is not None and d["strain"] < 14]
    if hi and lo:
        avg_hi = sum(d["sleep_hours"] for d in hi) / len(hi)
        avg_lo = sum(d["sleep_hours"] for d in lo) / len(lo)
        insights.append(
            f"高 Strain（≥14）日平均睡眠 {avg_hi:.1f} 小时，低 Strain 日 {avg_lo:.1f} 小时"
            f"（{'高' if avg_hi > avg_lo else '低'}负荷日睡眠更少）。"
        )

    # Recovery vs steps
    with_steps = [d for d in days if d.get("recovery_score") is not None and d.get("steps")]
    if len(with_steps) >= 4:
        ws_sorted = sorted(with_steps, key=lambda d: d["steps"])
        half = len(ws_sorted) // 2
        low_steps = ws_sorted[:half]
        high_steps = ws_sorted[half:]
        r_low = sum(d["recovery_score"] for d in low_steps) / len(low_steps)
        r_high = sum(d["recovery_score"] for d in high_steps) / len(high_steps)

        # Detect a single extreme step day that could distort the average
        step_vals = sorted(d["steps"] for d in with_steps)
        median_step = step_vals[len(step_vals) // 2]
        caveat = ""
        if step_vals[-1] > 3 * (median_step if median_step > 0 else 1):
            outlier = max(with_steps, key=lambda d: d["steps"])
            caveat = f"（注：{outlier['date']} 的 {outlier['steps']:.0f} 步为异常高值，可能夸大该结论，仅供参考。）"
        insights.append(
            f"步数多的日子平均恢复分 {r_high:.0f}，步数少的日子 {r_low:.0f}"
            f"（{'步数多恢复更好' if r_high > r_low else '步数多恢复反而更低'}）。{caveat}"
        )

    # Sleep quality vs period
    per = [d for d in days if d.get("sleep_quality") and d.get("is_period")]
    nonper = [d for d in days if d.get("sleep_quality") and not d.get("is_period")]
    if per and nonper:
        good_per = sum(1 for d in per if d["sleep_quality"] == "good") / len(per)
        good_non = sum(1 for d in nonper if d["sleep_quality"] == "good") / len(nonper)
        insights.append(
            f"经期睡眠良好率 {good_per*100:.0f}%，非经期 {good_non*100:.0f}%。"
        )

    # HRV trend hint
    hrvs = [d["hrv"] for d in days if d.get("hrv")]
    if len(hrvs) >= 5:
        insights.append(
            f"HRV 区间 {min(hrvs):.0f}–{max(hrvs):.0f} ms，越高代表身体恢复越好、压力越低。"
        )

    # Meal health score vs recovery
    meal_rec = [d for d in days if d.get("meal_health_score") is not None and d.get("recovery_score") is not None]
    if len(meal_rec) >= 5:
        hi_meal = [d for d in meal_rec if d["meal_health_score"] >= 7]
        lo_meal = [d for d in meal_rec if d["meal_health_score"] < 5]
        if hi_meal and lo_meal:
            r_hi = sum(d["recovery_score"] for d in hi_meal) / len(hi_meal)
            r_lo = sum(d["recovery_score"] for d in lo_meal) / len(lo_meal)
            insights.append(
                f"饮食高分日（≥7分）平均恢复 {r_hi:.0f}，低分日（<5分）平均恢复 {r_lo:.0f}"
                f"（{'饮食越好恢复越强' if r_hi > r_lo else '未观察到明显关联'}）。"
            )

    # Medication completeness vs recovery (only meaningful once the user logs meds)
    med_days = [d for d in days if d.get("medication_taken_total") is not None]
    if len(med_days) >= 4:
        from collections import Counter as _C
        mode = _C(d["medication_taken_total"] for d in med_days).most_common(1)[0][0]
        complete = [d for d in med_days if d["medication_taken_total"] >= mode and d.get("recovery_score") is not None]
        incomplete = [d for d in med_days if d["medication_taken_total"] < mode and d.get("recovery_score") is not None]
        if len(complete) >= 3 and len(incomplete) >= 1:
            r_c = sum(d["recovery_score"] for d in complete) / len(complete)
            r_i = sum(d["recovery_score"] for d in incomplete) / len(incomplete)
            insights.append(
                f"服药完整日（每日 {mode} 项）平均恢复 {r_c:.0f}，漏记/缺服日 {r_i:.0f}"
                f"（{'完整服药日恢复更好' if r_c > r_i else '未观察到与服药的明显关联'}）。"
            )

    return insights


# ── Medication × health correlation ──────────────────


def _avg(values):
    """Mean of non-None values, or None when nothing to average."""
    values = [v for v in values if v is not None]
    return round(sum(values) / len(values), 1) if values else None


def medication_correlation(from_date=None, to_date=None):
    """Medication vs health correlation across a window.

    Splits the timeline at the FIRST medication record (`era_start`):
      - "before": days before the user started the fixed daily regimen
      - "after":  days from `era_start` onward

    Inside the after era, days are grouped into "complete" (daily pill count
    >= the modal expectation) vs "incomplete" (missing entries), and Whoop
    recovery / RHR / HRV plus sleep hours are averaged per group. Works on
    Turso and local SQLite alike (all reads go through get_connection()).

    Returns a dict; {"has_data": False} when no medication record exists yet.
    """
    from datetime import date as _d, timedelta as _td
    from collections import Counter

    today = _d.today().isoformat()
    to_date = to_date or today

    conn = get_connection()
    rows = conn.execute(
        "SELECT record_date, category FROM medication_records "
        "WHERE record_date <= ? ORDER BY record_date ASC",
        (to_date,),
    ).fetchall()
    conn.close()
    if not rows:
        return {"has_data": False, "message": "暂无用药记录，无法做前后对比。"}

    era_start = str(rows[0]["record_date"])[:10]
    if not from_date or from_date > era_start:
        from_date = (datetime.strptime(era_start, "%Y-%m-%d").date()
                     - timedelta(days=13)).isoformat()

    # Per-day med rollup (same shape get_health_overview produces).
    # Normalise legacy dates that carry a 'T00:00:00' suffix.
    per_day = {}
    for r in rows:
        day = str(r["record_date"])[:10]
        agg = per_day.setdefault(day, {"total": 0, "antidepressant": 0})
        agg["total"] += 1
        if r["category"] == "antidepressant":
            agg["antidepressant"] += 1

    totals = Counter(v["total"] for v in per_day.values())
    expected = totals.most_common(1)[0][0] if totals else 0

    overview = get_health_overview(from_date, to_date)
    days = overview["days"]

    def seg_stats(day_list):
        """Average key metrics over a list of day dicts."""
        n = len(day_list)
        rec = _avg([d.get("recovery_score") for d in day_list])
        rhr = _avg([d.get("resting_heart_rate") for d in day_list])
        hrv = _avg([d.get("hrv") for d in day_list])
        sleep = _avg([d.get("sleep_hours") for d in day_list])
        good = sum(1 for d in day_list if d.get("sleep_quality") == "good")
        return {
            "days": n,
            "recovery_mean": rec,
            "rhr_mean": rhr,
            "hrv_mean": hrv,
            "sleep_hours_mean": sleep,
            "good_quality_days": good,
        }

    before = [d for d in days if d["date"] < era_start]
    after = [d for d in days if d["date"] >= era_start]

    complete_days = []
    incomplete_days = []
    for d in after:
        med_total = (per_day.get(d["date"]) or {}).get("total", 0)
        if med_total >= expected and expected > 0:
            complete_days.append(d)
        else:
            incomplete_days.append(d)

    # Antidepressant streak ending at `to_date` (any antidepressant logged counts)
    streak = 0
    cur = _d.fromisoformat(to_date)
    while True:
        day = (per_day.get(cur.isoformat()) or {})
        if day.get("antidepressant", 0) >= 1:
            streak += 1
            cur -= _td(days=1)
        else:
            break

    seg_before = seg_stats(before)
    seg_after = seg_stats(after)
    seg_complete = seg_stats(complete_days)
    seg_incomplete = seg_stats(incomplete_days)

    def delta(b, a, key):
        if b.get(key) is not None and a.get(key) is not None:
            return round(a[key] - b[key], 1)
        return None

    # ── Rule-based interpretation (no LLM — endpoint stays fast) ──
    notes = []
    if seg_before["days"] >= 3 and seg_after["days"] >= 3:
        d_r = delta(seg_before, seg_after, "recovery_mean")
        d_hrv = delta(seg_before, seg_after, "hrv_mean")
        d_rhr = delta(seg_before, seg_after, "rhr_mean")
        part = []
        if d_r is not None:
            part.append(f"恢复分 {seg_before['recovery_mean']} → {seg_after['recovery_mean']}"
                        f"（{'+' if d_r >= 0 else ''}{d_r}）")
        if d_hrv is not None:
            part.append(f"HRV {seg_before['hrv_mean']} → {seg_after['hrv_mean']}"
                        f" ms（{'+' if d_hrv >= 0 else ''}{d_hrv}）")
        if d_rhr is not None:
            part.append(f"静息心率 {seg_before['rhr_mean']} → {seg_after['rhr_mean']}"
                        f" bpm（{'+' if d_rhr >= 0 else ''}{d_rhr}）")
        notes.append(
            f"用药开始（{era_start}）前后：{('，'.join(part)) if part else '指标样本不足'}。"
            "这属于相关性观察，不能证明因果——抗抑郁药通常需 2–4 周才显示完整效果。"
        )
    if streak >= 3:
        notes.append(f"截至 {to_date}，抗抑郁药已连续服用 {streak} 天（中间无断档）。")
    if seg_complete["days"] >= 3 and seg_incomplete["days"] >= 1:
        r_c = seg_complete["recovery_mean"]
        r_i = seg_incomplete["recovery_mean"]
        if r_c is not None and r_i is not None:
            notes.append(
                f"服药完整日（每日 {expected} 项，{seg_complete['days']} 天）平均恢复 {r_c}"
                f"，缺服/漏记日（{seg_incomplete['days']} 天）平均恢复 {r_i}"
                f"（{'完整日更高' if r_c > r_i else '差异不显著或反向'}）。"
            )

    return {
        "has_data": True,
        "from": from_date,
        "to": to_date,
        "era_start": era_start,
        "expected_per_day": expected,
        "antidepressant_streak_days": streak,
        "segments": {
            "before": seg_before,
            "after": seg_after,
            "complete": seg_complete,
            "incomplete": seg_incomplete,
        },
        "incomplete_dates": [d["date"] for d in incomplete_days][-10:],
        "interpretation": notes,
    }
