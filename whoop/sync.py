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
from sleep_traking.database import get_connection
from sleep_traking.whoop.client import WhoopClient


# ── Helpers ──────────────────────────────────────────


def _parse_whoop_time(ts_str):
    """Parse Whoop ISO timestamp to our format YYYY-MM-DDTHH:MM."""
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


def sync_sleep_data(days_back=30):
    """Fetch Whoop sleep data and sync to our database.

    Returns a dict with sync statistics.
    """
    client = WhoopClient()
    if not client.is_authenticated():
        return {"error": "Not authenticated with Whoop", "synced": 0, "created": 0, "updated": 0}

    # Calculate date range
    today = datetime.now()
    from_date = (today - timedelta(days=days_back)).strftime("%Y-%m-%d")
    to_date = today.strftime("%Y-%m-%d")

    # Fetch sleep data from Whoop
    sleep_records = client.get_all_sleep_data(start_date=from_date, end_date=to_date)

    if not sleep_records:
        return {"synced": 0, "created": 0, "updated": 0, "message": "No sleep records found from Whoop"}

    conn = get_connection()
    stats = {"synced": len(sleep_records), "created": 0, "updated": 0}

    for whoop_sleep in sleep_records:
        # Parse timestamps
        sleep_id = whoop_sleep.get("id")
        sleep_start = _parse_whoop_time(whoop_sleep.get("start"))
        sleep_end = _parse_whoop_time(whoop_sleep.get("end"))

        if not sleep_start or not sleep_end:
            continue

        # Get the wake_time date (this becomes our record_date)
        record_date = sleep_end[:10]
        sleep_score = whoop_sleep.get("score")
        quality = _determine_quality(sleep_score)
        classification = _determine_classification(sleep_start)
        record_type = _detect_record_type(sleep_start, sleep_end)

        # Check if we already have a record for this sleep_time range
        cursor = conn.execute(
            "SELECT id, device_score FROM sleep_records WHERE sleep_time = ? AND wake_time = ?",
            (sleep_start, sleep_end),
        )
        existing = cursor.fetchone()

        if existing:
            # Update existing record with Whoop data
            updates = []
            params = []
            if sleep_score is not None:
                updates.append("device_score = ?")
                params.append(sleep_score)

            # Also update record_type, classification, sleep_quality if not set or if WHOOP is more reliable
            if classification:
                updates.append("classification = ?")
                params.append(classification)
            if quality:
                updates.append("sleep_quality = ?")
                params.append(quality)
            if record_type:
                updates.append("record_type = ?")
                params.append(record_type)

            if updates:
                params.append(existing["id"])
                conn.execute(
                    f"UPDATE sleep_records SET {', '.join(updates)} WHERE id = ?",
                    params,
                )
                stats["updated"] += 1
        else:
            # Create new record
            sleep_problems = []
            if quality and quality != "good":
                # Infer potential sleep problems from score
                if sleep_score is not None and sleep_score < 40:
                    sleep_problems.append("insomnia")

            conn.execute(
                """INSERT INTO sleep_records
                   (record_date, record_type, sleep_time, wake_time,
                    classification, sleep_quality, sleep_problems, device_score)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    record_date,
                    record_type,
                    sleep_start,
                    sleep_end,
                    classification,
                    quality or "average",
                    json.dumps(sleep_problems),
                    sleep_score,
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
