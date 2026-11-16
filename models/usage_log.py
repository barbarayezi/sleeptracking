"""
LLM 调用用量记账（token 维度）。

为什么存在这个模块：
    TokenHub（tokenhub.tencentmaas.com）只开放了 /v1/models，
    /v1/usage、/v1/dashboard/billing/*、/v1/credits、/user/balance
    等余额/账单端点一律返回 404 —— **剩余额度查不到**，这是网关侧的限制，
    不是调用姿势的问题。所以「还能用多少」永远无法回答。

    但每次响应体里的 usage（input_tokens / output_tokens /
    cache_read_input_tokens）是真实值。逐次记下来，就能回答：
      · 今天用了多少
      · 最近 7 天 / 30 天用了多少
      · 累计用了多少
    这是唯一可信的用量口径 —— 用「分析了几餐」去推算只是近似。

可靠性约定：
    记账是旁路能力，**绝不允许影响营养分析本身**。所有异常都吞掉，
    写不进去就算了，调用方照常拿结果。
"""

import os
from datetime import datetime

# 进程内只需确保表存在一次。
_table_ready = False

_CREATE_SQL = """
CREATE TABLE IF NOT EXISTS ai_usage_log (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at         TEXT NOT NULL,          -- 本地时间，便于按天聚合
    kind               TEXT NOT NULL DEFAULT 'text',   -- text / vision
    model              TEXT DEFAULT '',
    input_tokens       INTEGER NOT NULL DEFAULT 0,
    output_tokens      INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
    source             TEXT DEFAULT 'app'
)
"""


def _connection():
    """复用 database 的线程内连接（自动处理 Turso 重连/重试）。"""
    from database import get_connection
    return get_connection()


def _ensure_table(conn):
    global _table_ready
    if _table_ready:
        return
    conn.execute(_CREATE_SQL)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage_log(created_at)"
    )
    conn.commit()
    _table_ready = True


def record(kind="text", model="", usage=None, source="app"):
    """记一次成功的模型调用。返回 True/False，从不抛异常。"""
    try:
        usage = usage or {}
        conn = _connection()
        _ensure_table(conn)
        conn.execute(
            """
            INSERT INTO ai_usage_log
                (created_at, kind, model, input_tokens, output_tokens,
                 cache_read_tokens, source)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                (kind or "text")[:16],
                (model or "")[:80],
                int(usage.get("input_tokens") or 0),
                int(usage.get("output_tokens") or 0),
                int(usage.get("cache_read_input_tokens") or 0),
                (source or "app")[:16],
            ),
        )
        conn.commit()
        return True
    except Exception:
        # 记账失败不影响业务；下次调用会重试建表。
        global _table_ready
        _table_ready = False
        return False


def summarize(conn=None, days=1):
    """按天汇总最近 days 天的用量（含今天），返回 dict 列表。"""
    own = conn is None
    if own:
        conn = _connection()
        _ensure_table(conn)
    cur = conn.execute(
        """
        SELECT substr(created_at, 1, 10) AS day,
               COUNT(*)                 AS calls,
               SUM(input_tokens)        AS input_tokens,
               SUM(output_tokens)       AS output_tokens,
               SUM(input_tokens + output_tokens) AS total_tokens
        FROM ai_usage_log
        WHERE date(created_at) >= date('now', 'localtime', ?)
        GROUP BY day
        ORDER BY day DESC
        """,
        (f"-{max(0, days - 1)} days",),
    )
    cols = [c[0] for c in cur.description] if cur.description else []
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    if own:
        conn.close()
    return rows


def total(conn=None):
    """累计用量。"""
    own = conn is None
    if own:
        conn = _connection()
        _ensure_table(conn)
    cur = conn.execute(
        """
        SELECT COUNT(*) AS calls,
               COALESCE(SUM(input_tokens), 0)  AS input_tokens,
               COALESCE(SUM(output_tokens), 0) AS output_tokens,
               COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens
        FROM ai_usage_log
        """
    )
    cols = [c[0] for c in cur.description] if cur.description else []
    row = dict(zip(cols, cur.fetchone()))
    if own:
        conn.close()
    return row
