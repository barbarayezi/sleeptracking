"""
Data access layer for daily combined reports.
Each row stores a sleep summary + AI brief for a single date,
so users can jump back to any day's report without regenerating it.
"""

import json

from database import get_connection


def _json_loads(value):
    if value is None:
        return None
    if isinstance(value, str):
        try:
            return json.loads(value)
        except (ValueError, TypeError):
            return None
    return value


def row_to_dict(row):
    """Convert a sqlite3.Row / TursoRow to a plain dict with parsed JSON."""
    if row is None:
        return None
    d = dict(row)
    d['sleep_summary'] = _json_loads(d.get('sleep_summary_json'))
    return d


def get_daily_report(report_date):
    """Return the saved combined report for a specific date, or None."""
    conn = get_connection()
    row = conn.execute(
        "SELECT * FROM daily_reports WHERE report_date = ?",
        (report_date,)
    ).fetchone()
    return row_to_dict(row)


def save_daily_report(report_date, sleep_summary, ai_brief_text, combined_text=None):
    """Upsert a daily combined report.

    Args:
        report_date: ISO date string (YYYY-MM-DD).
        sleep_summary: dict / JSON-serializable object.
        ai_brief_text: str, the AI-generated brief text.
        combined_text: optional pre-combined markdown/text.

    Returns:
        The saved report dict.
    """
    conn = get_connection()
    sleep_summary_json = json.dumps(sleep_summary, ensure_ascii=False)
    conn.execute(
        """
        INSERT INTO daily_reports
            (report_date, sleep_summary_json, ai_brief_text, combined_text, updated_at)
        VALUES (?, ?, ?, ?, datetime('now', 'localtime'))
        ON CONFLICT(report_date) DO UPDATE SET
            sleep_summary_json = excluded.sleep_summary_json,
            ai_brief_text      = excluded.ai_brief_text,
            combined_text      = excluded.combined_text,
            updated_at         = excluded.updated_at
        """,
        (report_date, sleep_summary_json, ai_brief_text, combined_text)
    )
    conn.commit()
    return get_daily_report(report_date)


def list_daily_report_dates(limit=365, offset=0):
    """Return a list of dates that already have a saved report, newest first."""
    conn = get_connection()
    rows = conn.execute(
        """
        SELECT report_date FROM daily_reports
        ORDER BY report_date DESC
        LIMIT ? OFFSET ?
        """,
        (limit, offset)
    ).fetchall()
    return [r['report_date'] for r in rows]
