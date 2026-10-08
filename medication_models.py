"""
Data access layer for medication records.

One row per (date, name, dosage) makes sense for medication because the user
can record "鱼油 2 粒" and "解郁除烦胶囊 3 粒" at different times on the same
day — each entry is independent, not "one record per day".

Works with both local SQLite and Turso (cloud SQLite).
"""

from database import get_connection, MEDICATION_CATEGORY_PALETTE


def row_to_dict(row):
    """Convert a sqlite3.Row (or TursoRow) to a plain dict."""
    if row is None:
        return None
    return dict(row)


# ── Query helpers ─────────────────────────────────


def get_all_medications(from_date=None, to_date=None, date=None):
    """Return medication records, optionally filtered by date range or one day.

    Args:
        from_date: ISO date string lower bound (inclusive)
        to_date:   ISO date string upper bound (inclusive)
        date:      ISO date string for exact match on a single day

    Returns:
        List of dicts ordered by record_date DESC, then by record_time ASC, then by id ASC.
    """
    conn = get_connection()

    query = "SELECT * FROM medication_records"
    params = []
    conditions = []

    if date:
        conditions.append("record_date = ?")
        params.append(date)
    else:
        if from_date:
            conditions.append("record_date >= ?")
            params.append(from_date)
        if to_date:
            conditions.append("record_date <= ?")
            params.append(to_date)

    if conditions:
        query += " WHERE " + " AND ".join(conditions)

    query += " ORDER BY record_date DESC, record_time ASC, id ASC"

    cursor = conn.execute(query, params)
    rows = cursor.fetchall()
    conn.close()
    return [row_to_dict(r) for r in rows]


def get_medication_by_id(med_id):
    """Return a single medication record by ID, or None."""
    conn = get_connection()
    cursor = conn.execute("SELECT * FROM medication_records WHERE id = ?", (med_id,))
    row = cursor.fetchone()
    conn.close()
    return row_to_dict(row)


def get_medications_by_date(record_date):
    """Return all medication records for the given date."""
    return get_all_medications(date=record_date)


# ── CRUD operations ───────────────────────────────


def create_medication(data):
    """Insert a new medication record. Returns the created dict."""
    conn = get_connection()

    cursor = conn.execute(
        """
        INSERT INTO medication_records
            (record_date, record_time, medication_name, dosage,
             dosage_unit, category, administration_slot, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            data["record_date"],
            data.get("record_time", "08:00"),
            data["medication_name"],
            float(data.get("dosage", 1)),
            data.get("dosage_unit", "粒"),
            data.get("category", "supplement"),
            data.get("administration_slot", "morning"),
            data.get("notes", ""),
        ),
    )
    med_id = cursor.lastrowid
    conn.commit()

    # Read back by id
    cursor = conn.execute("SELECT * FROM medication_records WHERE id = ?", (med_id,))
    row = cursor.fetchone()
    conn.close()
    return row_to_dict(row)


def update_medication_by_id(med_id, data):
    """Partial update by ID. Returns the updated dict or None if missing."""
    conn = get_connection()

    cursor = conn.execute("SELECT * FROM medication_records WHERE id = ?", (med_id,))
    existing = cursor.fetchone()
    if not existing:
        conn.close()
        return None

    fields = []
    params = []

    if "record_date" in data:
        fields.append("record_date = ?")
        params.append(data["record_date"])
    if "record_time" in data:
        fields.append("record_time = ?")
        params.append(data["record_time"])
    if "medication_name" in data:
        fields.append("medication_name = ?")
        params.append(data["medication_name"])
    if "dosage" in data:
        fields.append("dosage = ?")
        params.append(float(data["dosage"]))
    if "dosage_unit" in data:
        fields.append("dosage_unit = ?")
        params.append(data["dosage_unit"])
    if "category" in data:
        fields.append("category = ?")
        params.append(data["category"])
    if "administration_slot" in data:
        fields.append("administration_slot = ?")
        params.append(data["administration_slot"])
    if "notes" in data:
        fields.append("notes = ?")
        params.append(data["notes"])

    if not fields:
        # Nothing to update — return the existing row untouched so a no-op
        # PUT still reports success.
        conn.close()
        return row_to_dict(existing)

    fields.append("updated_at = datetime('now', 'localtime')")
    params.append(med_id)

    conn.execute(
        f"UPDATE medication_records SET {', '.join(fields)} WHERE id = ?",
        params,
    )
    conn.commit()

    cursor = conn.execute("SELECT * FROM medication_records WHERE id = ?", (med_id,))
    row = cursor.fetchone()
    conn.close()
    return row_to_dict(row)


def delete_medication_by_id(med_id):
    """Delete a medication record by ID. Returns True when a row was removed."""
    conn = get_connection()
    cursor = conn.execute("DELETE FROM medication_records WHERE id = ?", (med_id,))
    deleted = cursor.rowcount > 0
    conn.commit()
    conn.close()
    return deleted


# ── Category helpers ─────────────────────────────
# 类别存在 medication_categories 表（v18），用户可在页面上自助追加；
# 展示层（下拉 / 列表标签 / 汇总 chips）一律以这份数据为唯一真源。


def _fallback_categories():
    """In-memory fallback used only when the category table is missing."""
    seeds = [
        ('supplement', '保健类', '🍃', '#16a34a'),
        ('antidepressant', '抗抑郁药', '💊', '#2563eb'),
        ('cold', '感冒药', '🤧', '#0891b2'),
        ('analgesic', '止痛退烧', '🤕', '#d97706'),
        ('digestive', '肠胃药', '🌿', '#4d7c0f'),
        ('allergy', '抗过敏', '🌸', '#be185d'),
        ('sleep_aid', '助眠药', '😴', '#6d28d9'),
        ('other', '其他', '📦', '#64748b'),
    ]
    return [
        {'id': -i, 'category_key': k, 'label': lb, 'emoji': em,
         'color': c, 'sort_order': i, 'is_system': 1}
        for i, (k, lb, em, c) in enumerate(seeds)
    ]


def get_medication_categories():
    """Return every category dict ordered for display.

    Each dict: {id, category_key, label, emoji, color, sort_order, is_system}
    """
    conn = get_connection()
    try:
        cursor = conn.execute(
            "SELECT * FROM medication_categories ORDER BY sort_order ASC, id ASC"
        )
        rows = [row_to_dict(r) for r in cursor.fetchall()]
    except Exception:
        rows = []
    conn.close()
    return rows or _fallback_categories()


def get_medication_category_keys():
    """Set-like list of every valid category key (used for input validation)."""
    return [c['category_key'] for c in get_medication_categories()]


def get_category_display_map():
    """Map category_key -> {label, emoji, color} for rendering."""
    return {
        c['category_key']: {
            'label': c['label'],
            'emoji': c['emoji'],
            'color': c['color'],
        }
        for c in get_medication_categories()
    }


def _slugify(label):
    """ASCII slug from a label; Chinese labels fall back to an empty string."""
    out = []
    for ch in (label or '').lower():
        if ch.isascii() and (ch.isalnum() or ch in '-_'):
            out.append(ch)
    return ''.join(out).strip('-_')


def add_medication_category(label, emoji='📦'):
    """Create a user-defined category. Returns (category_dict, created_bool)."""
    label = (label or '').strip()
    if not label:
        raise ValueError('类别名称不能为空')
    if len(label) > 20:
        raise ValueError('类别名称请控制在 20 字以内')

    conn = get_connection()
    existing = [row_to_dict(r) for r in conn.execute(
        "SELECT * FROM medication_categories ORDER BY sort_order ASC, id ASC"
    ).fetchall()]
    if any(c['label'] == label for c in existing):
        conn.close()
        return next(c for c in existing if c['label'] == label), False

    base = _slugify(label) or 'custom'
    key = base
    taken = {c['category_key'] for c in existing}
    suffix = 2
    while key in taken:
        key = f"{base}{suffix}"
        suffix += 1

    max_sort = max([c['sort_order'] for c in existing], default=-1)
    color = MEDICATION_CATEGORY_PALETTE[len(existing) % len(MEDICATION_CATEGORY_PALETTE)]
    emoji = (emoji or '📦').strip() or '📦'

    cursor = conn.execute(
        "INSERT INTO medication_categories "
        "(category_key, label, emoji, color, sort_order, is_system) "
        "VALUES (?, ?, ?, ?, ?, 0)",
        (key, label, emoji, color, max_sort + 1),
    )
    new_id = cursor.lastrowid
    conn.commit()
    row = conn.execute(
        "SELECT * FROM medication_categories WHERE id = ?", (new_id,)
    ).fetchone()
    conn.close()
    return row_to_dict(row), True


def delete_medication_category(cat_id):
    """Delete a user-added category. Returns (ok, error_message)."""
    conn = get_connection()
    row = conn.execute(
        "SELECT * FROM medication_categories WHERE id = ?", (cat_id,)
    ).fetchone()
    if not row:
        conn.close()
        return False, '类别不存在'
    row = row_to_dict(row)
    if row.get('is_system'):
        conn.close()
        return False, '内置类别不能删除'

    used = conn.execute(
        "SELECT COUNT(*) AS c FROM medication_records WHERE category = ?",
        (row['category_key'],),
    ).fetchone()
    used_count = used['c'] if isinstance(used, dict) else used[0]
    if used_count:
        conn.close()
        return False, f'该类别下已有 {used_count} 条服药记录，不能删除'

    conn.execute("DELETE FROM medication_categories WHERE id = ?", (cat_id,))
    conn.commit()
    conn.close()
    return True, None


# ── Daily roll-up helper ─────────────────────────


def get_daily_medication_summary(record_date):
    """Build a per-day rollup for the dashboard "today at a glance" card.

    Returns:
        {
            'supplement_taken': int,    # 兼容旧字段：保健类条数
            'antidepressant_taken': int,# 兼容旧字段：抗抑郁药条数
            'other_taken': int,         # 兼容旧字段：其余类别合计
            'taken_total': int,
            'by_category': {key: count, …},   # 动态类别计数（新前端用这个）
            'by_slot': {'morning': [name, …], 'noon': […], 'evening': […], 'night': […]},
        }
    """
    records = get_medications_by_date(record_date)
    summary = {
        'supplement_taken': 0,
        'antidepressant_taken': 0,
        'other_taken': 0,
        'taken_total': len(records),
        'by_category': {},
        'by_slot': {'morning': [], 'noon': [], 'evening': [], 'night': []},
    }
    for r in records:
        cat = r.get('category') or 'other'
        summary['by_category'][cat] = summary['by_category'].get(cat, 0) + 1
        # Legacy fixed buckets kept so older consumers keep working.
        if cat == 'supplement':
            summary['supplement_taken'] += 1
        elif cat == 'antidepressant':
            summary['antidepressant_taken'] += 1
        else:
            summary['other_taken'] += 1

        slot = r.get('administration_slot') or 'morning'
        if slot not in summary['by_slot']:
            slot = 'morning'
        summary['by_slot'][slot].append(r.get('medication_name') or '')

    return summary
