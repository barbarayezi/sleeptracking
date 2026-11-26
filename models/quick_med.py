"""
Data access layer for quick_meds —— 「一键打卡常用药」。

这里存的是「医嘱上的每日方案」：药名、剂量、单位、类别、时段。
一键打卡按钮、以及记录卡片上的「计划 X」对照，都以这张表为准。
改剂量 = 改这一行，不再需要动 HTML / 发版。

记录本身（medication_records）只存实际吃的那一次，两者分开是刻意的：
计划会变，历史记录不能跟着变。

Works with both local SQLite and Turso (cloud SQLite).
"""

from database import get_connection, insert_and_fetch


def row_to_dict(row):
    """Convert a sqlite3.Row (or TursoRow) to a plain dict."""
    if row is None:
        return None
    return dict(row)


def list_quick_meds():
    """Return active quick meds ordered by sort_order, then id."""
    conn = get_connection()
    try:
        cursor = conn.execute(
            "SELECT * FROM quick_meds WHERE active = 1 ORDER BY sort_order ASC, id ASC"
        )
        return [row_to_dict(r) for r in cursor.fetchall()]
    finally:
        conn.close()


def get_quick_med_by_id(qid):
    conn = get_connection()
    try:
        cursor = conn.execute("SELECT * FROM quick_meds WHERE id = ?", (qid,))
        return row_to_dict(cursor.fetchone())
    finally:
        conn.close()


def _find_conflict(conn, name, slot, exclude_id=None):
    """同一种药 + 同一时段只能有一条：否则一键打卡不知道该用哪个剂量。"""
    sql = ("SELECT id FROM quick_meds WHERE active = 1 "
           "AND medication_name = ? AND administration_slot = ?")
    params = [name, slot]
    if exclude_id is not None:
        sql += " AND id <> ?"
        params.append(exclude_id)
    return conn.execute(sql, params).fetchone() is not None


def create_quick_med(data):
    """Insert a quick med. Raises ValueError on a duplicate (name, slot)."""
    conn = get_connection()
    try:
        name = data["medication_name"]
        slot = data.get("administration_slot", "morning")
        if _find_conflict(conn, name, slot):
            raise ValueError("这个药在这个时段已经有一条常用药了，改那条就行。")

        next_order = conn.execute(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM quick_meds"
        ).fetchone()[0]

        row = insert_and_fetch(
            conn,
            """
            INSERT INTO quick_meds
                (emoji, medication_name, dosage, dosage_unit, category,
                 administration_slot, sort_order, active)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1)
            """,
            (
                (data.get("emoji") or "💊").strip() or "💊",
                name,
                float(data.get("dosage", 1)),
                data.get("dosage_unit", "粒"),
                data.get("category", "supplement"),
                slot,
                next_order,
            ),
        )
        return row_to_dict(row)
    finally:
        conn.close()


def update_quick_med_by_id(qid, data):
    """Partial update by ID. Returns the updated dict, or None when missing."""
    conn = get_connection()
    try:
        cursor = conn.execute("SELECT * FROM quick_meds WHERE id = ?", (qid,))
        existing = cursor.fetchone()
        if not existing:
            return None

        name = data.get("medication_name", existing["medication_name"])
        slot = data.get("administration_slot", existing["administration_slot"])
        if _find_conflict(conn, name, slot, exclude_id=qid):
            raise ValueError("这个药在这个时段已经有一条常用药了，改那条就行。")

        fields, params = [], []
        for col in ("medication_name", "dosage_unit", "category", "administration_slot", "emoji"):
            if col in data:
                fields.append(f"{col} = ?")
                params.append(data[col])
        if "dosage" in data:
            fields.append("dosage = ?")
            params.append(float(data["dosage"]))
        if "sort_order" in data:
            fields.append("sort_order = ?")
            params.append(int(data["sort_order"]))

        if not fields:
            return row_to_dict(existing)

        fields.append("updated_at = datetime('now', 'localtime')")
        params.append(qid)
        conn.execute(
            f"UPDATE quick_meds SET {', '.join(fields)} WHERE id = ?",
            params,
        )
        conn.commit()

        cursor = conn.execute("SELECT * FROM quick_meds WHERE id = ?", (qid,))
        return row_to_dict(cursor.fetchone())
    finally:
        conn.close()


def delete_quick_med_by_id(qid):
    """Delete a quick med. Returns True when a row was removed.

    只删「常用药」这一行，历史服药记录不受影响。
    """
    conn = get_connection()
    try:
        cursor = conn.execute("DELETE FROM quick_meds WHERE id = ?", (qid,))
        deleted = cursor.rowcount > 0
        conn.commit()
        return deleted
    finally:
        conn.close()
