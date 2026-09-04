"""
Sleep Tracker — Flask application entry point.
All REST API routes for CRUD operations, statistics, and reports.
"""

import os
import sys
import threading
import urllib.parse
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

from flask import Flask, request, jsonify, render_template, redirect
from database import init_db, get_connection
from reports import generate_report, get_quick_stats
import models as models
import meal_models as meal_models
import nutrition as nutrition
import period_models as period_models
import daily_report_models as daily_report_models
import medication_models as medication_models
import time
import socket

# 全局 socket 超时：防止 Turso/libsql 连接在网络抖动时无限阻塞，
# 否则会把整个 waitress 工作线程池拖死、导致服务器对任何请求都不响应。
socket.setdefaulttimeout(15)

app = Flask(__name__)
# 本地个人应用：禁用静态文件客户端缓存，改完前端刷新即可见，无需手动清缓存
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0
# 本地个人应用：模板随文件改动自动重载，改 index.html 也无需重启服务
app.config['TEMPLATES_AUTO_RELOAD'] = True

# 一次性安全告警标记（未配置 HEALTHKIT_API_KEY 时）
_ingest_key_warned = False


@app.after_request
def _set_no_cache_headers(response):
    """禁止浏览器/Service Worker 缓存所有 GET JSON API 响应。

    动态数据（记录、Whoop 指标等）如果被缓存，会出现‘代码已更新但页面仍显示旧数据’
    的诡异现象。静态文件由 send_static_file 自行处理，不受影响。
    """
    if request.method == 'GET' and response.is_json:
        response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
        response.headers['Pragma'] = 'no-cache'
        response.headers['Expires'] = '0'
    return response


# ──────────────────────────────────────────────
#  Page route
# ──────────────────────────────────────────────

@app.route('/sw.js')
def service_worker():
    """Serve service worker from root scope (required for PWA)."""
    return app.send_static_file('sw.js')


@app.route('/')
def index():
    return render_template('index.html')


# ──────────────────────────────────────────────
#  Validation helpers
# ──────────────────────────────────────────────


def _validate_record_data(data):
    """Validate sleep record data. Returns (errors, cleaned_data)."""
    errors = []

    # Validate required fields
    required = ['record_date', 'sleep_time', 'wake_time', 'classification', 'sleep_quality']
    for field in required:
        if field not in data:
            errors.append(f'Missing required field: {field}')

    # Validate classification
    if 'classification' in data and data['classification'] not in ('early', 'late'):
        errors.append('classification must be "early" or "late"')

    # Validate sleep quality
    if 'sleep_quality' in data and data['sleep_quality'] not in ('good', 'average', 'poor'):
        errors.append('sleep_quality must be "good", "average", or "poor"')

    # Validate record_type if present
    if 'record_type' in data and data['record_type'] not in ('night', 'nap', 'segment'):
        errors.append('record_type must be "night", "nap", or "segment"')

    # Auto-clear sleep problems if quality is good
    if data.get('sleep_quality') == 'good':
        data['sleep_problems'] = []

    # Validate weight (optional, must be a reasonable positive number if provided)
    if 'weight' in data and data['weight'] is not None and data['weight'] != '':
        try:
            w = float(data['weight'])
            if w < 20 or w > 500:
                errors.append('weight must be between 20 and 500 kg')
        except (ValueError, TypeError):
            errors.append('weight must be a valid number')

    # Validate water_cups (optional, non-negative integer)
    if 'water_cups' in data and data['water_cups'] is not None and data['water_cups'] != '':
        try:
            cups = int(data['water_cups'])
            if cups < 0 or cups > 100:
                errors.append('water_cups must be between 0 and 100')
        except (ValueError, TypeError):
            errors.append('water_cups must be a valid integer')

    # Validate steps (optional, non-negative integer)
    if 'steps' in data and data['steps'] is not None and data['steps'] != '':
        try:
            s = int(data['steps'])
            if s < 0 or s > 200000:
                errors.append('steps must be between 0 and 200000')
        except (ValueError, TypeError):
            errors.append('steps must be a valid integer')

    # Validate device_score (optional, smart bracelet sleep score, 0-100)
    if 'device_score' in data and data['device_score'] is not None and data['device_score'] != '':
        try:
            s = int(data['device_score'])
            if s < 0 or s > 100:
                errors.append('device_score must be between 0 and 100')
        except (ValueError, TypeError):
            errors.append('device_score must be a valid integer')

    # Validate sleep problems when quality is not good
    if data.get('sleep_quality') in ('average', 'poor'):
        problems = data.get('sleep_problems', [])
        if not problems:
            errors.append('sleep_problems is required when quality is average or poor')
        else:
            valid_problems = {'insomnia', 'dreams', 'sweats', 'waking', 'early_waking'}
            for p in problems:
                if p not in valid_problems:
                    errors.append(f'Invalid sleep problem: {p}')
                    break

    return errors


# ──────────────────────────────────────────────
#  CRUD: /api/records
# ──────────────────────────────────────────────

@app.route('/api/records', methods=['GET'])
def list_records():
    """List all records, optionally filtered by date range or specific date."""
    from_date = request.args.get('from')
    to_date = request.args.get('to')
    date = request.args.get('date')
    records = models.get_all_records(from_date=from_date, to_date=to_date, date=date)
    return jsonify(records)


@app.route('/api/records/<int:record_id>', methods=['GET'])
def get_record(record_id):
    """Get a single record by ID."""
    record = models.get_record_by_id(record_id)
    if record is None:
        return jsonify({'error': 'Record not found'}), 404
    return jsonify(record)


@app.route('/api/records', methods=['POST'])
def create_record():
    """Create a new sleep record. Multiple records per date are allowed."""
    data = request.get_json()
    if not data:
        return jsonify({'error': 'Request body must be JSON'}), 400

    errors = _validate_record_data(data)
    if errors:
        return jsonify({'error': errors[0]}), 400

    record = models.create_record(data)
    return jsonify(record), 201


@app.route('/api/records/<int:record_id>', methods=['PUT'])
def update_record(record_id):
    """Update an existing sleep record by ID."""
    data = request.get_json()
    if not data:
        return jsonify({'error': 'Request body must be JSON'}), 400

    errors = _validate_record_data(data)
    if errors:
        return jsonify({'error': errors[0]}), 400

    record = models.update_record_by_id(record_id, data)
    if record is None:
        return jsonify({'error': 'Record not found'}), 404
    return jsonify(record)


@app.route('/api/records/<int:record_id>', methods=['DELETE'])
def delete_record(record_id):
    """Delete a sleep record by ID."""
    deleted = models.delete_record_by_id(record_id)
    if not deleted:
        return jsonify({'error': 'Record not found'}), 404
    return '', 204


# ──────────────────────────────────────────────
#  Reports & Stats
# ──────────────────────────────────────────────

@app.route('/api/report', methods=['GET'])
def get_report():
    """Generate a sleep analysis report."""
    period = request.args.get('period', 'weekly')
    from_date = request.args.get('from', None)

    if period not in ('weekly', 'monthly'):
        return jsonify({'error': 'period must be "weekly" or "monthly"'}), 400

    report = generate_report(period=period, from_date=from_date)
    return jsonify(report)


@app.route('/api/stats', methods=['GET'])
def get_stats():
    """Return quick dashboard statistics."""
    days = request.args.get('days', 30, type=int)
    stats = get_quick_stats(days=days)
    return jsonify(stats)


# ──────────────────────────────────────────────
#  Meal (Diet) CRUD: /api/meals
# ──────────────────────────────────────────────


def _validate_meal_data(data):
    """Validate meal record data. Returns (errors, cleaned_data)."""
    errors = []

    # Validate required fields
    required = ['meal_date', 'meal_type', 'meal_time']
    for field in required:
        if field not in data:
            errors.append(f'Missing required field: {field}')

    # Validate meal_type
    if 'meal_type' in data and data['meal_type'] not in ('breakfast', 'lunch', 'dinner', 'snack'):
        errors.append('meal_type must be "breakfast", "lunch", "dinner", or "snack"')

    # Validate meal_quantity
    if 'meal_quantity' in data and data['meal_quantity'] not in ('light', 'normal', 'heavy'):
        errors.append('meal_quantity must be "light", "normal", or "heavy"')

    # Validate health_rating
    if 'health_rating' in data and data['health_rating'] not in ('good', 'average', 'poor'):
        errors.append('health_rating must be "good", "average", or "poor"')

    # Validate nutrition numbers (all optional; null/'' means "not recorded")
    NUMBER_RANGES = {
        'calorie_kcal': (0, 5000),
        'protein_g': (0, 500),
        'fat_g': (0, 500),
        'carbs_g': (0, 500),
    }
    for field, (lo, hi) in NUMBER_RANGES.items():
        if field in data and data[field] is not None and data[field] != '':
            try:
                v = float(data[field])
                if v < lo or v > hi:
                    errors.append(f'{field} must be between {lo} and {hi}')
            except (ValueError, TypeError):
                errors.append(f'{field} must be a number')

    if 'health_score' in data and data['health_score'] is not None and data['health_score'] != '':
        try:
            s = float(data['health_score'])
            if s < 0 or s > 10:
                errors.append('health_score must be between 0 and 10')
        except (ValueError, TypeError):
            errors.append('health_score must be a number')

    return errors


@app.route('/api/meals', methods=['GET'])
def list_meals():
    """List all meal records, optionally filtered by date range or specific date."""
    from_date = request.args.get('from')
    to_date = request.args.get('to')
    date = request.args.get('date')
    meals = meal_models.get_all_meals(from_date=from_date, to_date=to_date, date=date)
    return jsonify(meals)


@app.route('/api/meals/<int:meal_id>', methods=['GET'])
def get_meal(meal_id):
    """Get a single meal record by ID."""
    meal = meal_models.get_meal_by_id(meal_id)
    if meal is None:
        return jsonify({'error': 'Meal record not found'}), 404
    return jsonify(meal)


@app.route('/api/meals', methods=['POST'])
def create_meal():
    """Create a new meal record."""
    data = request.get_json()
    if not data:
        return jsonify({'error': 'Request body must be JSON'}), 400

    errors = _validate_meal_data(data)
    if errors:
        return jsonify({'error': errors[0]}), 400

    meal = meal_models.create_meal(data)
    return jsonify(meal), 201


@app.route('/api/meals/<int:meal_id>', methods=['PUT'])
def update_meal(meal_id):
    """Update an existing meal record by ID."""
    data = request.get_json()
    if not data:
        return jsonify({'error': 'Request body must be JSON'}), 400

    errors = _validate_meal_data(data)
    if errors:
        return jsonify({'error': errors[0]}), 400

    meal = meal_models.update_meal_by_id(meal_id, data)
    if meal is None:
        return jsonify({'error': 'Meal record not found'}), 404
    return jsonify(meal)


@app.route('/api/meals/<int:meal_id>', methods=['DELETE'])
def delete_meal(meal_id):
    """Delete a meal record by ID."""
    deleted = meal_models.delete_meal_by_id(meal_id)
    if not deleted:
        return jsonify({'error': 'Meal record not found'}), 404
    return '', 204


@app.route('/api/meals/analyze', methods=['POST'])
def analyze_meal():
    """Estimate nutrition for a meal from its text description.

    Read-only: returns an estimate for the user to review and edit before it
    is ever persisted. Nothing is written here — saving goes through the
    normal POST/PUT /api/meals routes.

    Route is declared before /api/meals/<int:meal_id> would matter only for
    GET; this is POST-only so there is no ambiguity either way.
    """
    data = request.get_json(silent=True) or {}

    meal_type = data.get('meal_type', '')
    if meal_type and meal_type not in ('breakfast', 'lunch', 'dinner', 'snack'):
        return jsonify({'error': 'meal_type 取值无效'}), 400

    # The model round-trip takes several seconds; a second click would just
    # duplicate the cost. The frontend disables the button, this is the
    # backstop for programmatic callers.
    try:
        result = nutrition.analyze_meal(
            meal_name=data.get('meal_name', ''),
            meal_content=data.get('meal_content', ''),
            meal_quantity=data.get('meal_quantity') or 'normal',
            meal_type=meal_type,
        )
    except Exception as e:
        # Defensive backstop: nutrition.analyze_meal is meant to never raise,
        # but if anything escapes we return a friendly 502 instead of a 500.
        return jsonify({'error': f'AI 估算失败：{e}'}), 502

    if not result.get('ok'):
        # 502 rather than 500: the failure is upstream (LLM/credentials),
        # not a bug in our handler, and the message is user-facing.
        return jsonify({'error': result.get('error', 'AI 估算失败')}), 502

    return jsonify(result['data'])


@app.route('/api/meals/analyze-image', methods=['POST'])
def meal_analyze_image():
    """Estimate nutrition for a meal from a photo (multipart/form-data).

    Read-only, mirrors /api/meals/analyze: returns an estimate for the user to
    review before persisting. Expects an 'image' file plus optional form fields
    'meal_name' / 'meal_type' / 'meal_quantity'. The image is used for
    recognition only — it is not stored here.
    """
    upload = request.files.get('image')
    if not upload or not upload.filename:
        return jsonify({'error': '未收到图片文件'}), 400

    raw = upload.read()
    if len(raw) == 0:
        return jsonify({'error': '图片为空'}), 400
    if len(raw) > 10 * 1024 * 1024:
        return jsonify({'error': '图片过大（上限 10MB）'}), 413

    meal_type = request.form.get('meal_type', '')
    if meal_type and meal_type not in ('breakfast', 'lunch', 'dinner', 'snack'):
        return jsonify({'error': 'meal_type 取值无效'}), 400

    try:
        result = nutrition.analyze_meal_image(
            raw,
            meal_name=request.form.get('meal_name', ''),
            meal_quantity=request.form.get('meal_quantity') or 'normal',
            meal_type=meal_type,
        )
    except Exception as e:
        # Defensive backstop: nutrition.analyze_meal_image is meant to never
        # raise, but if anything escapes we return a friendly 502.
        return jsonify({'error': f'图片分析失败：{e}'}), 502

    if not result.get('ok'):
        return jsonify({'error': result.get('error', '图片分析失败')}), 502

    return jsonify(result['data'])


@app.route('/api/meals/analyze-images', methods=['POST'])
def meal_analyze_images():
    """Estimate nutrition from before/after meal photos (multipart/form-data).

    Accepts multiple 'before' files and optional multiple 'after' files.
    Read-only, mirrors /api/meals/analyze: returns an estimate for review
    before persisting. Also tolerates a single 'image' field (single-photo
    path) for backwards compatibility.
    """
    before = [
        f.read() for f in request.files.getlist('before')
        if f and f.filename
    ]
    after = [
        f.read() for f in request.files.getlist('after')
        if f and f.filename
    ]
    if not before and not after:
        single = request.files.get('image')
        if single and single.filename:
            before = [single.read()]

    before = [b for b in before if b and len(b) <= 10 * 1024 * 1024]
    after = [b for b in after if b and len(b) <= 10 * 1024 * 1024]
    if not before and not after:
        return jsonify({'error': '未收到图片文件'}), 400

    meal_type = request.form.get('meal_type', '')
    if meal_type and meal_type not in ('breakfast', 'lunch', 'dinner', 'snack'):
        return jsonify({'error': 'meal_type 取值无效'}), 400

    try:
        result = nutrition.analyze_meal_images(
            before, after,
            meal_name=request.form.get('meal_name', ''),
            meal_quantity=request.form.get('meal_quantity') or 'normal',
            meal_type=meal_type,
        )
    except Exception as e:
        # Defensive backstop: nutrition.analyze_meal_images is meant to never
        # raise, but if anything escapes we return a friendly 502.
        return jsonify({'error': f'图片分析失败：{e}'}), 502

    if not result.get('ok'):
        return jsonify({'error': result.get('error', '图片分析失败')}), 502

    return jsonify(result['data'])


@app.route('/api/meals/nutrition/summary', methods=['GET'])
def meal_nutrition_summary():
    """Aggregate nutrition totals over a date range (or a single date).

    Returns {"summary": null} when none of the meals in range carry numeric
    nutrition data, so the UI can show an empty state instead of a row of
    misleading zeros.
    """
    from_date = request.args.get('from')
    to_date = request.args.get('to')
    date = request.args.get('date')

    try:
        meals = meal_models.get_all_meals(from_date=from_date, to_date=to_date, date=date)
    except Exception as e:
        return jsonify({'error': f'读取餐食记录失败：{e}'}), 500

    summary = nutrition.summarize(meals)
    return jsonify({'summary': summary, 'meal_count': len(meals)})


# ──────────────────────────────────────────────
#  Cross-day daily brief (yesterday diet + this morning metrics)
# ──────────────────────────────────────────────

def _today_local():
    """Server-local today as YYYY-MM-DD (fallback only; the UI passes its own)."""
    from datetime import date as _d
    return _d.today().isoformat()


def _sleep_minutes(rec):
    """Minutes between sleep_time and wake_time, or None when unavailable."""
    st = rec.get('sleep_time')
    wt = rec.get('wake_time')
    if not st or not wt:
        return None
    try:
        from datetime import datetime as _dt
        a = _dt.fromisoformat(st)
        b = _dt.fromisoformat(wt)
        return max(0, int((b - a).total_seconds() // 60))
    except Exception:
        return None


def _extract_morning(date_str):
    """Pull this-morning body metrics from the sleep_records for `date_str`."""
    records = models.get_all_records(date=date_str)
    if not records:
        return {'weight': None, 'water_cups': None, 'steps': None,
                'sleep_minutes': None, 'sleep_quality': None}
    # Weight / water / steps live on the night record (per schema v4).
    night = next((r for r in records if r.get('record_type') == 'night'), records[0])
    return {
        'weight': night.get('weight'),
        'water_cups': night.get('water_cups'),
        'steps': night.get('steps'),
        'sleep_minutes': _sleep_minutes(night),
        'sleep_quality': night.get('sleep_quality'),
    }


def _compute_7d_trends(date_str):
    """7-day rolling summary for body metrics — gives the LLM real
    longitudinal context (not just a single point in time).

    Returns a dict like:
        {'weight': {'mean': 66.3, 'min': 65.7, 'max': 66.9, 'n': 6, 'delta_kg': -0.5,
                    'trend': 'down'},
         'water_cups': {...},
         'steps': {...},
         'sleep_minutes': {...}}
    """
    from datetime import date as _d, timedelta as _td
    try:
        d0 = _d.fromisoformat(date_str)
    except ValueError:
        return {}
    since = (d0 - _td(days=6)).isoformat()

    rows = models.get_all_records(from_date=since, to_date=date_str) or []
    by_field = {'weight': [], 'water_cups': [], 'steps': [], 'sleep_minutes': []}
    for r in rows:
        if r.get('record_type') != 'night':
            continue
        if r.get('weight') is not None:
            by_field['weight'].append((r['record_date'], float(r['weight'])))
        if r.get('water_cups') is not None:
            by_field['water_cups'].append((r['record_date'], int(r['water_cups'])))
        if r.get('steps') is not None:
            by_field['steps'].append((r['record_date'], int(r['steps'])))
        sm = _sleep_minutes(r)
        if sm:
            by_field['sleep_minutes'].append((r['record_date'], sm))

    out = {}
    for k, pts in by_field.items():
        if len(pts) < 2:
            continue
        pts.sort(key=lambda x: x[0])
        vals = [v for _, v in pts]
        first, last = vals[0], vals[-1]
        delta = last - first
        # crude trend label: |delta|/n > 5% of mean → "up"/"down"
        mean = sum(vals) / len(vals)
        ratio = (abs(delta) / mean) if mean else 0
        if ratio < 0.05:
            trend = 'flat'
        elif delta > 0:
            trend = 'up'
        else:
            trend = 'down'
        out[k] = {
            'mean': round(mean, 2),
            'min': round(min(vals), 2),
            'max': round(max(vals), 2),
            'n': len(vals),
            'delta': round(delta, 2),
            'trend': trend,
        }
    return out


def _profile_defaults():
    """Minimal user profile for the LLM context.

    Reads from env vars if set, else falls back to neutral defaults. Kept
    in-process (not in DB) because we don't have a profile schema yet.
    """
    return {
        'age': int(os.environ.get('USER_AGE', '0') or 0) or None,
        'sex': os.environ.get('USER_SEX') or None,
        'height_cm': float(os.environ.get('USER_HEIGHT_CM', '0') or 0) or None,
        'goal': os.environ.get('USER_GOAL') or None,         # 'lose_fat' | 'maintain' | 'gain_muscle'
        'activity_level': os.environ.get('USER_ACTIVITY') or None,  # 'sedentary' | 'light' | 'moderate' | 'active'
    }


def _antidepressant_streak(date_str):
    """Consecutive days ending at `date_str` with ≥1 antidepressant logged.

    Counts backwards from the given day and stops at the first gap — this is
    the "连服 X 天" figure we feed the LLM so it can contextualise SSRI /
    TCM-antidepressant effects against the sleep/recovery trend.
    """
    from datetime import date as _d, timedelta as _td
    try:
        d0 = _d.fromisoformat(date_str)
    except ValueError:
        return 0
    streak = 0
    conn = get_connection()
    try:
        while True:
            n = conn.execute(
                "SELECT COUNT(*) FROM medication_records "
                "WHERE record_date = ? AND category = 'antidepressant'",
                (d0.isoformat(),),
            ).fetchone()[0]
            if n >= 1:
                streak += 1
                d0 -= _td(days=1)
            else:
                break
    finally:
        conn.close()
    return streak


def _medication_context(date_str):
    """Roll up today's medication log for the LLM briefs.

    Returns {summary, first_date, streak_days} or an all-empty equivalent.
    Never raises — a broken med read must not kill the AI brief.
    """
    summary = None
    first_date = None
    streak_days = 0
    try:
        summary = medication_models.get_daily_medication_summary(date_str)
    except Exception:
        summary = None
    try:
        conn = get_connection()
        row = conn.execute("SELECT MIN(record_date) FROM medication_records").fetchone()
        conn.close()
        if row and row[0]:
            first_date = row[0]
            streak_days = _antidepressant_streak(date_str)
    except Exception:
        pass
    return {
        'summary': summary,
        'first_date': first_date,
        'streak_days': streak_days,
    }


@app.route('/api/daily-brief', methods=['GET'])
def daily_brief():
    """Cross-day health brief: yesterday's diet paired with this morning's
    body metrics (weight / water / steps / sleep), interpreted by the LLM.
    """
    date = request.args.get('date') or _today_local()
    from datetime import date as _d, timedelta as _td
    try:
        d0 = _d.fromisoformat(date)
    except ValueError:
        return jsonify({'error': 'date 参数格式应为 YYYY-MM-DD'}), 400

    yesterday = (d0 - _td(days=1)).isoformat()

    try:
        meals = meal_models.get_all_meals(date=yesterday)
    except Exception as e:
        return jsonify({'error': f'读取饮食记录失败：{e}'}), 500

    meal_summary = nutrition.summarize(meals)
    morning = _extract_morning(date)
    trends = _compute_7d_trends(date)
    profile = _profile_defaults()

    try:
        result = nutrition.daily_brief(yesterday, date, meal_summary, morning,
                                      trends=trends, profile=profile,
                                      medication=_medication_context(date))
    except Exception as e:
        return jsonify({'error': f'生成简报失败：{e}'}), 500

    if not result.get('ok'):
        return jsonify({'error': result.get('error', '生成失败')}), 502

    brief_text = (result['data']['brief'] or '').strip()

    # Persist the freshly generated brief as the conversation's first turn so
    # it survives page refresh / device switch / date switch. Skip when this
    # date already has history (avoid duplicating the original summary).
    try:
        conn = get_connection()
        row = conn.execute(
            "SELECT COUNT(*) FROM brief_chat_messages "
            "WHERE brief_date = ? AND role = 'assistant'",
            (date,)
        ).fetchone()
        if brief_text and row and row[0] == 0:
            conn.execute(
                "INSERT INTO brief_chat_messages (brief_date, role, content) "
                "VALUES (?, 'assistant', ?)",
                (date, brief_text),
            )
            conn.commit()
    except Exception as e:
        # Persistence must never break the visible brief.
        print(f"[daily-brief] persist first turn failed: {e}", file=sys.stderr)

    return jsonify({
        'date': date,
        'diet_date': yesterday,
        'meal_summary': meal_summary,
        'morning': morning,
        'brief': brief_text,
    })


@app.route('/api/daily-brief/chat', methods=['GET'])
def daily_brief_chat_list():
    """Return the persisted chat history for a given brief date.

    Frontend uses this to restore the conversation after a page refresh or
    device switch. Newest messages last; the 'brief' field is the most
    recent first turn's assistant reply (i.e. the original summary) so
    'previous_brief' can be reconstructed on the client.
    """
    date = (request.args.get('date') or _today_local()).strip()
    rows = get_connection().execute(
        "SELECT id, role, content, created_at FROM brief_chat_messages "
        "WHERE brief_date = ? ORDER BY id ASC",
        (date,)
    ).fetchall()
    history = [{'id': r[0], 'role': r[1], 'content': r[2], 'created_at': r[3]} for r in rows]
    return jsonify({'date': date, 'history': history})


@app.route('/api/daily-brief/chat', methods=['POST'])
def daily_brief_chat():
    """Continue the cross-day brief as a conversation.

    The client sends the current date, the previously generated brief, and
    the user's follow-up message. The server re-fetches the underlying data
    so the reply is always grounded in the latest records.

    Persistence (v17+): every turn is stored in `brief_chat_messages` so
    the thread survives page reloads. The previous N turns are loaded from
    the database and passed to the model as conversation history.
    """
    body = request.get_json(silent=True) or {}
    date = body.get('date') or _today_local()
    user_message = (body.get('user_message') or '').strip()
    previous_brief = (body.get('previous_brief') or '').strip()

    if not user_message:
        return jsonify({'error': 'user_message 不能为空'}), 400
    if not previous_brief:
        return jsonify({'error': '请先生成昨日汇总，再开始对话。'}), 400

    from datetime import date as _d, timedelta as _td
    try:
        d0 = _d.fromisoformat(date)
    except ValueError:
        return jsonify({'error': 'date 参数格式应为 YYYY-MM-DD'}), 400

    yesterday = (d0 - _td(days=1)).isoformat()

    # ── Load history from DB (v17+ persistence) ──
    # Prefer DB-stored history; fall back to client-supplied list if DB empty
    # (e.g. first message right after the brief was just generated).
    conn = get_connection()
    db_rows = conn.execute(
        "SELECT role, content FROM brief_chat_messages WHERE brief_date = ? ORDER BY id ASC",
        (date,)
    ).fetchall()
    history = [{'role': r[0], 'content': r[1]} for r in db_rows]
    if not history:
        raw_history = body.get('history')
        if isinstance(raw_history, list):
            for turn in raw_history:
                if not isinstance(turn, dict):
                    continue
                role = turn.get('role')
                content = (turn.get('content') or '').strip()
                if role in ('user', 'assistant') and content:
                    history.append({'role': role, 'content': content[:2000]})
    history = history[-20:]  # wider context window now that we have DB

    # ── Persist the new user turn before the model runs (so even a 5xx mid-flight
    #    leaves a recoverable trail). Wrap in a savepoint so a DB blip
    #    doesn't fail the whole endpoint.
    try:
        conn.execute(
            "INSERT INTO brief_chat_messages (brief_date, role, content) VALUES (?, ?, ?)",
            (date, 'user', user_message[:4000]),
        )
        conn.commit()
    except Exception as e:
        print(f"[brief_chat] failed to persist user turn: {e}")

    try:
        meals = meal_models.get_all_meals(date=yesterday)
    except Exception as e:
        return jsonify({'error': f'读取饮食记录失败：{e}'}), 500

    meal_summary = nutrition.summarize(meals)
    morning = _extract_morning(date)
    # 7-day rolling trend block — gives the model real longitudinal context
    trends = _compute_7d_trends(date)
    profile = _profile_defaults()

    try:
        result = nutrition.chat_brief(
            yesterday, date, meal_summary, morning, previous_brief, user_message,
            history=history,
            trends=trends,
            profile=profile,
            medication=_medication_context(date),
        )
    except Exception as e:
        return jsonify({'error': f'生成回复失败：{e}'}), 500

    if not result.get('ok'):
        return jsonify({'error': result.get('error', '生成失败')}), 502

    reply_text = result['data']['brief']

    # ── Persist the assistant reply (best-effort) ──
    try:
        conn.execute(
            "INSERT INTO brief_chat_messages (brief_date, role, content) VALUES (?, ?, ?)",
            (date, 'assistant', reply_text[:4000]),
        )
        conn.commit()
    except Exception as e:
        print(f"[brief_chat] failed to persist assistant turn: {e}")

    # Re-read full history so the client doesn't have to merge optimistically
    full_rows = conn.execute(
        "SELECT id, role, content, created_at FROM brief_chat_messages WHERE brief_date = ? ORDER BY id ASC",
        (date,),
    ).fetchall()
    full_history = [{'id': r[0], 'role': r[1], 'content': r[2], 'created_at': r[3]} for r in full_rows]

    return jsonify({
        'date': date,
        'diet_date': yesterday,
        'reply': reply_text,
        'history': full_history,
    })


# ──────────────────────────────────────────────
#  Daily Combined Report (sleep + AI brief)
# ──────────────────────────────────────────────


def _compute_daily_sleep_summary(date_str):
    """Return a structured sleep summary for a single date."""
    from datetime import datetime, timedelta
    records = models.get_records_by_date(date_str)
    summary = {
        'date': date_str,
        'total_records': 0,
        'total_hours': 0.0,
        'total_minutes': 0,
        'quality_breakdown': {'good': 0, 'average': 0, 'poor': 0},
        'classification_breakdown': {'early': 0, 'late': 0},
        'type_breakdown': {'night': 0, 'nap': 0, 'segment': 0},
        'problem_frequency': {},
        'records': [],
    }
    if not records:
        return summary

    total_minutes = 0
    problem_counter = {}
    for r in records:
        sleep_dt = datetime.fromisoformat(r['sleep_time'])
        wake_dt = datetime.fromisoformat(r['wake_time'])
        if wake_dt <= sleep_dt:
            wake_dt += timedelta(days=1)
        duration_minutes = int((wake_dt - sleep_dt).total_seconds() / 60)
        total_minutes += duration_minutes

        quality = r.get('sleep_quality')
        if quality in summary['quality_breakdown']:
            summary['quality_breakdown'][quality] += 1
        classification = r.get('classification')
        if classification in summary['classification_breakdown']:
            summary['classification_breakdown'][classification] += 1
        record_type = r.get('record_type', 'night')
        if record_type in summary['type_breakdown']:
            summary['type_breakdown'][record_type] += 1

        for p in r.get('sleep_problems') or []:
            problem_counter[p] = problem_counter.get(p, 0) + 1

        summary['records'].append({
            'type': record_type,
            'sleep_time': r['sleep_time'],
            'wake_time': r['wake_time'],
            'hours': round(duration_minutes / 60.0, 2),
            'minutes': duration_minutes,
            'quality': quality,
            'classification': classification,
            'problems': r.get('sleep_problems') or [],
        })

    summary['total_records'] = len(records)
    summary['total_minutes'] = total_minutes
    summary['total_hours'] = round(total_minutes / 60.0, 2)
    summary['problem_frequency'] = problem_counter
    return summary


def _format_combined_daily_report(sleep_summary, ai_brief_text):
    """Format a human-readable combined report from sleep summary + AI brief."""
    lines = [f'# {sleep_summary["date"]} 每日综合报告', '']
    lines.append('## 🌙 睡眠摘要')
    lines.append(f'- 总睡眠：{sleep_summary["total_hours"]}h（{sleep_summary["total_records"]} 条记录）')
    q = sleep_summary['quality_breakdown']
    lines.append(f'- 睡眠质量：良好 {q["good"]} / 一般 {q["average"]} / 较差 {q["poor"]}')
    c = sleep_summary['classification_breakdown']
    lines.append(f'- 入睡分类：早睡 {c["early"]} / 晚睡 {c["late"]}')
    if sleep_summary.get('problem_frequency'):
        problem_names = {
            'insomnia': '失眠', 'dreams': '多梦', 'sweats': '多汗',
            'waking': '频醒', 'early_waking': '早醒'
        }
        probs = ' / '.join(
            f'{problem_names.get(k, k)} {v} 次'
            for k, v in sleep_summary['problem_frequency'].items()
        )
        lines.append(f'- 睡眠问题：{probs}')
    lines.append('')
    lines.append('## 🤖 AI 分析结论')
    lines.append(ai_brief_text)
    return '\n'.join(lines)


@app.route('/api/daily-report', methods=['GET'])
def get_daily_report():
    """Return the saved combined report for a specific date."""
    date = request.args.get('date') or _today_local()
    try:
        from datetime import date as _d
        _d.fromisoformat(date)
    except ValueError:
        return jsonify({'error': 'date 参数格式应为 YYYY-MM-DD'}), 400

    report = daily_report_models.get_daily_report(date)
    if not report:
        return jsonify({'date': date, 'report': None}), 404
    return jsonify({'date': date, 'report': report})


@app.route('/api/daily-report/dates', methods=['GET'])
def list_daily_report_dates():
    """List dates that already have a saved combined report."""
    limit = request.args.get('limit', 365, type=int)
    offset = request.args.get('offset', 0, type=int)
    dates = daily_report_models.list_daily_report_dates(limit=limit, offset=offset)
    return jsonify({'dates': dates})


@app.route('/api/daily-report/generate', methods=['POST'])
def generate_daily_report():
    """Generate and persist a combined daily report for the given date.

    Combines:
      - Sleep summary for the date (from sleep_records)
      - AI cross-day brief (yesterday diet + this morning metrics)
    """
    from datetime import date as _d, timedelta as _td
    date = request.args.get('date') or _today_local()
    try:
        d0 = _d.fromisoformat(date)
    except ValueError:
        return jsonify({'error': 'date 参数格式应为 YYYY-MM-DD'}), 400

    yesterday = (d0 - _td(days=1)).isoformat()

    # Sleep summary for the target date
    try:
        sleep_summary = _compute_daily_sleep_summary(date)
    except Exception as e:
        return jsonify({'error': f'读取睡眠记录失败：{e}'}), 500

    # AI brief: yesterday diet + this morning metrics
    try:
        meals = meal_models.get_all_meals(date=yesterday)
    except Exception as e:
        return jsonify({'error': f'读取饮食记录失败：{e}'}), 500

    meal_summary = nutrition.summarize(meals)
    morning = _extract_morning(date)
    trends = _compute_7d_trends(date)
    profile = _profile_defaults()

    try:
        result = nutrition.daily_brief(yesterday, date, meal_summary, morning,
                                       trends=trends, profile=profile,
                                       medication=_medication_context(date))
    except Exception as e:
        return jsonify({'error': f'生成 AI 简报失败：{e}'}), 500

    if not result.get('ok'):
        return jsonify({'error': result.get('error', '生成失败')}), 502

    ai_brief_text = result['data']['brief']
    combined_text = _format_combined_daily_report(sleep_summary, ai_brief_text)

    try:
        report = daily_report_models.save_daily_report(
            date, sleep_summary, ai_brief_text, combined_text
        )
    except Exception as e:
        return jsonify({'error': f'保存报告失败：{e}'}), 500

    return jsonify({'date': date, 'report': report})


# ──────────────────────────────────────────────
#  Period / Menstrual Cycle Tracking
# ──────────────────────────────────────────────


@app.route('/api/periods', methods=['GET'])
def list_periods():
    """List period records, optionally filtered by date range or specific date."""
    from_date = request.args.get('from')
    to_date = request.args.get('to')
    date = request.args.get('date')
    periods = period_models.get_all_periods(from_date=from_date, to_date=to_date, date=date)
    return jsonify(periods)


@app.route('/api/periods/summary', methods=['GET'])
def period_cycle_summary():
    """Return cycle statistics + predictions (next period, ovulation, current phase)."""
    summary = period_models.get_cycle_summary()
    return jsonify(summary)


@app.route('/api/periods/<int:period_id>', methods=['GET'])
def get_period(period_id):
    """Get a single period record by ID."""
    period = period_models.get_period_by_id(period_id)
    if period is None:
        return jsonify({'error': 'Period record not found'}), 404
    return jsonify(period)


@app.route('/api/periods', methods=['POST'])
def create_period():
    """Create a new period record."""
    data = request.get_json()
    if not data:
        return jsonify({'error': 'Request body must be JSON'}), 400

    errors = _validate_period_data(data)
    if errors:
        return jsonify({'error': errors[0]}), 400

    period = period_models.create_period(data)
    return jsonify(period), 201


@app.route('/api/periods/<int:period_id>', methods=['PUT'])
def update_period(period_id):
    """Update an existing period record by ID."""
    data = request.get_json()
    if not data:
        return jsonify({'error': 'Request body must be JSON'}), 400

    errors = _validate_period_data(data, partial=True)
    if errors:
        return jsonify({'error': errors[0]}), 400

    period = period_models.update_period_by_id(period_id, data)
    if period is None:
        return jsonify({'error': 'Period record not found'}), 404
    return jsonify(period)


@app.route('/api/periods/<int:period_id>', methods=['DELETE'])
def delete_period(period_id):
    """Delete a period record by ID."""
    deleted = period_models.delete_period_by_id(period_id)
    if not deleted:
        return jsonify({'error': 'Period record not found'}), 404
    return '', 204


def _validate_period_data(data, partial=False):
    """Validate period record input. Returns a list of error strings (empty = ok)."""
    errors = []
    if not partial or 'record_date' in data:
        if not data.get('record_date'):
            errors.append('请选择日期。')
    if 'flow' in data and data['flow'] not in ('none', 'light', 'normal', 'heavy'):
        errors.append('流量取值无效。')
    return errors


# ──────────────────────────────────────────────
#  Medication Tracking
# ──────────────────────────────────────────────


# Allowed values mirror the CHECK constraints declared in database.py.
_MED_DOSAGE_UNITS = {'粒', '支', '片', 'ml', 'mg', '滴', '袋', '颗'}
_MED_CATEGORIES    = {'supplement', 'antidepressant', 'other'}
_MED_SLOTS         = {'morning', 'noon', 'evening', 'night'}

# Categories shown to users in Chinese on the form & list.
_MED_CATEGORY_LABELS = {
    'supplement':     '保健类',
    'antidepressant': '抗抑郁药',
    'other':          '其他',
}

# Slot labels (Chinese) used by the dashboard summary card.
_MED_SLOT_LABELS = {
    'morning': '早上',
    'noon':    '中午',
    'evening': '晚上',
    'night':   '睡前',
}


def _validate_medication_data(data, partial=False):
    """Validate medication record input. Returns a list of error strings."""
    errors = []

    if not partial or 'record_date' in data:
        if not data.get('record_date'):
            errors.append('请选择日期。')
    if 'dosage_unit' in data and data['dosage_unit'] not in _MED_DOSAGE_UNITS:
        errors.append(f'剂量单位必须是：{"/".join(sorted(_MED_DOSAGE_UNITS))}')
    if 'category' in data and data['category'] not in _MED_CATEGORIES:
        errors.append('类别取值无效（保健类/抗抑郁药/其他）。')
    if 'administration_slot' in data and data['administration_slot'] not in _MED_SLOTS:
        errors.append('时段取值无效。')

    # Always required for create; for partial update skip unless provided.
    if not partial:
        if not (data.get('medication_name') or '').strip():
            errors.append('请填写药名/补剂名。')
        if 'dosage' in data and data['dosage'] is not None and data['dosage'] != '':
            try:
                d = float(data['dosage'])
                if d <= 0 or d > 1000:
                    errors.append('剂量必须在 0–1000 之间。')
            except (ValueError, TypeError):
                errors.append('剂量必须是数字。')

    return errors


@app.route('/api/medications', methods=['GET'])
def list_medications():
    """List medication records, optionally filtered by date range or one date."""
    from_date = request.args.get('from')
    to_date = request.args.get('to')
    date = request.args.get('date')
    records = medication_models.get_all_medications(
        from_date=from_date, to_date=to_date, date=date
    )
    return jsonify(records)


@app.route('/api/medications/summary', methods=['GET'])
def medication_summary():
    """Aggregate today's medication log for the dashboard.

    Returns the roll-up produced by medication_models.get_daily_medication_summary().
    Missing date → empty summary (counts are 0, by_slot lists are empty).
    """
    from datetime import date as _date_cls
    date_str = (request.args.get('date') or _date_cls.today().isoformat()).strip()
    try:
        _date_cls.fromisoformat(date_str)
    except ValueError:
        return jsonify({'error': 'date 参数格式应为 YYYY-MM-DD'}), 400
    return jsonify({'date': date_str,
                    'summary': medication_models.get_daily_medication_summary(date_str),
                    'category_labels': _MED_CATEGORY_LABELS,
                    'slot_labels': _MED_SLOT_LABELS})


@app.route('/api/medications/<int:med_id>', methods=['GET'])
def get_medication(med_id):
    """Get a single medication record by ID."""
    record = medication_models.get_medication_by_id(med_id)
    if record is None:
        return jsonify({'error': 'Medication record not found'}), 404
    return jsonify(record)


@app.route('/api/medications', methods=['POST'])
def create_medication():
    """Create a new medication record."""
    data = request.get_json()
    if not data:
        return jsonify({'error': 'Request body must be JSON'}), 400

    errors = _validate_medication_data(data)
    if errors:
        return jsonify({'error': errors[0]}), 400

    record = medication_models.create_medication(data)
    return jsonify(record), 201


@app.route('/api/medications/<int:med_id>', methods=['PUT'])
def update_medication(med_id):
    """Update an existing medication record by ID."""
    data = request.get_json()
    if not data:
        return jsonify({'error': 'Request body must be JSON'}), 400

    errors = _validate_medication_data(data, partial=True)
    if errors:
        return jsonify({'error': errors[0]}), 400

    record = medication_models.update_medication_by_id(med_id, data)
    if record is None:
        return jsonify({'error': 'Medication record not found'}), 404
    return jsonify(record)


@app.route('/api/medications/<int:med_id>', methods=['DELETE'])
def delete_medication(med_id):
    """Delete a medication record by ID."""
    deleted = medication_models.delete_medication_by_id(med_id)
    if not deleted:
        return jsonify({'error': 'Medication record not found'}), 404
    return '', 204


@app.route('/api/medication-correlation', methods=['GET'])
def medication_correlation_route():
    """Medication × health correlation across a window.

    Groups Whoop recovery / RHR / HRV and sleep hours around the first
    medication day ("before" vs "after") and by daily adherence
    ("complete" vs "incomplete"). Optional query params:
        ?from=YYYY-MM-DD   window start (default: 13 days before first pill)
        ?to=YYYY-MM-DD     window end   (default: today)
    """
    from_date = request.args.get('from') or None
    to_date = request.args.get('to') or None

    def _valid(ds):
        try:
            from datetime import date as _d
            _d.fromisoformat(ds)
            return True
        except (TypeError, ValueError):
            return False

    if from_date and not _valid(from_date):
        return jsonify({'error': 'from 参数格式应为 YYYY-MM-DD'}), 400
    if to_date and not _valid(to_date):
        return jsonify({'error': 'to 参数格式应为 YYYY-MM-DD'}), 400

    try:
        from health_models import medication_correlation
        result = medication_correlation(from_date=from_date, to_date=to_date)
    except Exception as e:
        return jsonify({'error': f'关联分析失败：{e}'}), 500
    return jsonify(result)


# ──────────────────────────────────────────────
#  Whoop Integration (OAuth + Sync)
# ──────────────────────────────────────────────


@app.route('/api/whoop/auth')
def whoop_auth():
    """Redirect to Whoop OAuth authorization page."""
    from whoop.client import WhoopClient
    client = WhoopClient()
    if not client.client_id:
        return jsonify({'error': 'Whoop API not configured. Set WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET in .env'}), 400
    auth_url = client.get_authorization_url()
    return jsonify({'auth_url': auth_url})


@app.route('/api/whoop/callback')
def whoop_callback():
    """OAuth callback — exchange code for tokens."""
    code = request.args.get('code')
    state = request.args.get('state')
    error = request.args.get('error')
    if error:
        return jsonify({'error': f'Whoop authorization denied: {error}'}), 400
    if not code:
        return jsonify({'error': 'No authorization code provided'}), 400

    from whoop.client import WhoopClient
    client = WhoopClient()
    try:
        client.exchange_code(code, state=state)
        # Redirect back to main app — JS will detect connected status
        return redirect('/?whoop=connected')
    except Exception as e:
        # On error, still redirect to main app with error message
        error_msg = urllib.parse.quote(str(e))
        return redirect(f'/?whoop=error&msg={error_msg}')


@app.route('/api/whoop/status')
def whoop_status():
    """Check Whoop connection status."""
    try:
        from whoop.client import WhoopClient
        client = WhoopClient()
        authenticated = client.is_authenticated()
    except Exception as e:
        # DB (Turso) hiccup should not be reported as "not connected"
        return jsonify({'authenticated': False, 'db_error': True, 'error': str(e)})
    result = {'authenticated': authenticated}
    if authenticated:
        # Show masked client ID for reference
        result['client_id'] = client.client_id[:8] + '...'
    return jsonify(result)


def _get_meta(key, default=None):
    """Read a key from the _meta table (cross-run state like last sync time)."""
    try:
        conn = get_connection()
        try:
            conn.execute("CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT)")
            cur = conn.execute("SELECT value FROM _meta WHERE key = ?", (key,))
            row = cur.fetchone()
        finally:
            conn.close()
        return row[0] if row else default
    except Exception:
        return default


def _set_meta(key, value):
    """Write a key to the _meta table (best-effort)."""
    try:
        conn = get_connection()
        try:
            conn.execute("CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT)")
            conn.execute(
                "INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)",
                (str(key), str(value)),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception:
        pass


def _record_sync_time():
    """Stamp the last successful Whoop sync time, stored in Beijing time (+8)
    so it matches the timezone all other displayed times use in this app."""
    from datetime import datetime, timedelta
    beijing = datetime.now() + timedelta(hours=8)
    _set_meta("last_whoop_sync", beijing.strftime("%Y-%m-%d %H:%M:%S"))


def _sync_stats_succeeded(stats):
    """Return True only when a sync actually moved data.

    `sync_all_whoop()` never raises on auth failure — it returns per-source
    dicts like {"error": "Not authenticated with Whoop", "synced": 0} instead.
    Treating such a run as "successful" would keep refreshing last_sync_at and
    make the UI claim "最后同步：<now>" while nothing was ever written — which
    is exactly how a multi-day data gap stayed invisible for 5 days.
    """
    if not isinstance(stats, dict):
        return False
    total = 0
    for key in ("created", "updated", "synced"):
        try:
            total += int(stats.get(key) or 0)
        except (TypeError, ValueError):
            pass
    return total > 0


def _sync_stats_error(stats):
    """Extract the first per-source error message from sync stats, if any."""
    if not isinstance(stats, dict):
        return None
    for source in ("sleep", "daily", "workouts"):
        err = (stats.get(source) or {}).get("error")
        if err:
            return str(err)
    return None


def _whoop_authenticated():
    """Best-effort Whoop connection check that never raises.

    Returned by /api/sync-health so the frontend can trust the backend's
    authoritative state instead of scraping its own status text from the DOM.
    """
    try:
        from whoop.client import WhoopClient
        return bool(WhoopClient().is_authenticated())
    except Exception:
        return False


def _stamp_sync_outcome(stats):
    """Record sync outcome: refresh last_sync_at only on real data movement;
    otherwise persist the reason so the UI can surface the failure."""
    try:
        if _sync_stats_succeeded(stats):
            _record_sync_time()
            _set_meta("last_whoop_sync_error", "")
        else:
            err = _sync_stats_error(stats) or "未同步到任何数据（手环无新数据或未连接）"
            _set_meta("last_whoop_sync_error", err)
            print(f"[sync] no data synced: {err}")
    except Exception as e:
        print(f"[sync] failed to stamp outcome: {e}")


# ── Async Whoop sync (non-blocking) ────────────
# 同步要访问 Whoop 云端 + Turso 云数据库，可能很慢甚至卡住。
# 若在 Web 请求线程里同步执行，会把 waitress 工作线程占满，导致服务器整体无响应。
# 因此改为后台线程执行：Web 请求立即返回，前端轮询 /api/whoop/sync/status 取结果。

_sync_state = {
    "running": False,
    "started_at": None,   # epoch seconds
    "finished_at": None,  # epoch seconds
    "result": None,
    "error": None,
}

# 后台同步任务如果超过这么久仍未结束，就视为卡死/丢失，允许前端重新触发。
_SYNC_JOB_MAX_AGE_SECONDS = 5 * 60


def _is_sync_stale():
    """Return True if a previously-started sync is suspiciously old."""
    if not _sync_state["running"] or not _sync_state["started_at"]:
        return False
    return (time.time() - _sync_state["started_at"]) > _SYNC_JOB_MAX_AGE_SECONDS


def _reset_sync_state():
    """Mark any running sync as finished-with-timeout."""
    _sync_state["running"] = False
    _sync_state["finished_at"] = time.time()
    if _sync_state["error"] is None and _sync_state["result"] is None:
        _sync_state["error"] = {
            "message": "同步任务超时未完成，请检查后端日志或重启服务",
            "need_auth": False,
        }


def _run_sync_job(days_back):
    """Run the Whoop sync in a daemon thread; update _sync_state."""
    global _sync_state
    _sync_state["started_at"] = time.time()
    _sync_state["error"] = None
    _sync_state["result"] = None
    try:
        from whoop.sync import sync_all_whoop
        stats = sync_all_whoop(days_back=days_back)
        _sync_state["result"] = stats
    except PermissionError as e:
        _sync_state["error"] = {"message": str(e), "need_auth": True}
    except Exception as e:
        _sync_state["error"] = {"message": str(e), "need_auth": False}
    else:
        # 只有真正写入/更新了数据才算同步成功；空跑时记录原因，不再刷新
        # last_sync_at（否则前端会一直显示“最后同步：刚刚”，掩盖掉线故障）
        _stamp_sync_outcome(stats)
    finally:
        _sync_state["running"] = False
        _sync_state["finished_at"] = time.time()


@app.route('/api/whoop/sync', methods=['POST'])
def whoop_sync():
    """Trigger a Whoop data sync. Runs in background; poll /api/whoop/sync/status."""
    days_back = request.args.get('days', 30, type=int)
    if _sync_state["running"]:
        if _is_sync_stale():
            _reset_sync_state()
        else:
            return jsonify({"status": "already_running", "started_at": _sync_state["started_at"]})
    _sync_state["running"] = True
    _sync_state["started_at"] = time.time()
    threading.Thread(target=_run_sync_job, args=(days_back,), daemon=True).start()
    return jsonify({"status": "started", "started_at": _sync_state["started_at"]})


@app.route('/api/whoop/sync/status')
def whoop_sync_status():
    """Poll the current/last Whoop sync job state."""
    st = dict(_sync_state)
    if st["started_at"]:
        st["elapsed"] = int(time.time() - st["started_at"])
    return jsonify(st)


@app.route('/api/healthz')
def healthz():
    """Lightweight liveness probe — does NOT touch DB or Whoop.
    Use this to tell 'server alive' from 'server wedged'."""
    return jsonify({"status": "ok", "now": int(time.time())})


@app.route('/api/sync-health')
def sync_health():
    """Report sync health facts: whether a given date's sleep arrived + last sync.

    The 'date' param is supplied by the client in its own local timezone (browser)
    to avoid server/UTC drift. The *decision* of whether a gap is suspected is left
    to the client, which knows the user's real local time — this endpoint only
    returns the raw facts.
    """
    from datetime import datetime, timedelta
    from database import get_connection
    date = request.args.get('date') or (datetime.now() + timedelta(hours=8)).strftime("%Y-%m-%d")
    try:
        conn = get_connection()
        try:
            cur = conn.execute(
                "SELECT COUNT(*) AS c FROM sleep_records WHERE record_date = ?", (date,)
            )
            row = cur.fetchone()
            sleep_count = int(row[0]) if row else 0
            cur2 = conn.execute("SELECT COUNT(*) AS c FROM sleep_records")
            row2 = cur2.fetchone()
            total = int(row2[0]) if row2 else 0
            # 最后一条记录的日期 → 前端据此展示“已断档 N 天”。
            # 单日缺失（今天还没睡）属正常，连续多日缺失才值得报警。
            cur3 = conn.execute("SELECT MAX(record_date) AS d FROM sleep_records")
            row3 = cur3.fetchone()
            last_record_date = (row3[0] if row3 else None)
        finally:
            conn.close()
    except Exception as e:
        # DB (Turso) unreachable — report facts we have, flag the DB error
        return jsonify({
            "date": date,
            "sleep_count": 0,
            "has_history": None,
            "last_sync_at": _get_meta("last_whoop_sync", None),
            "last_sync_error": _get_meta("last_whoop_sync_error", None),
            "authenticated": _whoop_authenticated(),
            "db_error": True,
            "error": str(e),
        })
    # 断档天数：最后一条记录距今几个自然日（今天 8-31、末条 8-26 → 5）
    missing_days = 0
    if last_record_date:
        try:
            from datetime import date as _date_cls
            last_d = _date_cls.fromisoformat(last_record_date[:10])
            today_d = _date_cls.fromisoformat(str(date)[:10])
            missing_days = max(0, (today_d - last_d).days)
        except (ValueError, TypeError):
            missing_days = 0

    return jsonify({
        "date": date,
        "sleep_count": sleep_count,
        "has_history": total > 0,
        "last_record_date": last_record_date,
        "missing_days": missing_days,
        "last_sync_at": _get_meta("last_whoop_sync", None),
        # 非空 → 上一次同步“跑了但没拿到数据”，前端据此报警而非显示假的成功时间
        "last_sync_error": _get_meta("last_whoop_sync_error", None),
        # 由后端权威判定连接状态，前端不再依赖 DOM 文本猜测
        "authenticated": _whoop_authenticated(),
    })


@app.route('/api/whoop/daily')
def whoop_daily():
    """Return Whoop daily metrics (recovery + strain/HR) for a date range."""
    from_date = request.args.get('from')
    to_date = request.args.get('to')
    from health_models import get_whoop_daily
    return jsonify(get_whoop_daily(from_date, to_date))


@app.route('/api/whoop/workouts')
def whoop_workouts():
    """Return Whoop workout sessions for a date range."""
    from_date = request.args.get('from')
    to_date = request.args.get('to')
    from health_models import get_workouts
    return jsonify(get_workouts(from_date, to_date))


@app.route('/api/healthkit/ingest', methods=['POST'])
def healthkit_ingest():
    """Receive Apple Health / external metric pushes (e.g. Health Auto Export).

    Accepts several shapes for flexibility:
      Single:  {"date": "2026-08-02", "metric_type": "steps", "value": 12345}
      Batch:   [{"date":"...","metric_type":"steps","value":...}, ...]
      HAExport-style: {"date":"...", "metric_type":"StepCount", "value": 12345}
      Apple-format: {"startDate":"2026-08-02", "type":"StepCount", "value":12345, "unit":"count"}
    Rejects nothing destructive; only inserts/updates health_metrics rows.
    """
    # ── 共享密钥校验：防止局域网 / Tailscale 网内任意设备写入健康数据 ──
    api_key = os.environ.get('HEALTHKIT_API_KEY')
    if api_key:
        provided = request.args.get('key') or request.headers.get('X-Api-Key')
        if provided != api_key:
            return jsonify({'error': 'Unauthorized: missing or invalid API key'}), 401
    else:
        global _ingest_key_warned
        if not _ingest_key_warned:
            print("[SECURITY] HEALTHKIT_API_KEY 未配置，/api/healthkit/ingest 接受无密钥写入。"
                  "局域网 / Tailscale 内任意设备可写入健康数据，建议配置共享密钥。")
            _ingest_key_warned = True

    from health_models import bulk_upsert_health_metrics, upsert_health_metric
    try:
        payload = request.get_json(force=True, silent=True)
    except Exception:
        payload = None
    if payload is None:
        return jsonify({'error': 'Invalid JSON body'}), 400

    source = request.args.get('source') or request.headers.get('X-Source') or 'apple_health'
    rows = []

    def _norm(rec):
        import re
        from datetime import datetime
        d = rec.get('date') or rec.get('metric_date') or rec.get('startDate') or rec.get('dateValue')
        mt = rec.get('metric_type') or rec.get('type') or rec.get('metricType')
        val = rec.get('value')
        if d and mt is not None and val is not None:
            d_str = str(d).strip()
            # Robust date parsing: ISO 8601, slash/local formats, etc.
            try:
                parsed = datetime.fromisoformat(d_str.replace('Z', '+00:00'))
                d_str = parsed.strftime('%Y-%m-%d')
            except ValueError:
                m = re.search(r'(\d{4})[-/](\d{1,2})[-/](\d{1,2})', d_str)
                if m:
                    d_str = f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
                else:
                    d_str = d_str[:10]
            return (d_str, str(mt), float(val))
        return None

    if isinstance(payload, list):
        for rec in payload:
            n = _norm(rec)
            if n:
                rows.append(n)
    elif isinstance(payload, dict):
        n = _norm(payload)
        if n:
            rows.append(n)
        # Health Auto Export "nested" style: {"date":"...", "StepCount":12345, "ActiveEnergy":300}
        # Only treat top-level numeric keys as metrics when there is NO explicit
        # metric_type/type (otherwise keys like "value" would be mis-read as a metric).
        has_explicit_type = ('metric_type' in payload) or ('type' in payload)
        if not has_explicit_type:
            date_key = payload.get('date') or payload.get('startDate') or payload.get('metric_date')
            if date_key:
                for k, v in payload.items():
                    if k in ('date', 'metric_date', 'startDate', 'endDate', 'unit', 'source', 'type', 'metric_type'):
                        continue
                    if isinstance(v, (int, float)):
                        rows.append((str(date_key)[:10], str(k), float(v)))

    if not rows:
        return jsonify({'error': 'No valid metric rows found', 'received': payload}), 400

    count = bulk_upsert_health_metrics(rows, source=source)
    return jsonify({'ok': True, 'inserted': count})


@app.route('/api/healthkit/metrics')
def healthkit_metrics():
    """Query stored health metrics by type (default: steps)."""
    metric_type = request.args.get('type', 'steps')
    from_date = request.args.get('from')
    to_date = request.args.get('to')
    from health_models import get_health_metrics
    return jsonify(get_health_metrics(metric_type, from_date, to_date))


@app.route('/api/health-overview')
def health_overview():
    """Combined cross-source daily health series for the dashboard."""
    from_date = request.args.get('from')
    to_date = request.args.get('to')
    if not from_date or not to_date:
        from datetime import datetime, timedelta
        to_date = datetime.now().strftime('%Y-%m-%d')
        from_date = (datetime.now() - timedelta(days=30)).strftime('%Y-%m-%d')
    from health_models import get_health_overview
    return jsonify(get_health_overview(from_date, to_date))


@app.route('/api/whoop/disconnect', methods=['POST'])
def whoop_disconnect():
    """Disconnect Whoop — remove stored tokens."""
    from whoop.client import WhoopClient
    client = WhoopClient()
    client.disconnect()
    return jsonify({'message': 'Whoop disconnected.'})


# ──────────────────────────────────────────────
#  Startup — conflict-free port allocation
# ──────────────────────────────────────────────


def _find_free_port():
    """Let the OS assign a truly free port (guaranteed no conflict).

    Binds a temp socket to port 0, the OS picks an unused port from the
    ephemeral range (49152-65535 on Windows). The socket is closed and
    Flask takes the port immediately after — the window is <1ms.
    """
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('0.0.0.0', 0))
        return s.getsockname()[1]


def _write_port_file(port):
    """Write the active port to .active_port so tools/scripts can read it."""
    import pathlib
    port_file = pathlib.Path(__file__).parent / ".active_port"
    port_file.write_text(str(port), encoding="utf-8")


def _read_port_file():
    """Read a previously saved port (only used when ENV var is set)."""
    import pathlib, os
    port = os.environ.get('PORT', '')
    if port:
        return int(port)
    return 0  # auto-detect


def _open_browser_after_delay(port, delay=2.5):
    """Automatically open the browser after Flask starts (non-blocking)."""
    import threading, time, webbrowser
    def _open():
        time.sleep(delay)
        url = f'http://localhost:{port}'
        print(f"  Auto-opening browser: {url}")
        webbrowser.open(url)
    threading.Thread(target=_open, daemon=True).start()


def _start_server(port):
    """Start the Flask server using waitress (production) or Flask dev."""
    is_cloud = bool(os.environ.get('PORT'))
    if is_cloud:
        # On Render/Railway etc — use waitress (production-grade WSGI)
        host = '0.0.0.0'
        public_url = os.environ.get('RENDER_EXTERNAL_URL', '')
        print("=" * 50)
        print("  Sleep Tracker — Cloud Deployment")
        if public_url:
            print(f"  Public URL: {public_url}")
        print(f"  Binding: {host}:{port}")
        print("=" * 50)
        from waitress import serve
        serve(app, host=host, port=port, threads=12)
    else:
        try:
            app.run(host='0.0.0.0', port=port, debug=False, use_reloader=False)
        except OSError as e:
            print(f"[FATAL] Cannot bind to port {port}: {e}")
            sys.exit(1)


def _background_sync_loop(interval_minutes=30):
    """Background Whoop sync — keeps data fresh even when the page is closed.

    Runs in a daemon thread. Pulls the last 2 days of Whoop sleep/recovery data
    on a fixed interval. Failures are logged but never crash the loop, and the
    loop self-terminates if the token becomes invalid (re-auth resumes it).
    """
    import time
    # Lazy imports keep app startup fast and avoid boot-time import errors.
    from whoop.sync import sync_all_whoop
    from whoop.client import WhoopClient

    # Only run if Whoop credentials are configured.
    if not WhoopClient().client_id:
        print("[auto-sync] Whoop not configured — background sync disabled.")
        return

    print(f"[auto-sync] Background sync enabled (every {interval_minutes} min).")
    while True:
        # 避免与手动触发的同步重叠（手动同步会置 _sync_state['running']=True）
        if _sync_state["running"]:
            time.sleep(30)
            continue
        try:
            stats = sync_all_whoop(days_back=2)
            # 同样只在真正同步到数据时才刷新 last_sync_at
            _stamp_sync_outcome(stats)
            s = stats.get('sleep', {})
            d = stats.get('daily', {})
            w = stats.get('workouts', {})
            print(f"[auto-sync] OK  sleep={s.get('synced')} daily={d.get('synced')} "
                  f"workouts={w.get('synced')}")
        except PermissionError:
            print("[auto-sync] Not authenticated — stopping (reconnect in the "
                  "app to resume automatic sync).")
            return
        except Exception as e:
            print(f"[auto-sync] sync error: {e}")
        time.sleep(interval_minutes * 60)


def _init_and_start(headless=False):
    """Initialize DB and start server."""
    try:
        init_db()
    except Exception as e:
        print(f"[FATAL] Database initialization failed: {e}")
        sys.exit(1)

    # Start background Whoop sync (30-min interval, runs while the server is up).
    # The frontend also polls every 5 min while open, and a daily automation
    # acts as a safety net when the server is fully stopped.
    threading.Thread(target=_background_sync_loop, args=(30,), daemon=True).start()

    # In cloud: use PORT env var (Render sets this)
    # In local: auto-detect free port
    port = int(os.environ.get('PORT', 0)) or _find_free_port()
    _write_port_file(port)

    if not headless and not os.environ.get('PORT'):
        _open_browser_after_delay(port)

    _start_server(port)


# ──────────────────────────────────────────────
#  Dashboard "Today at a glance" (aggregated top card)
# ──────────────────────────────────────────────


def _duration_hours(sleep_time, wake_time):
    """Compute sleep duration in hours from two ISO datetime strings."""
    try:
        from datetime import datetime as _dt
        st = _dt.fromisoformat(sleep_time)
        wt = _dt.fromisoformat(wake_time)
        delta = (wt - st).total_seconds() / 3600.0
        if delta < 0:
            delta += 24.0
        return round(delta, 1)
    except Exception:
        return None


@app.route('/api/dashboard/today', methods=['GET'])
def dashboard_today():
    """Aggregated snapshot for the top 'today at a glance' card."""
    from database import get_connection
    from datetime import datetime
    from whoop.client import WhoopClient

    today = datetime.now().strftime('%Y-%m-%d')
    result = {
        'last_sleep': None,
        'today_meals': {'count': 0, 'types': []},
        'cycle': period_models.get_cycle_summary(),
        'whoop': {'authenticated': False, 'last_sync_date': None},
        'generated_at': datetime.now().strftime('%Y-%m-%d %H:%M'),
    }

    conn = None
    try:
        conn = get_connection()
        cur = conn.execute(
            "SELECT record_date, record_type, sleep_time, wake_time, "
            "classification, sleep_quality, device_score "
            "FROM sleep_records ORDER BY record_date DESC, id DESC LIMIT 1"
        )
        row = cur.fetchone()
        if row:
            rec = {c: row[c] for c in row.keys()}
            result['last_sleep'] = {
                'record_date': rec.get('record_date'),
                'record_type': rec.get('record_type'),
                'hours': _duration_hours(rec.get('sleep_time'), rec.get('wake_time')),
                'quality': rec.get('sleep_quality'),
                'classification': rec.get('classification'),
                'device_score': rec.get('device_score'),
            }

        cur = conn.execute(
            "SELECT meal_type FROM meal_records WHERE meal_date = ?", (today,)
        )
        types = [r[0] for r in cur.fetchall()]
        result['today_meals'] = {'count': len(types), 'types': types}

        cur = conn.execute("SELECT MAX(record_date) FROM whoop_daily_metrics")
        mx = cur.fetchone()
        result['whoop']['last_sync_date'] = mx[0] if mx else None
    except Exception as e:
        print('[dashboard] db error:', e)
    finally:
        if conn:
            conn.close()

    try:
        result['whoop']['authenticated'] = WhoopClient().is_authenticated()
    except Exception:
        result['whoop']['authenticated'] = False

    return jsonify(result)


@app.route('/api/export', methods=['GET'])
def export_data():
    """Dump all tables as a downloadable JSON backup."""
    from database import get_connection
    from datetime import datetime
    TABLES = ['sleep_records', 'meal_records', 'period_records',
              'whoop_daily_metrics', 'whoop_workouts', 'health_metrics', 'whoop_tokens',
              'medication_records']
    conn = get_connection()
    data = {'version': 1, 'exported_at': datetime.now().isoformat(), 'tables': {}}
    try:
        for t in TABLES:
            cur = conn.execute(f"SELECT * FROM {t}")
            out = []
            for r in cur.fetchall():
                if hasattr(r, 'keys'):
                    out.append({k: r[k] for k in r.keys()})
                else:
                    out.append(dict(r))
            data['tables'][t] = out
    finally:
        conn.close()
    resp = jsonify(data)
    resp.headers['Content-Disposition'] = (
        'attachment; filename=sleep-tracker-backup.json'
    )
    return resp


@app.route('/api/import', methods=['POST'])
def import_data():
    """Restore all tables from an exported JSON backup (upsert by primary key)."""
    from database import get_connection
    payload = request.get_json(force=True, silent=True)
    if not isinstance(payload, dict) or 'tables' not in payload:
        return jsonify({'error': '无效的备份文件'}), 400

    TABLES = ['sleep_records', 'meal_records', 'period_records',
              'whoop_daily_metrics', 'whoop_workouts', 'health_metrics', 'whoop_tokens',
              'medication_records']
    summary = {}
    conn = get_connection()
    try:
        for t in TABLES:
            rows = payload['tables'].get(t)
            if not isinstance(rows, list) or not rows:
                continue
            cols = list(rows[0].keys())
            col_str = ','.join(cols)
            placeholders = ','.join(['?'] * len(cols))
            conn.executemany(
                f"INSERT OR REPLACE INTO {t} ({col_str}) VALUES ({placeholders})",
                [tuple(r.get(c) for c in cols) for r in rows]
            )
            summary[t] = len(rows)
        conn.commit()
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        try:
            conn.close()
        except Exception:
            pass
    return jsonify({'ok': True, 'summary': summary})


if __name__ == '__main__':
    headless = bool(os.environ.get('HEADLESS', ''))
    _init_and_start(headless=headless)