"""
Sleep Tracker — Flask application entry point.
All REST API routes for CRUD operations, statistics, and reports.
"""

import os
import sys
# Ensure the project root is in the Python path
_project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _project_root)

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

from flask import Flask, request, jsonify, render_template
from sleep_traking.database import init_db
from sleep_traking.reports import generate_report, get_quick_stats
import sleep_traking.models as models
import sleep_traking.meal_models as meal_models

app = Flask(__name__)


# ──────────────────────────────────────────────
#  Page route
# ──────────────────────────────────────────────

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


def run_app():
    """Initialize DB and start Flask on a conflict-free port."""
    try:
        init_db()
    except Exception as e:
        print(f"[FATAL] Database initialization failed: {e}")
        sys.exit(1)

    # Priority: 1) PORT env var  2) OS-assigned free port (zero-conflict)
    port = _read_port_file() or _find_free_port()
    _write_port_file(port)

    print("=" * 50)
    print("  Sleep Tracker — Production Mode")
    print(f"  Open http://localhost:{port} in your browser")
    print(f"  Active port saved to .active_port")
    print("=" * 50)

    # Auto-open browser after a short delay (Firefox / default browser)
    _open_browser_after_delay(port)

    try:
        app.run(host='0.0.0.0', port=port, debug=False, use_reloader=False)
    except OSError as e:
        print(f"[FATAL] Cannot bind to port {port}: {e}")
        sys.exit(1)


def run_app_headless():
    """Same as run_app but without auto-opening the browser.
    Used by the scheduled task / run.ps1 background launcher.
    Set environment variable HEADLESS=1 to suppress the browser."""
    try:
        init_db()
    except Exception as e:
        print(f"[FATAL] Database initialization failed: {e}")
        sys.exit(1)

    port = _read_port_file() or _find_free_port()
    _write_port_file(port)

    print("=" * 50)
    print("  Sleep Tracker — Headless Mode (scheduled task)")
    print(f"  Open http://localhost:{port} in your browser")
    print(f"  Active port saved to .active_port")
    print("=" * 50)

    try:
        app.run(host='0.0.0.0', port=port, debug=False, use_reloader=False)
    except OSError as e:
        print(f"[FATAL] Cannot bind to port {port}: {e}")
        sys.exit(1)


if __name__ == '__main__':
    # HEADLESS=1 → silent (scheduled task / run.ps1), no browser popup
    if os.environ.get('HEADLESS', ''):
        run_app_headless()
    else:
        run_app()