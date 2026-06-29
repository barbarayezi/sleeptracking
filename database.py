"""
Database initialization and connection management for the sleep tracker.
Uses SQLite for zero-config local storage.
"""

import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'sleep_tracker.db')


def get_connection():
    """Return a new SQLite connection with row factory enabled."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    """Create the database schema if it doesn't already exist."""
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS sleep_records (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            record_date     DATE NOT NULL UNIQUE,
            sleep_time      TEXT NOT NULL,
            wake_time       TEXT NOT NULL,
            classification  TEXT NOT NULL CHECK(classification IN ('early', 'late')),
            sleep_quality   TEXT NOT NULL CHECK(sleep_quality IN ('good', 'average', 'poor')),
            sleep_problems  TEXT DEFAULT NULL,
            dream_journal   TEXT DEFAULT '',
            created_at      TEXT DEFAULT (datetime('now', 'localtime')),
            updated_at      TEXT DEFAULT (datetime('now', 'localtime'))
        )
    ''')

    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_sleep_records_date
        ON sleep_records(record_date)
    ''')

    conn.commit()
    conn.close()


if __name__ == '__main__':
    init_db()
    print(f"Database initialized at: {DB_PATH}")