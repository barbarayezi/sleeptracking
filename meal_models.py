"""
Data access layer for meal (diet) records.
All CRUD operations against the meal_records table.
Works with both local SQLite and Turso (cloud SQLite).
"""

import json

from database import get_connection


def row_to_dict(row):
    """Convert a sqlite3.Row (or TursoRow) to a plain dict."""
    if row is None:
        return None
    return dict(row)


def _dump_items(value):
    """Normalise items_json to a storable JSON string (or None).

    The frontend posts a list of item dicts; older/imported rows may already
    carry a JSON string. Anything unparseable is dropped rather than written
    as corrupt text, because the UI would then fail to render the meal.
    """
    if value is None or value == "":
        return None
    if isinstance(value, str):
        try:
            json.loads(value)
            return value
        except (ValueError, TypeError):
            return None
    try:
        return json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        return None


# ── Query helpers ─────────────────────────────────


def get_all_meals(from_date=None, to_date=None, date=None):
    """Return all meal records, optionally filtered by date range or a specific date.

    Args:
        from_date: ISO date string for lower bound (inclusive)
        to_date: ISO date string for upper bound (inclusive)
        date: ISO date string for exact match on a single date

    Returns:
        List of meal dicts, ordered by meal_date DESC then meal_time ASC.
    """
    conn = get_connection()

    query = "SELECT * FROM meal_records"
    params = []
    conditions = []

    if date:
        conditions.append("meal_date = ?")
        params.append(date)
    else:
        if from_date:
            conditions.append("meal_date >= ?")
            params.append(from_date)
        if to_date:
            conditions.append("meal_date <= ?")
            params.append(to_date)

    if conditions:
        query += " WHERE " + " AND ".join(conditions)

    query += """
        ORDER BY meal_date DESC,
            CASE meal_type
                WHEN 'breakfast' THEN 1
                WHEN 'lunch' THEN 2
                WHEN 'dinner' THEN 3
                WHEN 'snack' THEN 4
            END,
            meal_time ASC
    """

    cursor = conn.execute(query, params)
    rows = cursor.fetchall()
    conn.close()
    return [row_to_dict(r) for r in rows]


def get_meal_by_id(meal_id):
    """Return a single meal record by its ID, or None if not found."""
    conn = get_connection()
    cursor = conn.execute("SELECT * FROM meal_records WHERE id = ?", (meal_id,))
    row = cursor.fetchone()
    conn.close()
    return row_to_dict(row)


def get_meals_by_date(meal_date):
    """Return all meal records for a given date. Returns a list (may be empty)."""
    return get_all_meals(date=meal_date)


# ── CRUD operations ───────────────────────────────


def create_meal(data):
    """Insert a new meal record. Returns the created meal dict."""
    conn = get_connection()

    cursor = conn.execute(
        """
        INSERT INTO meal_records
            (meal_date, meal_type, meal_time, meal_name, meal_content,
             meal_quantity, health_rating, notes, allergy_reaction,
             calorie_kcal, protein_g, fat_g, carbs_g, health_score,
             items_json, ai_pros, ai_cons, ai_suggestion, ai_analyzed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            data["meal_date"],
            data["meal_type"],
            data["meal_time"],
            data.get("meal_name", ""),
            data.get("meal_content", ""),
            data.get("meal_quantity", "normal"),
            data.get("health_rating", "average"),
            data.get("notes", ""),
            data.get("allergy_reaction", ""),
            data.get("calorie_kcal"),
            data.get("protein_g"),
            data.get("fat_g"),
            data.get("carbs_g"),
            data.get("health_score"),
            _dump_items(data.get("items_json")),
            data.get("ai_pros", ""),
            data.get("ai_cons", ""),
            data.get("ai_suggestion", ""),
            data.get("ai_analyzed_at"),
        ),
    )

    meal_id = cursor.lastrowid
    conn.commit()

    # Read back by id
    cursor = conn.execute("SELECT * FROM meal_records WHERE id = ?", (meal_id,))
    row = cursor.fetchone()
    conn.close()
    return row_to_dict(row)


def update_meal_by_id(meal_id, data):
    """Update an existing meal record by ID. Returns the updated meal dict or None."""
    conn = get_connection()

    # Check record exists
    cursor = conn.execute("SELECT * FROM meal_records WHERE id = ?", (meal_id,))
    existing = cursor.fetchone()
    if not existing:
        conn.close()
        return None

    # Build SET clause dynamically for partial updates
    fields = []
    params = []

    if "meal_date" in data:
        fields.append("meal_date = ?")
        params.append(data["meal_date"])
    if "meal_type" in data:
        fields.append("meal_type = ?")
        params.append(data["meal_type"])
    if "meal_time" in data:
        fields.append("meal_time = ?")
        params.append(data["meal_time"])
    if "meal_name" in data:
        fields.append("meal_name = ?")
        params.append(data["meal_name"])
    if "meal_content" in data:
        fields.append("meal_content = ?")
        params.append(data["meal_content"])
    if "meal_quantity" in data:
        fields.append("meal_quantity = ?")
        params.append(data["meal_quantity"])
    if "health_rating" in data:
        fields.append("health_rating = ?")
        params.append(data["health_rating"])
    if "notes" in data:
        fields.append("notes = ?")
        params.append(data["notes"])
    if "allergy_reaction" in data:
        fields.append("allergy_reaction = ?")
        params.append(data["allergy_reaction"])

    # ── Nutrition / AI analysis (v11) ──
    # `in data` (not truthiness) so an explicit null/0/"" clears the field.
    for numeric_field in ("calorie_kcal", "protein_g", "fat_g", "carbs_g", "health_score"):
        if numeric_field in data:
            fields.append(f"{numeric_field} = ?")
            params.append(data[numeric_field])

    if "items_json" in data:
        fields.append("items_json = ?")
        params.append(_dump_items(data["items_json"]))

    for text_field in ("ai_pros", "ai_cons", "ai_suggestion", "ai_analyzed_at"):
        if text_field in data:
            fields.append(f"{text_field} = ?")
            params.append(data[text_field])

    fields.append("updated_at = datetime('now', 'localtime')")

    if not fields:
        conn.close()
        return row_to_dict(existing)

    params.append(meal_id)

    conn.execute(
        f"UPDATE meal_records SET {', '.join(fields)} WHERE id = ?",
        params,
    )

    conn.commit()

    # Read back
    cursor = conn.execute("SELECT * FROM meal_records WHERE id = ?", (meal_id,))
    row = cursor.fetchone()
    conn.close()
    return row_to_dict(row)


def delete_meal_by_id(meal_id):
    """Delete a meal record by ID. Returns True if deleted, False if not found."""
    conn = get_connection()
    cursor = conn.execute("DELETE FROM meal_records WHERE id = ?", (meal_id,))
    deleted = cursor.rowcount > 0
    conn.commit()
    conn.close()
    return deleted