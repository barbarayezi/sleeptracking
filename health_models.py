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
    """Join sleep + Whoop + Apple Health + period into one per-date series.

    Returns { from, to, days: [...], insights: [...] }.
    Each day dict may contain: date, sleep_hours, sleep_quality, device_score,
    recovery_score, resting_heart_rate, hrv, spo2_percentage, skin_temp_celsius,
    strain, kilojoule, avg_heart_rate, max_heart_rate, workout_count, workout_strain,
    sports (list), steps, active_energy_kj, distance_km, is_period, phase.
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

    return insights
