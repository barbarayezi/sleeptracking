"""
Data access layer for menstrual / period (cycle) records.

Tracks individual period days (flow, symptoms, mood, notes) and computes
cycle statistics + predictions (next period, ovulation, current phase) from
the days marked as period-start.

Works with both local SQLite and Turso (cloud SQLite).
"""

import json
from datetime import date, timedelta
from database import get_connection


def row_to_dict(row):
    """Convert a sqlite3.Row (or TursoRow) to a plain dict with parsed JSON fields."""
    if row is None:
        return None
    d = dict(row)
    # Parse JSON fields (symptoms / mood may be JSON arrays)
    for f in ("symptoms", "mood"):
        val = d.get(f)
        if val:
            try:
                d[f] = json.loads(val)
            except (json.JSONDecodeError, TypeError):
                d[f] = []
        else:
            d[f] = []
    # is_period_start is stored as int (0/1) in SQLite/Turso
    d["is_period_start"] = bool(d.get("is_period_start"))
    return d


# ── Query helpers ───────────────────────────────


def get_all_periods(from_date=None, to_date=None, date=None):
    """Return period records, optionally filtered by date range or a single date.

    Args:
        from_date: ISO date string lower bound (inclusive)
        to_date:   ISO date string upper bound (inclusive)
        date:      ISO date string for exact match on a single day

    Returns:
        List of period dicts ordered by record_date ASC.
    """
    conn = get_connection()
    query = "SELECT * FROM period_records"
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

    query += " ORDER BY record_date ASC"
    cursor = conn.execute(query, params)
    rows = cursor.fetchall()
    conn.close()
    return [row_to_dict(r) for r in rows]


def get_period_by_id(period_id):
    """Return a single period record by ID, or None."""
    conn = get_connection()
    cursor = conn.execute("SELECT * FROM period_records WHERE id = ?", (period_id,))
    row = cursor.fetchone()
    conn.close()
    return row_to_dict(row)


def get_periods_by_date(record_date):
    """Return all period records for a given date (may be empty list)."""
    return get_all_periods(date=record_date)


# ── CRUD operations ───────────────────────────────


def create_period(data):
    """Insert a new period record. Returns the created dict."""
    conn = get_connection()

    symptoms = json.dumps(data.get("symptoms", []), ensure_ascii=False)
    mood = json.dumps(data.get("mood", []), ensure_ascii=False)
    is_start = 1 if data.get("is_period_start") else 0

    cursor = conn.execute(
        """
        INSERT INTO period_records
            (record_date, is_period_start, flow, symptoms, mood, phase, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            data["record_date"],
            is_start,
            data.get("flow", "none"),
            symptoms,
            mood,
            data.get("phase", ""),
            data.get("notes", ""),
        ),
    )

    pid = cursor.lastrowid
    conn.commit()

    cursor = conn.execute("SELECT * FROM period_records WHERE id = ?", (pid,))
    row = cursor.fetchone()
    conn.close()
    return row_to_dict(row)


def update_period_by_id(period_id, data):
    """Update an existing period record by ID. Returns updated dict or None."""
    conn = get_connection()
    cursor = conn.execute("SELECT * FROM period_records WHERE id = ?", (period_id,))
    existing = cursor.fetchone()
    if not existing:
        conn.close()
        return None

    fields = []
    params = []

    if "record_date" in data:
        fields.append("record_date = ?")
        params.append(data["record_date"])
    if "is_period_start" in data:
        fields.append("is_period_start = ?")
        params.append(1 if data["is_period_start"] else 0)
    if "flow" in data:
        fields.append("flow = ?")
        params.append(data["flow"])
    if "symptoms" in data:
        fields.append("symptoms = ?")
        params.append(json.dumps(data["symptoms"], ensure_ascii=False))
    if "mood" in data:
        fields.append("mood = ?")
        params.append(json.dumps(data["mood"], ensure_ascii=False))
    if "phase" in data:
        fields.append("phase = ?")
        params.append(data["phase"])
    if "notes" in data:
        fields.append("notes = ?")
        params.append(data["notes"])

    fields.append("updated_at = datetime('now', 'localtime')")
    params.append(period_id)

    conn.execute(
        f"UPDATE period_records SET {', '.join(fields)} WHERE id = ?",
        params,
    )
    conn.commit()

    cursor = conn.execute("SELECT * FROM period_records WHERE id = ?", (period_id,))
    row = cursor.fetchone()
    conn.close()
    return row_to_dict(row)


def delete_period_by_id(period_id):
    """Delete a period record by ID. Returns True if deleted, False if not found."""
    conn = get_connection()
    cursor = conn.execute("DELETE FROM period_records WHERE id = ?", (period_id,))
    deleted = cursor.rowcount > 0
    conn.commit()
    conn.close()
    return deleted


# ── Cycle prediction ────────────────────────────


def get_cycle_summary(today=None):
    """Compute cycle statistics and predictions from period-start days.

    Returns a dict with:
        has_data, avg_cycle_length, last_period_start,
        next_period_prediction, ovulation_prediction, current_phase,
        days_until_next, days_into_cycle, cycle_length_samples, period_length
    """
    if today is None:
        today = date.today()

    conn = get_connection()
    cursor = conn.execute(
        "SELECT record_date FROM period_records WHERE is_period_start = 1 ORDER BY record_date ASC"
    )
    start_dates = [r[0] for r in cursor.fetchall()]
    cursor = conn.execute(
        "SELECT record_date, flow FROM period_records "
        "WHERE flow IS NOT NULL AND flow != 'none' ORDER BY record_date ASC"
    )
    flow_days = {r[0]: r[1] for r in cursor.fetchall()}
    conn.close()

    if not start_dates:
        return {
            "has_data": False,
            "avg_cycle_length": None,
            "last_period_start": None,
            "next_period_prediction": None,
            "ovulation_prediction": None,
            "current_phase": None,
            "days_until_next": None,
            "days_into_cycle": None,
            "cycle_length_samples": 0,
            "period_length": None,
        }

    starts = [date.fromisoformat(d) for d in start_dates if isinstance(d, str)]

    # Cycle lengths = gaps between consecutive period-start days (sanity filtered)
    gaps = [(starts[i + 1] - starts[i]).days for i in range(len(starts) - 1)]
    gaps = [g for g in gaps if 15 <= g <= 60]
    avg_cycle = round(sum(gaps) / len(gaps)) if gaps else 45  # sensible fallback

    last_start = starts[-1]
    days_into = (today - last_start).days

    # Estimate menstrual (bleeding) length from flow days starting at last_start
    menstrual_len = 5
    cnt = 0
    d = last_start
    limit = avg_cycle if avg_cycle else 40
    while (d - last_start).days < limit:
        key = d.isoformat()
        if flow_days.get(key) and flow_days[key] != "none":
            cnt += 1
        elif cnt > 0:
            break
        d += timedelta(days=1)
    if cnt >= 2:
        menstrual_len = cnt

    # Predictions
    next_start = last_start + timedelta(days=avg_cycle)
    ovulation = next_start - timedelta(days=14)
    days_until_next = (next_start - today).days

    # Current phase within the cycle
    if days_into < 0:
        current_phase = None
    elif days_into < menstrual_len:
        current_phase = "menstrual"
    else:
        ovulation_day = avg_cycle - 14  # days into cycle when ovulation occurs
        if abs(days_into - ovulation_day) <= 2:
            current_phase = "ovulation"
        elif days_into < ovulation_day:
            current_phase = "follicular"
        else:
            current_phase = "luteal"

    return {
        "has_data": True,
        "avg_cycle_length": avg_cycle,
        "last_period_start": last_start.isoformat(),
        "next_period_prediction": next_start.isoformat(),
        "ovulation_prediction": ovulation.isoformat(),
        "current_phase": current_phase,
        "days_until_next": days_until_next,
        "days_into_cycle": days_into,
        "cycle_length_samples": len(gaps),
        "period_length": menstrual_len,
    }
