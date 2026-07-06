"""
Database initialization and connection management for the sleep tracker.
Supports both local SQLite and Turso (cloud SQLite) via libsql.
Set TURSO_URL and TURSO_AUTH_TOKEN to use Turso; otherwise falls back to local SQLite.
"""

import os
import sqlite3

# Load .env file for local development
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

# Turso configuration — read from environment variables
TURSO_URL = os.environ.get("TURSO_URL")
TURSO_AUTH_TOKEN = os.environ.get("TURSO_AUTH_TOKEN")

# Local SQLite fallback path
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sleep_tracker.db")

# Determine which backend to use
if TURSO_URL and TURSO_AUTH_TOKEN:
    USE_TURSO = True
else:
    USE_TURSO = False


class _TursoConnectionWrapper:
    """
    Wraps a libsql-experimental connection to behave like a sqlite3 connection
    with row_factory support.
    """

    def __init__(self, conn):
        self._conn = conn
        self.row_factory = None

    def execute(self, sql, params=None):
        cur = self._conn.execute(sql, params or ())
        return _TursoCursorWrapper(cur, self.row_factory)

    def commit(self):
        self._conn.commit()

    def close(self):
        self._conn.commit()
        self._conn.close()


class _TursoCursorWrapper:
    """Wraps a libsql cursor to support row_factory and Row-like behavior."""

    def __init__(self, cursor, row_factory):
        self._cursor = cursor
        self._row_factory = row_factory
        self._columns = [col[0] for col in cursor.description] if cursor.description else []
        self.rowcount = cursor.rowcount
        self.lastrowid = cursor.lastrowid
        raw = cursor.fetchall()
        self._fetched = list(raw) if raw else []
        self._pos = -1

    def fetchone(self):
        self._pos += 1
        if self._pos >= len(self._fetched):
            self._pos = len(self._fetched) - 1
            return None
        return self._make_row(self._fetched[self._pos])

    def fetchall(self):
        result = [self._make_row(r) for r in self._fetched[self._pos + 1:]]
        self._pos = len(self._fetched) - 1
        return result

    def _make_row(self, row):
        if row is None:
            return None
        if self._row_factory:
            return self._row_factory(CursorStub(self._columns), row)
        return _TursoRow(self._columns, row)


class _TursoRow:
    """A sqlite3.Row-like object backed by tuple and column names."""
    def __init__(self, columns, values):
        self._columns = columns
        self._values = values

    def keys(self):
        return self._columns

    def __getitem__(self, key):
        if isinstance(key, int):
            return self._values[key]
        return self._values[self._columns.index(key)]

    def __iter__(self):
        return iter(self._values)

    def __len__(self):
        return len(self._values)


class CursorStub:
    """Minimal stub to satisfy sqlite3.Row(cursor, tuple)."""
    def __init__(self, columns):
        self.description = tuple((col,) for col in columns)


def get_connection():
    """Return a new database connection (Turso or local SQLite)."""
    if USE_TURSO:
        import libsql_experimental as libsql

        raw_conn = libsql.connect(
            database=TURSO_URL,
            auth_token=TURSO_AUTH_TOKEN,
        )
        raw_conn.execute("PRAGMA foreign_keys=ON")
        conn = _TursoConnectionWrapper(raw_conn)
        # _TursoRow already provides dict-like interface, no need for sqlite3.Row
        return conn
    else:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn


def init_db():
    """Create the database schema if it doesn't already exist."""
    conn = get_connection()

    conn.execute("""
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
    """)

    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_sleep_records_date
        ON sleep_records(record_date)
    """)

    conn.commit()
    conn.close()


if __name__ == "__main__":
    if USE_TURSO:
        print(f"Turso mode: {TURSO_URL}")
    else:
        print(f"Local mode: {DB_PATH}")
    init_db()
    print("Database initialized successfully.")