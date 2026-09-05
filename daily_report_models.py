"""
Data access layer for combined reports (daily / weekly / monthly).
Each row stores a sleep summary + AI brief for a (period, date) pair, plus
an embedded chat_json array (only used for daily reports — that's where the
"ask the AI follow-up questions" feature lives).

`period`:
    'daily'   — single day (yesterday diet + this morning metrics + chat)
    'weekly'  — period starting Monday containing `report_date`
    'monthly' — period starting first day of `report_date`'s month

`report_date` is always the period START date (e.g. for a weekly report
covering Sep 1–7, report_date='2025-09-01').
"""

import json

from database import get_connection


_VALID_PERIODS = ('daily', 'weekly', 'monthly')


def _validate_period(period):
    if period not in _VALID_PERIODS:
        raise ValueError(f'period must be one of {_VALID_PERIODS}, got {period!r}')
    return period


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
    d['chat'] = _json_loads(d.get('chat_json')) or []
    return d


def get_report(period, report_date):
    """Return the saved report for (period, report_date), or None.

    Args:
        period: 'daily' | 'weekly' | 'monthly'
        report_date: ISO date (YYYY-MM-DD). For weekly/monthly, this is the
                     period start date.
    """
    period = _validate_period(period)
    conn = get_connection()
    row = conn.execute(
        "SELECT * FROM daily_reports WHERE period = ? AND report_date = ?",
        (period, report_date),
    ).fetchone()
    return row_to_dict(row)


def save_report(period, report_date, sleep_summary, ai_brief_text,
                combined_text=None, chat=None):
    """Upsert a combined report for (period, report_date).

    `chat` is only meaningful for period='daily'. Stored as JSON in chat_json.
    Pass None to keep the existing chat history; pass [] to clear it.
    """
    period = _validate_period(period)
    sleep_summary_json = json.dumps(sleep_summary, ensure_ascii=False)
    chat_json = json.dumps(chat or [], ensure_ascii=False)
    conn = get_connection()
    conn.execute(
        """
        INSERT INTO daily_reports
            (period, report_date, sleep_summary_json, ai_brief_text,
             combined_text, chat_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
        ON CONFLICT(period, report_date) DO UPDATE SET
            sleep_summary_json = excluded.sleep_summary_json,
            ai_brief_text      = excluded.ai_brief_text,
            combined_text      = excluded.combined_text,
            chat_json          = excluded.chat_json,
            updated_at         = excluded.updated_at
        """,
        (period, report_date, sleep_summary_json, ai_brief_text,
         combined_text, chat_json),
    )
    conn.commit()
    return get_report(period, report_date)


def append_chat_message(period, report_date, role, content):
    """Append one chat turn (user or assistant) to the saved report's chat_json.

    If the (period, report_date) row doesn't exist yet (e.g. user starts
    chatting before generating today's report), it's created with empty
    sleep_summary / ai_brief so the chat history is preserved.

    Returns the updated report dict.
    """
    period = _validate_period(period)
    existing = get_report(period, report_date)
    if not existing:
        # Bootstrap a minimal row so the chat turn has somewhere to land.
        existing = save_report(
            period, report_date,
            sleep_summary={},
            ai_brief_text='',
            combined_text='',
            chat=[],
        )
    chat = list(existing.get('chat') or [])
    chat.append({'role': role, 'content': content, 'at': _now_local_iso()})
    return save_report(
        period, report_date,
        sleep_summary=existing.get('sleep_summary') or {},
        ai_brief_text=existing.get('ai_brief_text') or '',
        combined_text=existing.get('combined_text'),
        chat=chat,
    )


def list_report_dates(period=None, limit=365, offset=0):
    """Return a list of saved report dates for a period (newest first).

    If `period` is None, returns dates across all periods — each entry is a
    dict {period, report_date} so callers can group/filter as needed.
    """
    conn = get_connection()
    if period:
        _validate_period(period)
        rows = conn.execute(
            """
            SELECT report_date FROM daily_reports
            WHERE period = ?
            ORDER BY report_date DESC
            LIMIT ? OFFSET ?
            """,
            (period, limit, offset),
        ).fetchall()
        return [r['report_date'] for r in rows]
    rows = conn.execute(
        """
        SELECT period, report_date FROM daily_reports
        ORDER BY report_date DESC, period ASC
        LIMIT ? OFFSET ?
        """,
        (limit, offset),
    ).fetchall()
    return [{'period': r['period'], 'report_date': r['report_date']} for r in rows]


def _now_local_iso():
    """ISO timestamp in localtime (matches datetime('now', 'localtime') used elsewhere)."""
    from datetime import datetime
    return datetime.now().strftime('%Y-%m-%d %H:%M:%S')