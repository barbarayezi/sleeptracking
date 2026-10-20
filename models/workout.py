"""
Data access layer for manual workout check-ins (dance classes etc.).

Why this exists alongside whoop_workouts: the Whoop band already captures the
physiological load (strain / HR / kJ) of a dance class automatically, but it
has no idea the session was "Jazz 新手入门" or that you learned 2 个八拍.
This table carries the human label; analysis joins the two by date.

Works with both local SQLite and Turso (cloud SQLite).
"""

from datetime import date as _date, timedelta as _td

from database import get_connection

WORKOUT_TYPES = ('jazz', 'hiphop', 'kpop', 'urban', 'breaking', 'other')
INTENSITIES = ('low', 'medium', 'high')

TYPE_LABELS = {
    'jazz':    '💃 Jazz',
    'hiphop':  '🕺 Hiphop',
    'kpop':    '🎤 K-pop',
    'urban':   '🌆 Urban',
    'breaking': '🌀 Breaking',
    'other':   '🏃 其他',
}

INTENSITY_LABELS = {'low': '轻松', 'medium': '中等', 'high': '高强度'}


def row_to_dict(row):
    if row is None:
        return None
    return dict(row)


# ── Query helpers ─────────────────────────────────


def get_all_workouts(from_date=None, to_date=None, date=None):
    """Return check-ins ordered by date DESC, id ASC. Optional date filters."""
    conn = get_connection()
    query = "SELECT * FROM workout_checkins"
    params, conditions = [], []
    if date:
        conditions.append("workout_date = ?")
        params.append(date)
    else:
        if from_date:
            conditions.append("workout_date >= ?")
            params.append(from_date)
        if to_date:
            conditions.append("workout_date <= ?")
            params.append(to_date)
    if conditions:
        query += " WHERE " + " AND ".join(conditions)
    query += " ORDER BY workout_date DESC, id ASC"
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [row_to_dict(r) for r in rows]


def get_workout_by_id(workout_id):
    conn = get_connection()
    row = conn.execute("SELECT * FROM workout_checkins WHERE id = ?", (workout_id,)).fetchone()
    conn.close()
    return row_to_dict(row)


def get_whoop_workouts_by_date(workout_date):
    """Same-day Whoop sessions for auto-attaching strain/HR to a check-in."""
    conn = get_connection()
    rows = conn.execute(
        "SELECT sport_name, strain, avg_heart_rate, max_heart_rate, kilojoule,"
        "       start_time, end_time FROM whoop_workouts WHERE record_date = ?"
        " ORDER BY start_time",
        (workout_date,),
    ).fetchall()
    conn.close()
    return [row_to_dict(r) for r in rows]


# ── CRUD ──────────────────────────────────────────


def create_workout(data):
    conn = get_connection()
    cursor = conn.execute(
        """
        INSERT INTO workout_checkins
            (workout_date, workout_type, duration_min, intensity, content, notes)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            data["workout_date"],
            data.get("workout_type", "other"),
            int(data.get("duration_min", 60)),
            data.get("intensity", "medium"),
            data.get("content", ""),
            data.get("notes", ""),
        ),
    )
    wid = cursor.lastrowid
    conn.commit()
    row = conn.execute("SELECT * FROM workout_checkins WHERE id = ?", (wid,)).fetchone()
    conn.close()
    return row_to_dict(row)


def update_workout_by_id(workout_id, data):
    conn = get_connection()
    existing = conn.execute(
        "SELECT * FROM workout_checkins WHERE id = ?", (workout_id,)
    ).fetchone()
    if not existing:
        conn.close()
        return None

    fields, params = [], []
    if "workout_date" in data:
        fields.append("workout_date = ?")
        params.append(data["workout_date"])
    if "workout_type" in data:
        fields.append("workout_type = ?")
        params.append(data["workout_type"])
    if "duration_min" in data:
        fields.append("duration_min = ?")
        params.append(int(data["duration_min"]))
    if "intensity" in data:
        fields.append("intensity = ?")
        params.append(data["intensity"])
    if "content" in data:
        fields.append("content = ?")
        params.append(data["content"])
    if "notes" in data:
        fields.append("notes = ?")
        params.append(data["notes"])

    if not fields:
        conn.close()
        return row_to_dict(existing)

    fields.append("updated_at = datetime('now', 'localtime')")
    params.append(workout_id)
    conn.execute(f"UPDATE workout_checkins SET {', '.join(fields)} WHERE id = ?", params)
    conn.commit()
    row = conn.execute("SELECT * FROM workout_checkins WHERE id = ?", (workout_id,)).fetchone()
    conn.close()
    return row_to_dict(row)


def delete_workout_by_id(workout_id):
    conn = get_connection()
    cursor = conn.execute("DELETE FROM workout_checkins WHERE id = ?", (workout_id,))
    deleted = cursor.rowcount > 0
    conn.commit()
    conn.close()
    return deleted


# ── Summary ───────────────────────────────────────


def _current_streak(dates_set, anchor=None):
    """Consecutive-day streak ending at anchor (default today)."""
    cur = anchor or _date.today()
    streak = 0
    while cur.isoformat() in dates_set:
        streak += 1
        cur -= _td(days=1)
    return streak


def get_workout_summary(days=30, anchor=None):
    """Aggregate check-ins for dashboards / hero strip.

    Returns totals, per-type counts, streaks and a per-day map of the last
    `days` days. `anchor` defaults to today (YYYY-MM-DD string).
    """
    anchor_date = _date.fromisoformat(anchor) if anchor else _date.today()
    to_date = anchor_date.isoformat()
    from_date = (anchor_date - _td(days=days - 1)).isoformat()

    records = get_all_workouts(from_date=from_date, to_date=to_date)
    # Streaks look further back than the display window.
    all_dates = {r["workout_date"] for r in get_all_workouts(to_date=to_date)}

    by_type, per_day = {}, {}
    total_min = 0
    for r in records:
        t = r.get("workout_type") or "other"
        by_type[t] = by_type.get(t, 0) + 1
        dur = r.get("duration_min") or 0
        total_min += dur
        d = r["workout_date"]
        agg = per_day.setdefault(d, {"count": 0, "minutes": 0, "types": []})
        agg["count"] += 1
        agg["minutes"] += dur
        agg["types"].append(t)

    week_start = (anchor_date - _td(days=anchor_date.weekday())).isoformat()
    week_records = [r for r in records if r["workout_date"] >= week_start]

    return {
        "from": from_date,
        "to": to_date,
        "total_sessions": len(records),
        "total_minutes": total_min,
        "by_type": by_type,
        "current_streak": _current_streak(all_dates, anchor_date),
        "this_week_sessions": len(week_records),
        "this_week_minutes": sum((r.get("duration_min") or 0) for r in week_records),
        "per_day": per_day,
        "type_labels": TYPE_LABELS,
    }
