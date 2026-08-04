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
from database import init_db
from reports import generate_report, get_quick_stats
import models as models
import meal_models as meal_models
import period_models as period_models

app = Flask(__name__)
# 本地个人应用：禁用静态文件客户端缓存，改完前端刷新即可见，无需手动清缓存
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0
# 本地个人应用：模板随文件改动自动重载，改 index.html 也无需重启服务
app.config['TEMPLATES_AUTO_RELOAD'] = True


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
    """Trigger a full Whoop data sync (sleep + daily metrics + workouts)."""
    days_back = request.args.get('days', 30, type=int)
    from whoop.sync import sync_all_whoop
    try:
        stats = sync_all_whoop(days_back=days_back)
        return jsonify(stats)
    except PermissionError as e:
        return jsonify({'error': str(e), 'need_auth': True}), 401
    except Exception as e:
        return jsonify({'error': str(e)}), 500


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
        serve(app, host=host, port=port)
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
        try:
            stats = sync_all_whoop(days_back=2)
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
              'whoop_daily_metrics', 'whoop_workouts', 'health_metrics', 'whoop_tokens']
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
              'whoop_daily_metrics', 'whoop_workouts', 'health_metrics', 'whoop_tokens']
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