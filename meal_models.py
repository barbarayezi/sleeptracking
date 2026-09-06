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
             items_json, ai_pros, ai_cons, ai_suggestion, ai_analyzed_at,
             dining_location, cooking_method)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            data.get("dining_location", ""),
            data.get("cooking_method", ""),
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

    for text_field in ("ai_pros", "ai_cons", "ai_suggestion", "ai_analyzed_at",
                       "dining_location", "cooking_method"):
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
    # Drop any attached photos first — the FK ON DELETE CASCADE only fires
    # when foreign_keys=ON, which isn't guaranteed on every platform.
    conn.execute("DELETE FROM meal_images WHERE meal_id = ?", (meal_id,))
    cursor = conn.execute("DELETE FROM meal_records WHERE id = ?", (meal_id,))
    deleted = cursor.rowcount > 0
    conn.commit()
    conn.close()
    return deleted


# ── Meal images (v13) ──────────────────────────────


def add_meal_images(meal_id, images):
    """Attach one or more photo BLOBs to a meal record.

    Args:
        meal_id: FK to meal_records
        images: list of dicts, each with keys:
                - image_blob (bytes, required)
                - mime_type (str, default 'image/jpeg')
                - role (str, default 'before', one of 'before'|'after')
                - original_filename (str, default '')
                - width / height / byte_size (optional ints)

    Returns: list of inserted image ids (in input order).
    """
    if not images:
        return []
    conn = get_connection()
    ids = []
    for img in images:
        blob = img.get("image_blob")
        if not blob:
            continue
        cursor = conn.execute(
            """
            INSERT INTO meal_images
                (meal_id, image_blob, mime_type, role, original_filename,
                 width, height, byte_size)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                meal_id,
                blob,
                img.get("mime_type", "image/jpeg"),
                img.get("role", "before"),
                img.get("original_filename", ""),
                img.get("width"),
                img.get("height"),
                img.get("byte_size") or len(blob),
            ),
        )
        ids.append(cursor.lastrowid)
    conn.commit()
    conn.close()
    return ids


def get_meal_images(meal_id):
    """Return image metadata (no BLOBs) for a meal, oldest first.

    Each dict has keys: id, role, mime_type, original_filename, width, height,
    byte_size, created_at. Frontend then loads bytes from
    /api/meals/<meal_id>/images/<image_id>.
    """
    conn = get_connection()
    cursor = conn.execute(
        """
        SELECT id, mime_type, role, original_filename, width, height,
               byte_size, created_at
        FROM meal_images
        WHERE meal_id = ?
        ORDER BY id ASC
        """,
        (meal_id,),
    )
    rows = [row_to_dict(r) for r in cursor.fetchall()]
    conn.close()
    return rows


def get_meal_image_blob(image_id):
    """Return (blob, mime_type, original_filename) or None if not found."""
    conn = get_connection()
    cursor = conn.execute(
        "SELECT image_blob, mime_type, original_filename FROM meal_images WHERE id = ?",
        (image_id,),
    )
    row = cursor.fetchone()
    conn.close()
    if row is None:
        return None
    if hasattr(row, 'keys'):
        d = dict(row)
        return d.get('image_blob'), d.get('mime_type'), d.get('original_filename')
    return row[0], row[1], row[2]


def replace_meal_images(meal_id, images):
    """Delete existing images for a meal and insert new ones (used by PUT)."""
    conn = get_connection()
    conn.execute("DELETE FROM meal_images WHERE meal_id = ?", (meal_id,))
    conn.commit()
    conn.close()
    if not images:
        return []
    return add_meal_images(meal_id, images)


# ── Meal options (v15) — user-extensible 用餐地点/制作方式 radio options ──


def get_meal_options():
    """Return all meal radio options grouped by type.

    Returns: {'location': [...values...], 'method': [...values...]}
    ordered by sort_order then id.
    """
    conn = get_connection()
    cursor = conn.execute(
        "SELECT option_type, option_value FROM meal_options "
        "ORDER BY option_type, sort_order, id"
    )
    result = {'location': [], 'method': []}
    for row in cursor.fetchall():
        t = row['option_type']
        if t in result:
            result[t].append(row['option_value'])
    conn.close()
    return result


def add_meal_option(option_type, option_value):
    """Add a custom option. Returns (option_dict, created_flag).

    If the same value already exists for the type, returns the existing row
    with created_flag=False instead of raising on the UNIQUE constraint.
    """
    option_type = (option_type or '').strip()
    option_value = (option_value or '').strip()
    conn = get_connection()
    cursor = conn.execute(
        "SELECT * FROM meal_options WHERE option_type = ? AND option_value = ?",
        (option_type, option_value),
    )
    existing = cursor.fetchone()
    if existing:
        conn.close()
        return row_to_dict(existing), False
    max_order = conn.execute(
        "SELECT COALESCE(MAX(sort_order), -1) AS m FROM meal_options WHERE option_type = ?",
        (option_type,),
    ).fetchone()['m']
    cursor = conn.execute(
        "INSERT INTO meal_options (option_type, option_value, sort_order) VALUES (?, ?, ?)",
        (option_type, option_value, max_order + 1),
    )
    new_id = cursor.lastrowid
    conn.commit()
    row = conn.execute("SELECT * FROM meal_options WHERE id = ?", (new_id,)).fetchone()
    conn.close()
    return row_to_dict(row), True


def delete_meal_option(option_id):
    """Delete a custom option by id. Returns True if deleted."""
    conn = get_connection()
    cursor = conn.execute("DELETE FROM meal_options WHERE id = ?", (option_id,))
    deleted = cursor.rowcount > 0
    conn.commit()
    conn.close()
    return deleted