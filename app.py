"""
Sleep Tracker — Flask application entry point.
All REST API routes for CRUD operations, statistics, and reports.
"""

import os
import urllib.parse
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

from flask import Flask, request, jsonify, render_template, redirect
from database import init_db
from reports import generate_report, get_quick_stats
import models as models
import meal_models as meal_models

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
    from whoop.client import WhoopClient
    client = WhoopClient()
    authenticated = client.is_authenticated()
    result = {'authenticated': authenticated}
    if authenticated:
        # Show masked client ID for reference
        result['client_id'] = client.client_id[:8] + '...'
    return jsonify(result)


@app.route('/api/whoop/sync', methods=['POST'])
def whoop_sync():
    """Trigger a Whoop data sync."""
    days_back = request.args.get('days', 30, type=int)
    from whoop.sync import sync_sleep_data
    try:
        stats = sync_sleep_data(days_back=days_back)
        return jsonify(stats)
    except PermissionError as e:
        return jsonify({'error': str(e), 'need_auth': True}), 401
    except Exception as e:
        return jsonify({'error': str(e)}), 500


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
        serve(app, host=host, port=port)
    else:
        try:
            app.run(host='0.0.0.0', port=port, debug=False, use_reloader=False)
        except OSError as e:
            print(f"[FATAL] Cannot bind to port {port}: {e}")
            sys.exit(1)


def _init_and_start(headless=False):
    """Initialize DB and start server."""
    try:
        init_db()
    except Exception as e:
        print(f"[FATAL] Database initialization failed: {e}")
        sys.exit(1)

    # In cloud: use PORT env var (Render sets this)
    # In local: auto-detect free port
    port = int(os.environ.get('PORT', 0)) or _find_free_port()
    _write_port_file(port)

    if not headless and not os.environ.get('PORT'):
        _open_browser_after_delay(port)

    _start_server(port)


if __name__ == '__main__':
    headless = bool(os.environ.get('HEADLESS', ''))
    _init_and_start(headless=headless)