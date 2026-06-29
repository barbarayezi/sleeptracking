"""
Sleep Tracker — Flask application entry point.
All REST API routes for CRUD operations, statistics, and reports.
"""

from flask import Flask, request, jsonify, render_template
from database import init_db
from reports import generate_report, get_quick_stats
import models

app = Flask(__name__)


# ──────────────────────────────────────────────
#  Page route
# ──────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')


# ──────────────────────────────────────────────
#  CRUD: /api/records
# ──────────────────────────────────────────────

@app.route('/api/records', methods=['GET'])
def list_records():
    """List all records, optionally filtered by date range."""
    from_date = request.args.get('from')
    to_date = request.args.get('to')
    records = models.get_all_records(from_date=from_date, to_date=to_date)
    return jsonify(records)


@app.route('/api/records/<record_date>', methods=['GET'])
def get_record(record_date):
    """Get a single record by date."""
    record = models.get_record_by_date(record_date)
    if record is None:
        return jsonify({'error': 'Record not found'}), 404
    return jsonify(record)


@app.route('/api/records', methods=['POST'])
def create_record():
    """Create a new sleep record."""
    data = request.get_json()
    if not data:
        return jsonify({'error': 'Request body must be JSON'}), 400

    # Validate required fields
    required = ['record_date', 'sleep_time', 'wake_time', 'classification', 'sleep_quality']
    for field in required:
        if field not in data:
            return jsonify({'error': f'Missing required field: {field}'}), 400

    # Validate classification
    if data['classification'] not in ('early', 'late'):
        return jsonify({'error': 'classification must be "early" or "late"'}), 400

    # Validate sleep quality
    if data['sleep_quality'] not in ('good', 'average', 'poor'):
        return jsonify({'error': 'sleep_quality must be "good", "average", or "poor"'}), 400

    # Auto-clear sleep problems if quality is good
    if data['sleep_quality'] == 'good':
        data['sleep_problems'] = []

    # Validate sleep problems when quality is not good
    if data['sleep_quality'] in ('average', 'poor'):
        problems = data.get('sleep_problems', [])
        if not problems:
            return jsonify({'error': 'sleep_problems is required when quality is average or poor'}), 400
        valid_problems = {'insomnia', 'dreams', 'sweats', 'waking', 'early_waking'}
        for p in problems:
            if p not in valid_problems:
                return jsonify({'error': f'Invalid sleep problem: {p}'}), 400

    # Check if record for this date already exists
    existing = models.get_record_by_date(data['record_date'])
    if existing:
        return jsonify({
            'error': 'Record already exists for this date. Use PUT to update.',
            'existing': existing
        }), 409

    record = models.create_record(data)
    return jsonify(record), 201


@app.route('/api/records/<record_date>', methods=['PUT'])
def update_record(record_date):
    """Update an existing sleep record."""
    data = request.get_json()
    if not data:
        return jsonify({'error': 'Request body must be JSON'}), 400

    # Validate classification if present
    if 'classification' in data and data['classification'] not in ('early', 'late'):
        return jsonify({'error': 'classification must be "early" or "late"'}), 400

    # Validate sleep quality if present
    if 'sleep_quality' in data and data['sleep_quality'] not in ('good', 'average', 'poor'):
        return jsonify({'error': 'sleep_quality must be "good", "average", or "poor"'}), 400

    # Auto-clear sleep problems if quality is good
    if data.get('sleep_quality') == 'good':
        data['sleep_problems'] = []

    # Validate sleep problems when quality is not good
    if data.get('sleep_quality') in ('average', 'poor'):
        problems = data.get('sleep_problems', [])
        if not problems:
            return jsonify({'error': 'sleep_problems is required when quality is average or poor'}), 400

    record = models.update_record(record_date, data)
    if record is None:
        return jsonify({'error': 'Record not found'}), 404
    return jsonify(record)


@app.route('/api/records/<record_date>', methods=['DELETE'])
def delete_record(record_date):
    """Delete a sleep record by date."""
    deleted = models.delete_record(record_date)
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
#  Startup
# ──────────────────────────────────────────────

if __name__ == '__main__':
    init_db()
    print("=" * 50)
    print("  Sleep Tracker")
    print("  Open http://localhost:5000 in your browser")
    print("=" * 50)
    app.run(debug=True, host='0.0.0.0', port=5000)