"""
Data access layer for sleep records.
All CRUD operations against the sleep_records table.
"""

import json
from datetime import datetime, date
from database import get_connection


def row_to_dict(row):
    """Convert a sqlite3.Row to a plain dict with parsed JSON fields."""
    if row is None:
        return None
    d = dict(row)
    # Parse sleep_problems from JSON string to list
    if d.get('sleep_problems'):
        try:
            d['sleep_problems'] = json.loads(d['sleep_problems'])
        except (json.JSONDecodeError, TypeError):
            d['sleep_problems'] = []
    else:
        d['sleep_problems'] = []
    return d


def get_all_records(from_date=None, to_date=None):
    """Return all sleep records, optionally filtered by date range."""
    conn = get_connection()
    cursor = conn.cursor()

    query = "SELECT * FROM sleep_records"
    params = []

    if from_date and to_date:
        query += " WHERE record_date BETWEEN ? AND ?"
        params = [from_date, to_date]
    elif from_date:
        query += " WHERE record_date >= ?"
        params = [from_date]
    elif to_date:
        query += " WHERE record_date <= ?"
        params = [to_date]

    query += " ORDER BY record_date DESC"

    cursor.execute(query, params)
    rows = cursor.fetchall()
    conn.close()
    return [row_to_dict(r) for r in rows]


def get_record_by_date(record_date):
    """Return a single record by its date, or None if not found."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM sleep_records WHERE record_date = ?", (record_date,))
    row = cursor.fetchone()
    conn.close()
    return row_to_dict(row)


def create_record(data):
    """Insert a new sleep record. Returns the created record dict."""
    conn = get_connection()
    cursor = conn.cursor()

    sleep_problems = json.dumps(data.get('sleep_problems', []), ensure_ascii=False)

    cursor.execute('''
        INSERT INTO sleep_records
            (record_date, sleep_time, wake_time, classification,
             sleep_quality, sleep_problems, dream_journal)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    ''', (
        data['record_date'],
        data['sleep_time'],
        data['wake_time'],
        data['classification'],
        data['sleep_quality'],
        sleep_problems,
        data.get('dream_journal', '')
    ))

    conn.commit()
    record = get_record_by_date(data['record_date'])
    conn.close()
    return record


def update_record(record_date, data):
    """Update an existing sleep record. Returns the updated record dict or None."""
    conn = get_connection()
    cursor = conn.cursor()

    # Check record exists
    existing = cursor.execute(
        "SELECT * FROM sleep_records WHERE record_date = ?", (record_date,)
    ).fetchone()
    if not existing:
        conn.close()
        return None

    sleep_problems = json.dumps(data.get('sleep_problems', []), ensure_ascii=False)

    cursor.execute('''
        UPDATE sleep_records
        SET sleep_time = ?,
            wake_time = ?,
            classification = ?,
            sleep_quality = ?,
            sleep_problems = ?,
            dream_journal = ?,
            updated_at = datetime('now', 'localtime')
        WHERE record_date = ?
    ''', (
        data['sleep_time'],
        data['wake_time'],
        data['classification'],
        data['sleep_quality'],
        sleep_problems,
        data.get('dream_journal', ''),
        record_date
    ))

    conn.commit()
    record = get_record_by_date(record_date)
    conn.close()
    return record


def delete_record(record_date):
    """Delete a sleep record by date. Returns True if deleted, False if not found."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM sleep_records WHERE record_date = ?", (record_date,))
    deleted = cursor.rowcount > 0
    conn.commit()
    conn.close()
    return deleted