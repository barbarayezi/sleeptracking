"""
Whoop → database sync module.
Maps Whoop API sleep data to sleep_records table.

Key mapping:
  Whoop sleep.score  →  device_score
  Whoop sleep.start  →  sleep_time
  Whoop sleep.end    →  wake_time
  Auto-detect record_type (night/nap) from sleep duration & start time
"""

import json
from datetime import datetime, timedelta
from database import get_connection
from whoop.client import WhoopClient


# ── Helpers ──────────────────────────────────────────


def _parse_whoop_time(ts_str):
    """Parse Whoop ISO timestamp to our format YYYY-MM-DDTHH:MM."""
    if not ts_str:
        return None
    # Whoop timestamps: "2026-07-15T03:00:00.000Z" or similar
    try:
        dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
        # Convert to local time (+8)
        dt_local = dt + timedelta(hours=8)
        return dt_local.strftime("%Y-%m-%dT%H:%M")
    except (ValueError, TypeError):
        return None


def _detect_record_type(sleep_start, sleep_end):
    """Detect if this is night sleep or a nap based on timing."""
    try:
        start = datetime.strptime(sleep_start, "%Y-%m-%dT%H:%M")
        end = datetime.strptime(sleep_end, "%Y-%m-%dT%H:%M")
        if end <= start:
            end += timedelta(days=1)
        duration_hours = (end - start).total_seconds() / 3600.0

        # Naps: short duration (< 2h) or daytime sleep
        if duration_hours < 2:
            return "nap"
        # If start is between 6AM and 8PM, likely a nap
        if 6 <= start.hour <= 20:
            return "nap"
        return "night"
    except (ValueError, TypeError):
        return "night"


def _determine_classification(sleep_time):
    """Determine early/late based on sleep time.
    Sleep before midnight = 'early', after = 'late'."""
    try:
        t = datetime.strptime(sleep_time, "%Y-%m-%dT%H:%M")
        # If sleeping before 0:00 (midnight), classify as early
        if t.hour < 1 and t.hour >= 0:
            return "late"  # After midnight is late
        if t.hour < 12:
            # If sleep time shows as morning, it's a night shift scenario
            # Default to 'late' for safety
            return "late"
        if t.hour < 23:
            return "early"  # Before 11 PM = early
        return "late"
    except (ValueError, TypeError):
        return "late"


def _determine_quality(whoop_score):
    """Map Whoop sleep score (0-100) to our quality categories."""
    if whoop_score is None:
        return None
    if whoop_score >= 75:
        return "good"
    elif whoop_score >= 50:
        return "average"
    else:
        return "poor"


# ── Sync logic ───────────────────────────────────────


def _extract_stage_minutes(score_obj, key):
    """Extract a sleep stage from stage_summary (milli → minutes)."""
    stages = score_obj.get("stage_summary") or {}
    ms = stages.get(key)
    if ms is not None:
        return int(ms / 60000)
    return None


def _build_whoop_data(whoop_sleep, recovery_map):
    """Build a flat dict of all Whoop fields mapped to DB columns."""
    score_obj = whoop_sleep.get("score") or {}
    sleep_score = score_obj.get("sleep_performance_percentage")

    return {
        "device_score": sleep_score,
        "respiratory_rate": score_obj.get("respiratory_rate"),
        "sleep_efficiency": score_obj.get("sleep_efficiency_percentage"),
        "sleep_consistency": score_obj.get("sleep_consistency_percentage"),
        "deep_sleep_minutes": _extract_stage_minutes(score_obj, "total_slow_wave_sleep_time_milli"),
        "light_sleep_minutes": _extract_stage_minutes(score_obj, "total_light_sleep_time_milli"),
        "rem_sleep_minutes": _extract_stage_minutes(score_obj, "total_rem_sleep_time_milli"),
        "awake_minutes": _extract_stage_minutes(score_obj, "total_awake_time_milli"),
        "disturbance_count": score_obj.get("stage_summary", {}).get("disturbance_count"),
        # Recovery data matched by date
        "recovery_score": recovery_map.get("recovery_score"),
        "resting_heart_rate": recovery_map.get("resting_heart_rate"),
        "hrv": recovery_map.get("hrv"),
    }


def _deduplicate_whoop_records(records):
    """Remove duplicate Whoop records by ID (same sleep from multiple pages)."""
    seen = set()
    unique = []
    for r in records:
        rid = r.get("id")
        if rid and rid not in seen:
            seen.add(rid)
            unique.append(r)
    return unique


def sync_sleep_data(days_back=30):
    """Fetch Whoop sleep + recovery data and sync to our database.

    Returns a dict with sync statistics.
    """
    client = WhoopClient()
    if not client.is_authenticated():
        return {"error": "Not authenticated with Whoop", "synced": 0, "created": 0, "updated": 0}

    today = datetime.now()
    from_date = (today - timedelta(days=days_back)).strftime("%Y-%m-%d")
    to_date = today.strftime("%Y-%m-%d")

    # Fetch sleep data
    sleep_records = client.get_all_sleep_data(start_date=from_date, end_date=to_date)
    if not sleep_records:
        return {"synced": 0, "created": 0, "updated": 0, "message": "No sleep records found from Whoop"}
    sleep_records = _deduplicate_whoop_records(sleep_records)

    # Fetch recovery data and index by date
    recovery_map_by_date = {}
    try:
        recovery_data = client.get_all_recovery_data(start_date=from_date, end_date=to_date)
        for r in recovery_data:
            cycle_id = r.get("cycle_id")
            score = r.get("score") or {}
            recovery_map_by_date[cycle_id] = {
                "recovery_score": score.get("recovery_score"),
                "resting_heart_rate": score.get("resting_heart_rate"),
                "hrv": score.get("hrv"),
                "spo2_percentage": score.get("spo2_percentage"),
                "skin_temp_celsius": score.get("skin_temp_celsius"),
            }
    except Exception:
        pass  # Recovery data is optional

    conn = get_connection()
    stats = {"synced": len(sleep_records), "created": 0, "updated": 0}

    for whoop_sleep in sleep_records:
        sleep_start = _parse_whoop_time(whoop_sleep.get("start"))
        sleep_end = _parse_whoop_time(whoop_sleep.get("end"))
        if not sleep_start or not sleep_end:
            continue

        record_date = sleep_end[:10]
        score_obj = whoop_sleep.get("score") or {}
        sleep_score = score_obj.get("sleep_performance_percentage")
        quality = _determine_quality(sleep_score)
        classification = _determine_classification(sleep_start)
        record_type = _detect_record_type(sleep_start, sleep_end)

        # Match recovery data by cycle_id
        recovery = recovery_map_by_date.get(whoop_sleep.get("cycle_id"), {})

        # Build full data dict
        whoop_data = {
            "device_score": sleep_score,
            "respiratory_rate": score_obj.get("respiratory_rate"),
            "sleep_efficiency": score_obj.get("sleep_efficiency_percentage"),
            "sleep_consistency": score_obj.get("sleep_consistency_percentage"),
            "deep_sleep_minutes": _extract_stage_minutes(score_obj, "total_slow_wave_sleep_time_milli"),
            "light_sleep_minutes": _extract_stage_minutes(score_obj, "total_light_sleep_time_milli"),
            "rem_sleep_minutes": _extract_stage_minutes(score_obj, "total_rem_sleep_time_milli"),
            "awake_minutes": _extract_stage_minutes(score_obj, "total_awake_time_milli"),
            "disturbance_count": score_obj.get("stage_summary", {}).get("disturbance_count"),
            "recovery_score": recovery.get("recovery_score"),
            "resting_heart_rate": recovery.get("resting_heart_rate"),
            "hrv": recovery.get("hrv"),
            "spo2_percentage": recovery.get("spo2_percentage"),
            "skin_temp_celsius": recovery.get("skin_temp_celsius"),
        }

        # Check if a Whoop night record already exists for the same sleep start.
        # Whoop may revise the wake_time of the same sleep session later, so we
        # match by (sleep_time, record_date, record_type) and update wake_time too.
        cursor = conn.execute(
            "SELECT id, device_score FROM sleep_records WHERE sleep_time = ? AND record_date = ? AND record_type = ?",
            (sleep_start, record_date, record_type),
        )
        existing = cursor.fetchone()

        if existing:
            updates = []
            params = []
            # Basic fields — always update wake_time so a revised end time wins
            updates.append("wake_time = ?")
            params.append(sleep_end)
            if sleep_score is not None:
                updates.append("device_score = ?")
                params.append(sleep_score)
            if classification:
                updates.append("classification = ?")
                params.append(classification)
            if quality:
                updates.append("sleep_quality = ?")
                params.append(quality)
            # Whoop health metrics
            for col in ("respiratory_rate", "sleep_efficiency", "sleep_consistency",
                        "deep_sleep_minutes", "light_sleep_minutes", "rem_sleep_minutes",
                        "awake_minutes", "disturbance_count", "recovery_score",
                        "resting_heart_rate", "hrv", "spo2_percentage",
                        "skin_temp_celsius"):
                val = whoop_data.get(col)
                if val is not None:
                    updates.append(f"{col} = ?")
                    params.append(val)
            params.append(existing["id"])
            conn.execute(
                f"UPDATE sleep_records SET {', '.join(updates)} WHERE id = ?",
                params,
            )
            stats["updated"] += 1
        else:
            sleep_problems = []
            if quality and quality != "good" and sleep_score is not None and sleep_score < 40:
                sleep_problems.append("insomnia")

            conn.execute(
                """INSERT INTO sleep_records
                   (record_date, record_type, sleep_time, wake_time,
                    classification, sleep_quality, sleep_problems, device_score,
                    respiratory_rate, sleep_efficiency, sleep_consistency,
                    deep_sleep_minutes, light_sleep_minutes, rem_sleep_minutes,
                    awake_minutes, disturbance_count,
                    recovery_score, resting_heart_rate, hrv,
                    spo2_percentage, skin_temp_celsius)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?,
                           ?, ?, ?, ?, ?, ?, ?, ?,
                           ?, ?, ?, ?, ?)""",
                (
                    record_date, record_type, sleep_start, sleep_end,
                    classification, quality or "average",
                    json.dumps(sleep_problems), sleep_score,
                    whoop_data["respiratory_rate"],
                    whoop_data["sleep_efficiency"],
                    whoop_data["sleep_consistency"],
                    whoop_data["deep_sleep_minutes"],
                    whoop_data["light_sleep_minutes"],
                    whoop_data["rem_sleep_minutes"],
                    whoop_data["awake_minutes"],
                    whoop_data["disturbance_count"],
                    whoop_data["recovery_score"],
                    whoop_data["resting_heart_rate"],
                    whoop_data["hrv"],
                    whoop_data["spo2_percentage"],
                    whoop_data["skin_temp_celsius"],
                ),
            )
            stats["created"] += 1

    conn.commit()
    conn.close()
    return stats


def sync_profile():
    """Fetch Whoop profile and return basic info (for display)."""
    client = WhoopClient()
    if not client.is_authenticated():
        return None
    try:
        return client.get_profile()
    except Exception:
        return None


# Common Whoop sport IDs → human-readable names (best-effort; unknown → "训练")
COMMON_SPORTS = {
    0: "其他",
    1: "跑步",
    2: "步行",
    3: "骑行",
    4: "游泳",
    5: "划船",
    6: "篮球",
    7: "足球",
    9: "网球",
    10: "交叉训练",
    11: "登山",
    13: "力量训练",
    14: "动感单车",
    15: "椭圆机",
    16: "普拉提",
    17: "瑜伽",
    18: "高尔夫",
    19: "拳击",
    20: "HIIT",
    21: "舞蹈",
    22: "爬山",
    24: "滑雪",
    25: "单板滑雪",
    26: "冲浪",
    28: "跳绳",
    29: "拉伸",
    32: "攀岩",
    33: "慢跑",
    43: "功能性训练",
    44: "冥想",
}


def _sport_name(sport_id):
    if sport_id is None:
        return "训练"
    return COMMON_SPORTS.get(int(sport_id), f"训练({sport_id})")


def _date_from_ts(ts_str):
    """Extract local YYYY-MM-DD from a Whoop ISO timestamp."""
    s = _parse_whoop_time(ts_str)
    return s[:10] if s else None


def sync_daily_metrics(days_back=30):
    """Sync Whoop recovery (full) + daily strain/HR into whoop_daily_metrics (keyed by date)."""
    client = WhoopClient()
    if not client.is_authenticated():
        return {"error": "Not authenticated with Whoop", "synced": 0}

    today = datetime.now()
    from_date = (today - timedelta(days=days_back)).strftime("%Y-%m-%d")
    to_date = today.strftime("%Y-%m-%d")

    # 1) Cycles → daily strain / kilojoule / HR (keyed by cycle date)
    daily = {}
    try:
        cycles = client.get_all_cycle_data(start_date=from_date, end_date=to_date)
        for c in cycles:
            d = _date_from_ts(c.get("end"))
            if not d:
                # 进行中的周期 end 为 None → 归到今天（本地日期）
                d = today.strftime("%Y-%m-%d")
            score = c.get("score") or {}
            row = daily.setdefault(d, {})
            row["strain"] = score.get("strain")
            row["kilojoule"] = score.get("kilojoule")
            row["avg_heart_rate"] = score.get("average_heart_rate")
            row["max_heart_rate"] = score.get("max_heart_rate")
            # remember cycle_id → date for recovery mapping
            daily.setdefault("_cycle_date", {})[c.get("id")] = d
    except Exception as e:
        print(f"[sync_daily_metrics] cycle fetch failed: {e}")

    cycle_date = daily.pop("_cycle_date", {})

    # 2) Recovery → recovery_score / RHR / HRV / SpO2 / skin temp
    try:
        recovery = client.get_all_recovery_data(start_date=from_date, end_date=to_date)
        for r in recovery:
            cid = r.get("cycle_id")
            # 恢复分数优先用其自身创建时间（= 醒来当天的日期，与睡眠卡片一致）；
            # 仅当 created_at 缺失时才退回 cycle 的 end 日期。
            d = _date_from_ts(r.get("created_at"))
            if not d:
                d = cycle_date.get(cid)
            if not d:
                continue
            score = r.get("score") or {}
            row = daily.setdefault(d, {})
            row["recovery_score"] = score.get("recovery_score")
            row["resting_heart_rate"] = score.get("resting_heart_rate")
            row["hrv"] = score.get("hrv_rmssd_milli")
            row["spo2_percentage"] = score.get("spo2_percentage")
            row["skin_temp_celsius"] = score.get("skin_temp_celsius")
    except Exception as e:
        print(f"[sync_daily_metrics] recovery fetch failed: {e}")

    conn = get_connection()
    synced = 0
    for d, row in daily.items():
        conn.execute(
            """INSERT OR REPLACE INTO whoop_daily_metrics
               (record_date, recovery_score, resting_heart_rate, hrv,
                spo2_percentage, skin_temp_celsius, strain, kilojoule,
                avg_heart_rate, max_heart_rate, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))""",
            (
                d,
                row.get("recovery_score"),
                row.get("resting_heart_rate"),
                row.get("hrv"),
                row.get("spo2_percentage"),
                row.get("skin_temp_celsius"),
                row.get("strain"),
                row.get("kilojoule"),
                row.get("avg_heart_rate"),
                row.get("max_heart_rate"),
            ),
        )
        synced += 1
    conn.commit()
    conn.close()
    return {"synced": synced}


def sync_workouts(days_back=30):
    """Sync Whoop workout sessions into whoop_workouts."""
    client = WhoopClient()
    if not client.is_authenticated():
        return {"error": "Not authenticated with Whoop", "synced": 0}

    today = datetime.now()
    from_date = (today - timedelta(days=days_back)).strftime("%Y-%m-%d")
    to_date = today.strftime("%Y-%m-%d")

    try:
        workouts = client.get_all_workout_data(start_date=from_date, end_date=to_date)
    except Exception as e:
        return {"error": f"Workout fetch failed: {e}", "synced": 0}

    conn = get_connection()
    synced = 0
    for w in workouts:
        wid = str(w.get("id"))
        start = _parse_whoop_time(w.get("start"))
        record_date = (start[:10] if start else None) or _date_from_ts(w.get("end"))
        if not record_date:
            continue
        score = w.get("score") or {}
        conn.execute(
            """INSERT OR REPLACE INTO whoop_workouts
               (id, record_date, sport_name, strain, avg_heart_rate,
                max_heart_rate, kilojoule, distance_meter, altitude_gain_meter,
                start_time, end_time, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))""",
            (
                wid,
                record_date,
                _sport_name(w.get("sport_id")),
                score.get("strain"),
                score.get("average_heart_rate"),
                score.get("max_heart_rate"),
                score.get("kilojoule"),
                score.get("distance_meter"),
                score.get("altitude_gain_meter"),
                start or "",
                _parse_whoop_time(w.get("end")) or "",
            ),
        )
        synced += 1
    conn.commit()
    conn.close()
    return {"synced": synced}


def sync_all_whoop(days_back=30):
    """Run all Whoop syncs and return combined stats."""
    sleep_stats = sync_sleep_data(days_back)
    daily_stats = sync_daily_metrics(days_back)
    workout_stats = sync_workouts(days_back)

    # Aggregate top-level counts for the UI message.
    created = (
        sleep_stats.get("created", 0)
        + daily_stats.get("synced", 0)
        + workout_stats.get("synced", 0)
    )
    updated = sleep_stats.get("updated", 0)
    synced = (
        sleep_stats.get("synced", 0)
        + daily_stats.get("synced", 0)
        + workout_stats.get("synced", 0)
    )

    stats = {
        "created": created,
        "updated": updated,
        "synced": synced,
        "sleep": sleep_stats,
        "daily": daily_stats,
        "workouts": workout_stats,
    }
    return stats
