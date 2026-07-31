"""
Data access layer for sleep records.
All CRUD operations against the sleep_records table.
Works with both local SQLite and Turso (cloud SQLite).
"""

import json
from datetime import datetime, date
from database import get_connection


def row_to_dict(row):
    """Convert a sqlite3.Row (or TursoRow) to a plain dict with parsed JSON fields."""
    if row is None:
        return None
    d = dict(row)
    # Parse sleep_problems from JSON string to list
    if d.get("sleep_problems"):
        try:
            d["sleep_problems"] = json.loads(d["sleep_problems"])
        except (json.JSONDecodeError, TypeError):
            d["sleep_problems"] = []
    else:
        d["sleep_problems"] = []
    return d


# ── Query helpers ─────────────────────────────────


def get_all_records(from_date=None, to_date=None, date=None):
    """Return all sleep records, optionally filtered by date range or a specific date.

    Args:
        from_date: ISO date string for lower bound (inclusive)
        to_date: ISO date string for upper bound (inclusive)
        date: ISO date string for exact match on a single date

    Returns:
        List of record dicts, ordered by record_date DESC then record_type.
    """
    conn = get_connection()

    query = "SELECT * FROM sleep_records"
    params = []
    conditions = []

    if date:
        conditions.append("record_date = ?")
        params.append(date)
    else:
        if from_date:
            conditions.append("record_date >= ?")
            params.append(from_date)
        if to_date:
            conditions.append("record_date <= ?")
            params.append(to_date)

    if conditions:
        query += " WHERE " + " AND ".join(conditions)

    query += """
        ORDER BY record_date DESC,
            CASE record_type
                WHEN 'night' THEN 1
                WHEN 'segment' THEN 2
                WHEN 'nap' THEN 3
            END
    """

    cursor = conn.execute(query, params)
    rows = cursor.fetchall()
    conn.close()
    return [row_to_dict(r) for r in rows]


def get_record_by_id(record_id):
    """Return a single record by its ID, or None if not found."""
    conn = get_connection()
    cursor = conn.execute("SELECT * FROM sleep_records WHERE id = ?", (record_id,))
    row = cursor.fetchone()
    conn.close()
    return row_to_dict(row)


def get_records_by_date(record_date):
    """Return all records for a given date. Returns a list (may be empty)."""
    return get_all_records(date=record_date)


def get_record_by_date(record_date):
    """Return the first (night) record for a date, or None.
    Kept for backward compatibility; prefer get_records_by_date().
    """
    records = get_records_by_date(record_date)
    return records[0] if records else None


# ── CRUD operations ───────────────────────────────


def create_record(data):
    """Insert a new sleep record. Returns the created record dict."""
    conn = get_connection()

    sleep_problems = json.dumps(data.get("sleep_problems", []), ensure_ascii=False)
    record_type = data.get("record_type", "night")

    cursor = conn.execute(
        """
        INSERT INTO sleep_records
            (record_date, record_type, sleep_time, wake_time, classification,
             sleep_quality, sleep_problems, dream_journal, weight, water_cups, steps, device_score,
             respiratory_rate, sleep_efficiency, sleep_consistency,
             deep_sleep_minutes, light_sleep_minutes, rem_sleep_minutes, awake_minutes,
             disturbance_count, recovery_score, resting_heart_rate, hrv)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            data["record_date"],
            record_type,
            data["sleep_time"],
            data["wake_time"],
            data["classification"],
            data["sleep_quality"],
            sleep_problems,
            data.get("dream_journal", ""),
            data.get("weight"),
            data.get("water_cups"),
            data.get("steps"),
            data.get("device_score"),
            data.get("respiratory_rate"),
            data.get("sleep_efficiency"),
            data.get("sleep_consistency"),
            data.get("deep_sleep_minutes"),
            data.get("light_sleep_minutes"),
            data.get("rem_sleep_minutes"),
            data.get("awake_minutes"),
            data.get("disturbance_count"),
            data.get("recovery_score"),
            data.get("resting_heart_rate"),
            data.get("hrv"),
        ),
    )

    record_id = cursor.lastrowid
    conn.commit()

    # Read back by id (works reliably with both SQLite and Turso)
    cursor = conn.execute("SELECT * FROM sleep_records WHERE id = ?", (record_id,))
    row = cursor.fetchone()
    conn.close()
    return row_to_dict(row)


def update_record_by_id(record_id, data):
    """Update an existing sleep record by ID. Returns the updated record dict or None."""
    conn = get_connection()

    # Check record exists
    cursor = conn.execute("SELECT * FROM sleep_records WHERE id = ?", (record_id,))
    existing = cursor.fetchone()
    if not existing:
        conn.close()
        return None

    sleep_problems = json.dumps(data.get("sleep_problems", []), ensure_ascii=False)

    # Build SET clause dynamically for partial updates
    fields = []
    params = []

    if "record_date" in data:
        fields.append("record_date = ?")
        params.append(data["record_date"])
    if "sleep_time" in data:
        fields.append("sleep_time = ?")
        params.append(data["sleep_time"])
    if "wake_time" in data:
        fields.append("wake_time = ?")
        params.append(data["wake_time"])
    if "classification" in data:
        fields.append("classification = ?")
        params.append(data["classification"])
    if "sleep_quality" in data:
        fields.append("sleep_quality = ?")
        params.append(data["sleep_quality"])
    if "record_type" in data:
        fields.append("record_type = ?")
        params.append(data["record_type"])
    if "dream_journal" in data:
        fields.append("dream_journal = ?")
        params.append(data["dream_journal"])
    if "weight" in data:
        fields.append("weight = ?")
        params.append(data["weight"])
    if "water_cups" in data:
        fields.append("water_cups = ?")
        params.append(data["water_cups"])
    if "steps" in data:
        fields.append("steps = ?")
        params.append(data["steps"])
    if "device_score" in data:
        fields.append("device_score = ?")
        params.append(data["device_score"])

    # Whoop health metrics
    for col in ("respiratory_rate", "sleep_efficiency", "sleep_consistency",
                "deep_sleep_minutes", "light_sleep_minutes", "rem_sleep_minutes",
                "awake_minutes", "disturbance_count", "recovery_score",
                "resting_heart_rate", "hrv"):
        if col in data:
            fields.append(f"{col} = ?")
            params.append(data[col])

    fields.append("sleep_problems = ?")
    params.append(sleep_problems)
    fields.append("updated_at = datetime('now', 'localtime')")
    params.append(record_id)

    conn.execute(
        f"UPDATE sleep_records SET {', '.join(fields)} WHERE id = ?",
        params,
    )

    conn.commit()

    # Read back
    cursor = conn.execute("SELECT * FROM sleep_records WHERE id = ?", (record_id,))
    row = cursor.fetchone()
    conn.close()
    return row_to_dict(row)


def update_record(record_date, data):
    """Update the first (night) record for a date. Kept for backward compatibility."""
    records = get_records_by_date(record_date)
    if not records:
        return None
    return update_record_by_id(records[0]["id"], data)


def delete_record_by_id(record_id):
    """Delete a sleep record by ID. Returns True if deleted, False if not found."""
    conn = get_connection()
    cursor = conn.execute("DELETE FROM sleep_records WHERE id = ?", (record_id,))
    deleted = cursor.rowcount > 0
    conn.commit()
    conn.close()
    return deleted


def delete_record(record_date):
    """Delete all records for a date. Kept for backward compatibility.
    Returns True if any were deleted."""
    conn = get_connection()
    cursor = conn.execute("DELETE FROM sleep_records WHERE record_date = ?", (record_date,))
    deleted = cursor.rowcount > 0
    conn.commit()
    conn.close()
    return deleted