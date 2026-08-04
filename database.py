"""
Database initialization and connection management for the sleep tracker.
Supports both local SQLite and Turso (cloud SQLite) via libsql.
Set TURSO_URL and TURSO_AUTH_TOKEN to use Turso; otherwise falls back to local SQLite.
"""

import os
import sqlite3
import time
import threading

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


def _is_retryable_db_error(exc):
    """Return True if exc is a transient Turso/Hrana network error worth retrying."""
    msg = str(exc).lower()
    return any(
        phrase in msg
        for phrase in (
            "hrana",
            "unexpected eof",
            "eof during chunk",
            "connection reset",
            "connection refused",
            "broken pipe",
            "timeout",
            "timed out",
            "temporarily unavailable",
        )
    )


def _with_retry(fn, retries=3, delay=1.0):
    """Call fn, retrying on transient Turso/Hrana errors with exponential backoff."""
    last_exc = None
    for attempt in range(retries):
        try:
            return fn()
        except Exception as exc:
            last_exc = exc
            if not _is_retryable_db_error(exc):
                raise
            if attempt < retries - 1:
                time.sleep(delay * (2 ** attempt))
    raise last_exc


class _TursoConnectionWrapper:
    """
    Wraps a libsql-experimental connection to behave like a sqlite3 connection
    with row_factory support.
    """

    def __init__(self, conn):
        self._conn = conn
        self.row_factory = None

    def execute(self, sql, params=None):
        # libsql_experimental only accepts tuples for parameters, not lists.
        if params is None:
            params = ()
        elif isinstance(params, (list, dict)):
            params = tuple(params)

        def _do():
            cur = self._conn.execute(sql, params)
            return _TursoCursorWrapper(cur, self.row_factory)

        return _with_retry(_do, retries=3, delay=1.0)

    def executemany(self, sql, seq_of_params):
        if seq_of_params is None:
            seq_of_params = []
        seq = [tuple(p) if not isinstance(p, (tuple, list)) else tuple(p)
               for p in seq_of_params]
        self._conn.executemany(sql, seq)
        return self

    def commit(self):
        self._conn.commit()

    def close(self):
        # 连接复用（线程本地缓存）：不真正关闭底层连接，仅提交未决事务。
        # 底层连接由所属线程持有，空闲断开时由 get_connection() 自动重建。
        try:
            self._conn.commit()
        except Exception:
            pass


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


# 线程本地连接缓存:每个线程复用同一个连接,避免 Turso 网络库每请求都新建连接。
_local = threading.local()


def _create_connection():
    """Create a fresh DB connection (Turso or local SQLite).

    Turso/Hrana connections occasionally fail with transient EOF/connection
    errors. Wrap connect in _with_retry so a single network hiccup does not
    wedge the app; the returned connection is reused per-thread by
    get_connection() below.
    """
    if USE_TURSO:
        # The libsql Python package was renamed from `libsql_experimental` to
        # `libsql` at v0.1.x. Support both so the app runs on either install.
        try:
            import libsql_experimental as libsql
        except ImportError:
            import libsql

        def _connect():
            raw_conn = libsql.connect(
                database=TURSO_URL,
                auth_token=TURSO_AUTH_TOKEN,
            )
            raw_conn.execute("PRAGMA foreign_keys=ON")
            return _TursoConnectionWrapper(raw_conn)

        # Turso/Hrana 连接抖动自动重试 + 线程本地复用
        return _with_retry(_connect, retries=3, delay=1.0)
    else:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA foreign_keys=ON")
        # 连接复用:覆盖 close(),使各调用点的 conn.close() 不再真正关闭连接。
        conn.close = lambda: None
        return conn


def _ping(conn):
    """Lightweight liveness check; raises if the connection is dead."""
    conn.execute("SELECT 1")


def get_connection():
    """Return a thread-local, reused database connection.

    Connections are cached per-thread and transparently recreated if they
    have gone stale (e.g. an idle Turso connection dropped by the server).
    Callers may keep calling conn.close() — it no longer tears down the
    underlying connection, so it is safely reusable for the next request.
    """
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = _create_connection()
        _local.conn = conn
    else:
        try:
            _ping(conn)
        except Exception:
            try:
                conn.close()
            except Exception:
                pass
            conn = _create_connection()
            _local.conn = conn
    return conn


def _get_schema_version(conn):
    """Return current schema version, or 0 if not set."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS _meta (
            key   TEXT PRIMARY KEY,
            value TEXT
        )
    """)
    cursor = conn.execute("SELECT value FROM _meta WHERE key = 'schema_version'")
    row = cursor.fetchone()
    if row:
        return int(row[0])
    return 0


def _set_schema_version(conn, version):
    """Set the schema version."""
    conn.execute(
        "INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', ?)",
        (str(version),)
    )
    conn.commit()


def _migrate_v2(conn):
    """Migrate from v1 (one record per date) to v2 (multiple records per date).

    Changes:
    - Remove UNIQUE constraint on record_date
    - Add record_type column (night/nap/segment)
    """
    print("  Running migration v1 -> v2 ...")

    # Step 1: Create new table with updated schema
    conn.execute("""
        CREATE TABLE sleep_records_v2 (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            record_date     DATE NOT NULL,
            record_type     TEXT NOT NULL DEFAULT 'night'
                            CHECK(record_type IN ('night', 'nap', 'segment')),
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

    # Step 2: Copy existing data (default record_type='night')
    conn.execute("""
        INSERT INTO sleep_records_v2
            (id, record_date, record_type, sleep_time, wake_time,
             classification, sleep_quality, sleep_problems, dream_journal,
             created_at, updated_at)
        SELECT id, record_date, 'night', sleep_time, wake_time,
               classification, sleep_quality, sleep_problems, dream_journal,
               created_at, updated_at
        FROM sleep_records
    """)

    # Step 3: Drop old table
    conn.execute("DROP TABLE sleep_records")

    # Step 4: Rename new table
    conn.execute("ALTER TABLE sleep_records_v2 RENAME TO sleep_records")

    # Step 5: Recreate indexes
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_sleep_records_date
        ON sleep_records(record_date)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_sleep_records_type
        ON sleep_records(record_type)
    """)

    _set_schema_version(conn, 2)
    print("  Migration v1 -> v2 completed.")


def _migrate_v3(conn):
    """Migrate from v2 to v3: add weight column."""
    print("  Running migration v2 -> v3 ...")
    # Check column exists first (handles recovery from partial migration)
    col_cursor = conn.execute("PRAGMA table_info('sleep_records')")
    columns = [row[1] for row in col_cursor.fetchall()]
    if 'weight' not in columns:
        conn.execute("ALTER TABLE sleep_records ADD COLUMN weight REAL DEFAULT NULL")
    _set_schema_version(conn, 3)
    print("  Migration v2 -> v3 completed.")


def _migrate_v4(conn):
    """Migrate from v3 to v4: add water_cups and steps columns."""
    print("  Running migration v3 -> v4 ...")
    col_cursor = conn.execute("PRAGMA table_info('sleep_records')")
    columns = [row[1] for row in col_cursor.fetchall()]
    if 'water_cups' not in columns:
        conn.execute("ALTER TABLE sleep_records ADD COLUMN water_cups INTEGER DEFAULT NULL")
    if 'steps' not in columns:
        conn.execute("ALTER TABLE sleep_records ADD COLUMN steps INTEGER DEFAULT NULL")
    _set_schema_version(conn, 4)
    print("  Migration v3 -> v4 completed.")


def _migrate_v5(conn):
    """Migrate from v4 to v5: add meal_records table for diet tracking."""
    print("  Running migration v4 -> v5 ...")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS meal_records (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            meal_date       DATE NOT NULL,
            meal_type       TEXT NOT NULL
                            CHECK(meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')),
            meal_time       TEXT NOT NULL,
            meal_name       TEXT DEFAULT '',
            meal_content    TEXT DEFAULT '',
            meal_quantity   TEXT DEFAULT 'normal'
                            CHECK(meal_quantity IN ('light', 'normal', 'heavy')),
            health_rating   TEXT DEFAULT 'average'
                            CHECK(health_rating IN ('good', 'average', 'poor')),
            notes           TEXT DEFAULT '',
            allergy_reaction TEXT DEFAULT '',
            created_at      TEXT DEFAULT (datetime('now', 'localtime')),
            updated_at      TEXT DEFAULT (datetime('now', 'localtime'))
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_meal_records_date
        ON meal_records(meal_date)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_meal_records_type
        ON meal_records(meal_type)
    """)
    _set_schema_version(conn, 5)
    print("  Migration v4 -> v5 completed.")


def _migrate(conn):
    """Run pending migrations based on current schema version."""
    version = _get_schema_version(conn)

    if version < 2:
        # Check if the old v1 table exists (no record_type column)
        cursor = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='sleep_records'"
        )
        if cursor.fetchone():
            # Table exists — check if it's v1 (no record_type column)
            col_cursor = conn.execute("PRAGMA table_info('sleep_records')")
            columns = [row[1] for row in col_cursor.fetchall()]
            if 'record_type' not in columns:
                _migrate_v2(conn)
            else:
                # Already v2, just update version
                _set_schema_version(conn, 2)
        else:
            # No table yet — fresh install. init_db() creates the full schema below,
            # so skip directly to the latest version to avoid ALTER TABLE on nothing.
            _set_schema_version(conn, 8)

    # Re-read version after potential v2 migration
    version = _get_schema_version(conn)
    if version < 3:
        _migrate_v3(conn)

    # Re-read version after potential v3 migration
    version = _get_schema_version(conn)
    if version < 4:
        _migrate_v4(conn)

    # Re-read version after potential v4 migration
    version = _get_schema_version(conn)
    if version < 5:
        _migrate_v5(conn)

    # Re-read version after potential v5 migration
    version = _get_schema_version(conn)
    if version < 6:
        _migrate_v6(conn)

    # Re-read version after potential v6 migration
    version = _get_schema_version(conn)
    if version < 7:
        _migrate_v7(conn)

    # Re-read version after potential v7 migration
    version = _get_schema_version(conn)
    if version < 8:
        _migrate_v8(conn)

    # Re-read version after potential v8 migration
    version = _get_schema_version(conn)
    if version < 9:
        _migrate_v9(conn)

    # Re-read version after potential v9 migration
    version = _get_schema_version(conn)
    if version < 10:
        _migrate_v10(conn)


def _migrate_v6(conn):
    """Migrate from v5 to v6: add device_score column (smart bracelet score)."""
    print("  Running migration v5 -> v6 ...")
    col_cursor = conn.execute("PRAGMA table_info('sleep_records')")
    columns = [row[1] for row in col_cursor.fetchall()]
    if 'device_score' not in columns:
        conn.execute("ALTER TABLE sleep_records ADD COLUMN device_score INTEGER DEFAULT NULL")
    _set_schema_version(conn, 6)
    print("  Migration v5 -> v6 completed.")


def _migrate_v7(conn):
    """Migrate from v6 to v7: add whoop_tokens table for Whoop OAuth."""
    print("  Running migration v6 -> v7 ...")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS whoop_tokens (
            id              INTEGER PRIMARY KEY,
            access_token    TEXT NOT NULL,
            refresh_token   TEXT DEFAULT '',
            expires_at      INTEGER NOT NULL,
            updated_at      TEXT DEFAULT (datetime('now', 'localtime'))
        )
    """)
    _set_schema_version(conn, 7)
    print("  Migration v6 -> v7 completed.")


def _migrate_v8(conn):
    """Migrate from v7 to v8: add Whoop health metrics columns."""
    print("  Running migration v7 -> v8 ...")
    col_cursor = conn.execute("PRAGMA table_info('sleep_records')")
    existing = {row[1] for row in col_cursor.fetchall()}

    additions = {
        "respiratory_rate": "ALTER TABLE sleep_records ADD COLUMN respiratory_rate REAL DEFAULT NULL",
        "sleep_efficiency": "ALTER TABLE sleep_records ADD COLUMN sleep_efficiency REAL DEFAULT NULL",
        "sleep_consistency": "ALTER TABLE sleep_records ADD COLUMN sleep_consistency REAL DEFAULT NULL",
        "deep_sleep_minutes": "ALTER TABLE sleep_records ADD COLUMN deep_sleep_minutes INTEGER DEFAULT NULL",
        "light_sleep_minutes": "ALTER TABLE sleep_records ADD COLUMN light_sleep_minutes INTEGER DEFAULT NULL",
        "rem_sleep_minutes": "ALTER TABLE sleep_records ADD COLUMN rem_sleep_minutes INTEGER DEFAULT NULL",
        "awake_minutes": "ALTER TABLE sleep_records ADD COLUMN awake_minutes INTEGER DEFAULT NULL",
        "disturbance_count": "ALTER TABLE sleep_records ADD COLUMN disturbance_count INTEGER DEFAULT NULL",
        "recovery_score": "ALTER TABLE sleep_records ADD COLUMN recovery_score INTEGER DEFAULT NULL",
        "resting_heart_rate": "ALTER TABLE sleep_records ADD COLUMN resting_heart_rate INTEGER DEFAULT NULL",
        "hrv": "ALTER TABLE sleep_records ADD COLUMN hrv REAL DEFAULT NULL",
    }
    for col, sql in additions.items():
        if col not in existing:
            conn.execute(sql)
    _set_schema_version(conn, 8)
    print("  Migration v7 -> v8 completed.")


def _migrate_v9(conn):
    """Migrate from v8 to v9: add period_records table for menstrual/cycle tracking."""
    print("  Running migration v8 -> v9 ...")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS period_records (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            record_date     DATE NOT NULL,
            is_period_start INTEGER DEFAULT 0,
            flow            TEXT DEFAULT 'none'
                            CHECK(flow IN ('none', 'light', 'normal', 'heavy')),
            symptoms        TEXT DEFAULT '',
            mood            TEXT DEFAULT '',
            phase           TEXT DEFAULT '',
            notes           TEXT DEFAULT '',
            created_at      TEXT DEFAULT (datetime('now', 'localtime')),
            updated_at      TEXT DEFAULT (datetime('now', 'localtime'))
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_period_records_date
        ON period_records(record_date)
    """)
    _set_schema_version(conn, 9)
    print("  Migration v8 -> v9 completed.")


def _migrate_v10(conn):
    """Migrate from v9 to v10: add SpO2/skin temp to sleep_records + daily/workout/health tables."""
    print("  Running migration v9 -> v10 ..")

    # 1) SpO2 + skin temp columns on sleep_records (recovery endpoint already returns them; was dropped)
    col_cursor = conn.execute("PRAGMA table_info('sleep_records')")
    existing = {row[1] for row in col_cursor.fetchall()}
    if 'spo2_percentage' not in existing:
        conn.execute("ALTER TABLE sleep_records ADD COLUMN spo2_percentage REAL DEFAULT NULL")
    if 'skin_temp_celsius' not in existing:
        conn.execute("ALTER TABLE sleep_records ADD COLUMN skin_temp_celsius REAL DEFAULT NULL")

    # 2) New tables (CREATE IF NOT EXISTS is safe on re-run)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS whoop_daily_metrics (
            record_date         DATE PRIMARY KEY,
            recovery_score      INTEGER DEFAULT NULL,
            resting_heart_rate  INTEGER DEFAULT NULL,
            hrv                 REAL DEFAULT NULL,
            spo2_percentage     REAL DEFAULT NULL,
            skin_temp_celsius   REAL DEFAULT NULL,
            strain              REAL DEFAULT NULL,
            kilojoule           REAL DEFAULT NULL,
            avg_heart_rate      INTEGER DEFAULT NULL,
            max_heart_rate      INTEGER DEFAULT NULL,
            updated_at          TEXT DEFAULT (datetime('now', 'localtime'))
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS whoop_workouts (
            id                  TEXT PRIMARY KEY,
            record_date         DATE NOT NULL,
            sport_name          TEXT DEFAULT '',
            strain              REAL DEFAULT NULL,
            avg_heart_rate      INTEGER DEFAULT NULL,
            max_heart_rate      INTEGER DEFAULT NULL,
            kilojoule           REAL DEFAULT NULL,
            distance_meter      REAL DEFAULT NULL,
            altitude_gain_meter REAL DEFAULT NULL,
            start_time          TEXT DEFAULT '',
            end_time            TEXT DEFAULT '',
            updated_at          TEXT DEFAULT (datetime('now', 'localtime'))
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS health_metrics (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            metric_date     DATE NOT NULL,
            metric_type     TEXT NOT NULL,
            value           REAL NOT NULL,
            source          TEXT DEFAULT 'apple_health',
            updated_at      TEXT DEFAULT (datetime('now', 'localtime'))
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_whoop_daily_date
        ON whoop_daily_metrics(record_date)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_whoop_workouts_date
        ON whoop_workouts(record_date)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_health_metrics_date_type
        ON health_metrics(metric_date, metric_type)
    """)

    _set_schema_version(conn, 10)
    print("  Migration v9 -> v10 completed.")


def init_db():
    """Create the database schema or migrate from an older version."""
    conn = get_connection()

    # Create tables FIRST (IF NOT EXISTS makes this safe for re-runs).
    # Migrations below will ALTER these tables if upgrading from an older schema.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sleep_records (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            record_date     DATE NOT NULL,
            record_type     TEXT NOT NULL DEFAULT 'night'
                            CHECK(record_type IN ('night', 'nap', 'segment')),
            sleep_time      TEXT NOT NULL,
            wake_time       TEXT NOT NULL,
            classification  TEXT NOT NULL CHECK(classification IN ('early', 'late')),
            sleep_quality   TEXT NOT NULL CHECK(sleep_quality IN ('good', 'average', 'poor')),
            sleep_problems  TEXT DEFAULT NULL,
            dream_journal   TEXT DEFAULT '',
            weight          REAL DEFAULT NULL,
            water_cups      INTEGER DEFAULT NULL,
            steps           INTEGER DEFAULT NULL,
            device_score        INTEGER DEFAULT NULL,
            respiratory_rate    REAL DEFAULT NULL,
            sleep_efficiency    REAL DEFAULT NULL,
            sleep_consistency   REAL DEFAULT NULL,
            deep_sleep_minutes  INTEGER DEFAULT NULL,
            light_sleep_minutes INTEGER DEFAULT NULL,
            rem_sleep_minutes   INTEGER DEFAULT NULL,
            awake_minutes       INTEGER DEFAULT NULL,
            disturbance_count   INTEGER DEFAULT NULL,
            recovery_score      INTEGER DEFAULT NULL,
            resting_heart_rate  INTEGER DEFAULT NULL,
            hrv                 REAL DEFAULT NULL,
            spo2_percentage     REAL DEFAULT NULL,
            skin_temp_celsius   REAL DEFAULT NULL,
            created_at          TEXT DEFAULT (datetime('now', 'localtime')),
            updated_at      TEXT DEFAULT (datetime('now', 'localtime'))
        )
    """)

    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_sleep_records_date
        ON sleep_records(record_date)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_sleep_records_type
        ON sleep_records(record_type)
    """)

    # Meal records table (v5)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS meal_records (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            meal_date       DATE NOT NULL,
            meal_type       TEXT NOT NULL
                            CHECK(meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')),
            meal_time       TEXT NOT NULL,
            meal_name       TEXT DEFAULT '',
            meal_content    TEXT DEFAULT '',
            meal_quantity   TEXT DEFAULT 'normal'
                            CHECK(meal_quantity IN ('light', 'normal', 'heavy')),
            health_rating   TEXT DEFAULT 'average'
                            CHECK(health_rating IN ('good', 'average', 'poor')),
            notes           TEXT DEFAULT '',
            allergy_reaction TEXT DEFAULT '',
            created_at      TEXT DEFAULT (datetime('now', 'localtime')),
            updated_at      TEXT DEFAULT (datetime('now', 'localtime'))
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_meal_records_date
        ON meal_records(meal_date)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_meal_records_type
        ON meal_records(meal_type)
    """)

    # Whoop tokens table (v7)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS whoop_tokens (
            id              INTEGER PRIMARY KEY,
            access_token    TEXT NOT NULL,
            refresh_token   TEXT DEFAULT '',
            expires_at      INTEGER NOT NULL,
            updated_at      TEXT DEFAULT (datetime('now', 'localtime'))
        )
    """)

    # Period records table (v9) — menstrual / cycle tracking
    conn.execute("""
        CREATE TABLE IF NOT EXISTS period_records (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            record_date     DATE NOT NULL,
            is_period_start INTEGER DEFAULT 0,
            flow            TEXT DEFAULT 'none'
                            CHECK(flow IN ('none', 'light', 'normal', 'heavy')),
            symptoms        TEXT DEFAULT '',
            mood            TEXT DEFAULT '',
            phase           TEXT DEFAULT '',
            notes           TEXT DEFAULT '',
            created_at      TEXT DEFAULT (datetime('now', 'localtime')),
            updated_at      TEXT DEFAULT (datetime('now', 'localtime'))
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_period_records_date
        ON period_records(record_date)
    """)

    # Whoop daily metrics table (v10) — recovery (full) + daily strain/HR aggregates, keyed by date
    conn.execute("""
        CREATE TABLE IF NOT EXISTS whoop_daily_metrics (
            record_date         DATE PRIMARY KEY,
            recovery_score      INTEGER DEFAULT NULL,
            resting_heart_rate  INTEGER DEFAULT NULL,
            hrv                 REAL DEFAULT NULL,
            spo2_percentage     REAL DEFAULT NULL,
            skin_temp_celsius   REAL DEFAULT NULL,
            strain              REAL DEFAULT NULL,
            kilojoule           REAL DEFAULT NULL,
            avg_heart_rate      INTEGER DEFAULT NULL,
            max_heart_rate      INTEGER DEFAULT NULL,
            updated_at          TEXT DEFAULT (datetime('now', 'localtime'))
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_whoop_daily_date
        ON whoop_daily_metrics(record_date)
    """)

    # Whoop workouts table (v10) — individual workout sessions
    conn.execute("""
        CREATE TABLE IF NOT EXISTS whoop_workouts (
            id                  TEXT PRIMARY KEY,
            record_date         DATE NOT NULL,
            sport_name          TEXT DEFAULT '',
            strain              REAL DEFAULT NULL,
            avg_heart_rate      INTEGER DEFAULT NULL,
            max_heart_rate      INTEGER DEFAULT NULL,
            kilojoule           REAL DEFAULT NULL,
            distance_meter      REAL DEFAULT NULL,
            altitude_gain_meter REAL DEFAULT NULL,
            start_time          TEXT DEFAULT '',
            end_time            TEXT DEFAULT '',
            updated_at          TEXT DEFAULT (datetime('now', 'localtime'))
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_whoop_workouts_date
        ON whoop_workouts(record_date)
    """)

    # Health metrics table (v10) — Apple Health / external sources (steps, active energy, distance, etc.)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS health_metrics (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            metric_date     DATE NOT NULL,
            metric_type     TEXT NOT NULL,
            value           REAL NOT NULL,
            source          TEXT DEFAULT 'apple_health',
            updated_at      TEXT DEFAULT (datetime('now', 'localtime'))
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_health_metrics_date_type
        ON health_metrics(metric_date, metric_type)
    """)

    # Now run pending migrations (ALTER TABLE for older schemas)
    _migrate(conn)

    conn.commit()
    conn.close()


if __name__ == "__main__":
    if USE_TURSO:
        print(f"Turso mode: {TURSO_URL}")
    else:
        print(f"Local mode: {DB_PATH}")
    init_db()
    print("Database initialized successfully.")