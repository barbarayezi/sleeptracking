"""
Data access layer for medication records.

One row per (date, name, dosage) makes sense for medication because the user
can record "鱼油 2 粒" and "解郁除烦胶囊 3 粒" at different times on the same
day — each entry is independent, not "one record per day".

Works with both local SQLite and Turso (cloud SQLite).
"""

from database import get_connection


def row_to_dict(row):
    """Convert a sqlite3.Row (or TursoRow) to a plain dict."""
    if row is None:
        return None
    return dict(row)


# ── Query helpers ─────────────────────────────────


def get_all_medications(from_date=None, to_date=None, date=None):
    """Return medication records, optionally filtered by date range or one day.

    Args:
        from_date: ISO date string lower bound (inclusive)
        to_date:   ISO date string upper bound (inclusive)
        date:      ISO date string for exact match on a single day

    Returns:
        List of dicts ordered by record_date DESC, then by record_time ASC, then by id ASC.
    """
    conn = get_connection()

    query = "SELECT * FROM medication_records"
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

    query += " ORDER BY record_date DESC, record_time ASC, id ASC"

    cursor = conn.execute(query, params)
    rows = cursor.fetchall()
    conn.close()
    return [row_to_dict(r) for r in rows]


def get_medication_by_id(med_id):
    """Return a single medication record by ID, or None."""
    conn = get_connection()
    cursor = conn.execute("SELECT * FROM medication_records WHERE id = ?", (med_id,))
    row = cursor.fetchone()
    conn.close()
    return row_to_dict(row)


def get_medications_by_date(record_date):
    """Return all medication records for the given date."""
    return get_all_medications(date=record_date)


# ── CRUD operations ───────────────────────────────


def create_medication(data):
    """Insert a new medication record. Returns the created dict."""
    conn = get_connection()

    cursor = conn.execute(
        """
        INSERT INTO medication_records
            (record_date, record_time, medication_name, dosage,
             dosage_unit, category, administration_slot, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            data["record_date"],
            data.get("record_time", "08:00"),
            data["medication_name"],
            float(data.get("dosage", 1)),
            data.get("dosage_unit", "粒"),
            data.get("category", "supplement"),
            data.get("administration_slot", "morning"),
            data.get("notes", ""),
        ),
    )
    med_id = cursor.lastrowid
    conn.commit()

    # Read back by id
    cursor = conn.execute("SELECT * FROM medication_records WHERE id = ?", (med_id,))
    row = cursor.fetchone()
    conn.close()
    return row_to_dict(row)


def update_medication_by_id(med_id, data):
    """Partial update by ID. Returns the updated dict or None if missing."""
    conn = get_connection()

    cursor = conn.execute("SELECT * FROM medication_records WHERE id = ?", (med_id,))
    existing = cursor.fetchone()
    if not existing:
        conn.close()
        return None

    fields = []
    params = []

    if "record_date" in data:
        fields.append("record_date = ?")
        params.append(data["record_date"])
    if "record_time" in data:
        fields.append("record_time = ?")
        params.append(data["record_time"])
    if "medication_name" in data:
        fields.append("medication_name = ?")
        params.append(data["medication_name"])
    if "dosage" in data:
        fields.append("dosage = ?")
        params.append(float(data["dosage"]))
    if "dosage_unit" in data:
        fields.append("dosage_unit = ?")
        params.append(data["dosage_unit"])
    if "category" in data:
        fields.append("category = ?")
        params.append(data["category"])
    if "administration_slot" in data:
        fields.append("administration_slot = ?")
        params.append(data["administration_slot"])
    if "notes" in data:
        fields.append("notes = ?")
        params.append(data["notes"])

    if not fields:
        # Nothing to update — return the existing row untouched so a no-op
        # PUT still reports success.
        conn.close()
        return row_to_dict(existing)

    fields.append("updated_at = datetime('now', 'localtime')")
    params.append(med_id)

    conn.execute(
        f"UPDATE medication_records SET {', '.join(fields)} WHERE id = ?",
        params,
    )
    conn.commit()

    cursor = conn.execute("SELECT * FROM medication_records WHERE id = ?", (med_id,))
    row = cursor.fetchone()
    conn.close()
    return row_to_dict(row)


def delete_medication_by_id(med_id):
    """Delete a medication record by ID. Returns True when a row was removed."""
    conn = get_connection()
    cursor = conn.execute("DELETE FROM medication_records WHERE id = ?", (med_id,))
    deleted = cursor.rowcount > 0
    conn.commit()
    conn.close()
    return deleted


# ── Daily roll-up helper ─────────────────────────


def get_daily_medication_summary(record_date):
    """Build a per-day rollup for the dashboard "today at a glance" card.

    Returns:
        {
            'supplement_taken': int,    # number of supplement rows this day
            'antidepressant_taken': int,
            'other_taken': int,
            'taken_total': int,
            'by_slot': {'morning': [name, …], 'noon': […], 'evening': […], 'night': […]},
        }
    """
    records = get_medications_by_date(record_date)
    summary = {
        'supplement_taken': 0,
        'antidepressant_taken': 0,
        'other_taken': 0,
        'taken_total': len(records),
        'by_slot': {'morning': [], 'noon': [], 'evening': [], 'night': []},
    }
    for r in records:
        cat = r.get('category') or 'other'
        if cat == 'supplement':
            summary['supplement_taken'] += 1
        elif cat == 'antidepressant':
            summary['antidepressant_taken'] += 1
        else:
            summary['other_taken'] += 1

        slot = r.get('administration_slot') or 'morning'
        if slot not in summary['by_slot']:
            slot = 'morning'
        summary['by_slot'][slot].append(r.get('medication_name') or '')

    return summary
