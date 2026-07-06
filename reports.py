"""
Sleep report generation module.
Dual-purpose: can be imported by Flask routes or run standalone via CLI.
"""

import json
import argparse
import sys
import io
from datetime import datetime, date, timedelta
from collections import Counter
from developing.sleeptracking.database import get_connection, DB_PATH


def generate_report(period='weekly', from_date=None):
    """
    Generate a sleep analysis report for the given period.

    Args:
        period: 'weekly' or 'monthly'
        from_date: ISO date string (YYYY-MM-DD). If None, defaults to now - period.

    Returns:
        dict with all report data.
    """
    today = date.today()

    if from_date:
        from_dt = datetime.strptime(from_date, '%Y-%m-%d').date()
    else:
        if period == 'weekly':
            from_dt = today - timedelta(days=7)
        else:
            from_dt = today - timedelta(days=30)

    to_dt = today

    conn = get_connection()
    cursor = conn.execute(
        "SELECT * FROM sleep_records WHERE record_date BETWEEN ? AND ? ORDER BY record_date ASC",
        (from_dt.isoformat(), to_dt.isoformat())
    )
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()

    # Parse JSON fields
    for r in rows:
        if r.get('sleep_problems'):
            try:
                r['sleep_problems'] = json.loads(r['sleep_problems'])
            except (json.JSONDecodeError, TypeError):
                r['sleep_problems'] = []
        else:
            r['sleep_problems'] = []

    if not rows:
        return {
            'period': period,
            'date_range': {'from': from_dt.isoformat(), 'to': to_dt.isoformat()},
            'total_days_recorded': 0,
            'message': 'No sleep records found in this period.',
            'average_sleep_hours': 0,
            'earliest_sleep': None,
            'latest_sleep': None,
            'average_sleep_time': None,
            'average_wake_time': None,
            'classification_breakdown': {'early': 0, 'late': 0},
            'quality_breakdown': {'good': 0, 'average': 0, 'poor': 0},
            'problem_frequency': {},
            'daily_hours': [],
            'trend': 'insufficient_data',
            'patterns': []
        }

    # Calculate durations
    daily_hours = []
    sleep_times = []
    wake_times = []

    for r in rows:
        sleep_dt = _parse_datetime(r['sleep_time'])
        wake_dt = _parse_datetime(r['wake_time'])

        # Handle overnight sleep (wake on next day)
        if wake_dt <= sleep_dt:
            wake_dt += timedelta(days=1)

        duration = (wake_dt - sleep_dt).total_seconds() / 3600.0

        daily_hours.append({
            'date': r['record_date'],
            'hours': round(duration, 2),
            'classification': r['classification'],
            'quality': r['sleep_quality'],
            'sleep_time': r['sleep_time'],
            'wake_time': r['wake_time'],
            'problems': r['sleep_problems']
        })

        sleep_times.append(sleep_dt.time())
        wake_times.append(wake_dt.time())

    # Compute statistics
    total_days = len(rows)
    avg_hours = sum(d['hours'] for d in daily_hours) / total_days

    # Normalize times for sorting/averaging: times before 12:00 (noon) are
    # conceptually "next day", so shift them by +24h for correct ordering.
    def _normalize_minutes(t):
        """Return minutes from a fixed reference: times < 12:00 get +24h."""
        m = t.hour * 60 + t.minute
        if t.hour < 12:
            m += 1440
        return m

    def _avg_time(times):
        total_minutes = sum(_normalize_minutes(t) for t in times)
        avg_min = total_minutes // len(times)
        avg_min = avg_min % 1440  # Wrap back to 0-24h
        h, m = divmod(int(avg_min), 60)
        return f"{h:02d}:{m:02d}"

    avg_sleep_str = _avg_time(sleep_times)
    avg_wake_str = _avg_time(wake_times)

    # Earliest / latest sleep (using normalized ordering)
    sorted_sleep = sorted(sleep_times, key=_normalize_minutes)
    earliest = sorted_sleep[0].strftime('%H:%M')
    latest = sorted_sleep[-1].strftime('%H:%M')

    # Classification breakdown
    class_counts = Counter(r['classification'] for r in rows)

    # Quality breakdown
    quality_counts = Counter(r['sleep_quality'] for r in rows)

    # Problem frequency
    problem_counter = Counter()
    for r in rows:
        for p in r['sleep_problems']:
            problem_counter[p] += 1

    # Trend detection
    trend = _determine_trend(daily_hours)

    # Pattern identification
    patterns = _identify_patterns(rows, daily_hours)

    return {
        'period': period,
        'date_range': {'from': from_dt.isoformat(), 'to': to_dt.isoformat()},
        'total_days_recorded': total_days,
        'average_sleep_hours': round(avg_hours, 2),
        'earliest_sleep': earliest,
        'latest_sleep': latest,
        'average_sleep_time': avg_sleep_str,
        'average_wake_time': avg_wake_str,
        'classification_breakdown': {
            'early': class_counts.get('early', 0),
            'late': class_counts.get('late', 0)
        },
        'quality_breakdown': {
            'good': quality_counts.get('good', 0),
            'average': quality_counts.get('average', 0),
            'poor': quality_counts.get('poor', 0)
        },
        'problem_frequency': dict(problem_counter),
        'daily_hours': daily_hours,
        'trend': trend,
        'patterns': patterns
    }


def get_quick_stats(days=30):
    """Return lightweight dashboard statistics for the last N days."""
    today = date.today()
    from_dt = today - timedelta(days=days)

    conn = get_connection()
    cursor = conn.execute(
        "SELECT * FROM sleep_records WHERE record_date >= ? ORDER BY record_date DESC",
        (from_dt.isoformat(),)
    )
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()

    total_records = len(rows)
    if total_records == 0:
        return {
            'average_duration': 0,
            'streak_early_sleep': 0,
            'most_common_quality': None,
            'total_records': 0
        }

    # Average duration
    durations = []
    for r in rows:
        sleep_dt = _parse_datetime(r['sleep_time'])
        wake_dt = _parse_datetime(r['wake_time'])
        if wake_dt <= sleep_dt:
            wake_dt += timedelta(days=1)
        durations.append((wake_dt - sleep_dt).total_seconds() / 3600.0)

    avg_duration = round(sum(durations) / len(durations), 2)

    # Streak of early sleep (consecutive from most recent)
    streak = 0
    for r in rows:
        if r['classification'] == 'early':
            streak += 1
        else:
            break

    # Most common quality
    quality_counts = Counter(r['sleep_quality'] for r in rows)
    most_common = quality_counts.most_common(1)[0][0] if quality_counts else None

    return {
        'average_duration': avg_duration,
        'streak_early_sleep': streak,
        'most_common_quality': most_common,
        'total_records': total_records
    }


def _parse_datetime(dt_str):
    """Parse a datetime string, trying multiple formats."""
    formats = [
        '%Y-%m-%dT%H:%M',
        '%Y-%m-%dT%H:%M:%S',
        '%Y-%m-%d %H:%M:%S',
        '%Y-%m-%d %H:%M',
    ]
    for fmt in formats:
        try:
            return datetime.strptime(dt_str, fmt)
        except ValueError:
            continue
    raise ValueError(f"Unable to parse datetime: {dt_str}")


def _determine_trend(daily_hours):
    """
    Simple linear trend: compare first half vs second half averages.
    Returns 'improving', 'declining', 'stable', or 'insufficient_data'.
    """
    if len(daily_hours) < 4:
        return 'insufficient_data'

    mid = len(daily_hours) // 2
    first_half = daily_hours[:mid]
    second_half = daily_hours[mid:]

    first_avg = sum(d['hours'] for d in first_half) / len(first_half)
    second_avg = sum(d['hours'] for d in second_half) / len(second_half)

    diff = second_avg - first_avg
    if diff > 0.5:
        return 'improving'
    elif diff < -0.5:
        return 'declining'
    else:
        return 'stable'


def _identify_patterns(records, daily_hours):
    """
    Rule-based pattern identification.
    Returns a list of human-readable observation strings.
    """
    patterns = []
    if len(records) < 5:
        return patterns

    # Pattern 1: Weekend sleep delay
    weekday_sleep_times = []
    weekend_sleep_times = []
    for r in records:
        d = datetime.strptime(r['record_date'], '%Y-%m-%d').date()
        sleep_t = _parse_datetime(r['sleep_time']).time()
        sleep_minutes = sleep_t.hour * 60 + sleep_t.minute
        if d.weekday() >= 5:  # Saturday=5, Sunday=6
            weekend_sleep_times.append(sleep_minutes)
        else:
            weekday_sleep_times.append(sleep_minutes)

    if weekday_sleep_times and weekend_sleep_times:
        weekday_avg = sum(weekday_sleep_times) / len(weekday_sleep_times)
        weekend_avg = sum(weekend_sleep_times) / len(weekend_sleep_times)
        if weekend_avg - weekday_avg > 60:
            patterns.append('周末入睡时间比工作日平均晚1小时以上，存在"周末补觉"倾向。')

    # Pattern 2: Late sleep correlates with poor quality
    late_records = [r for r in records if r['classification'] == 'late']
    early_records = [r for r in records if r['classification'] == 'early']

    if late_records and early_records:
        late_poor = sum(1 for r in late_records if r['sleep_quality'] == 'poor')
        early_poor = sum(1 for r in early_records if r['sleep_quality'] == 'poor')
        late_poor_rate = late_poor / len(late_records)
        early_poor_rate = early_poor / len(early_records)

        if late_poor_rate > early_poor_rate + 0.3:
            patterns.append('晚睡时睡眠质量明显更差，建议尽量早睡。')

    # Pattern 3: Most frequent problem
    problem_counter = Counter()
    for r in records:
        if r.get('sleep_problems'):
            try:
                problems = json.loads(r['sleep_problems']) if isinstance(r['sleep_problems'], str) else r['sleep_problems']
                for p in problems:
                    problem_counter[p] += 1
            except (json.JSONDecodeError, TypeError):
                pass

    if problem_counter:
        top_problem, top_count = problem_counter.most_common(1)[0]
        problem_names = {
            'insomnia': '失眠',
            'dreams': '多梦',
            'sweats': '多汗',
            'waking': '频醒',
            'early_waking': '早醒'
        }
        if top_count >= 3:
            patterns.append(f'最常见的睡眠问题是"{problem_names.get(top_problem, top_problem)}"（出现{top_count}次），建议重点关注。')

    # Pattern 4: Sleep duration consistency
    hours = [d['hours'] for d in daily_hours]
    avg_h = sum(hours) / len(hours)
    variance = sum((h - avg_h) ** 2 for h in hours) / len(hours)
    std_dev = variance ** 0.5

    if std_dev > 2.0:
        patterns.append('睡眠时长波动较大（标准差>2小时），建议保持规律的作息时间。')
    elif std_dev < 0.5 and len(hours) >= 5:
        patterns.append('睡眠时长非常稳定，作息规律性很好！')

    return patterns


# ──────────────────────────────────────────────
#  CLI Interface
# ──────────────────────────────────────────────

def format_report_text(report):
    """Convert report dict to human-readable text."""
    if report['total_days_recorded'] == 0:
        return f"\n  📊 睡眠报告 ({report['period']})\n  {'─' * 40}\n  {report['message']}\n"

    lines = []
    lines.append("")
    lines.append(f"  📊 睡眠分析报告 ({report['period']})")
    lines.append(f"  {'─' * 50}")
    lines.append(f"  日期范围: {report['date_range']['from']} ~ {report['date_range']['to']}")
    lines.append(f"  记录天数: {report['total_days_recorded']} 天")
    lines.append("")
    lines.append(f"  📈 核心指标")
    lines.append(f"     平均睡眠时长: {report['average_sleep_hours']} 小时")
    lines.append(f"     平均入睡时间: {report['average_sleep_time']}")
    lines.append(f"     平均醒来时间: {report['average_wake_time']}")
    lines.append(f"     最早入睡: {report['earliest_sleep']}  最晚入睡: {report['latest_sleep']}")
    lines.append("")
    lines.append(f"  📋 分类统计")
    lines.append(f"     早睡: {report['classification_breakdown']['early']} 天  晚睡: {report['classification_breakdown']['late']} 天")
    lines.append(f"     良好: {report['quality_breakdown']['good']} 天  一般: {report['quality_breakdown']['average']} 天  较差: {report['quality_breakdown']['poor']} 天")
    lines.append("")

    if report['problem_frequency']:
        problem_names = {
            'insomnia': '失眠', 'dreams': '多梦', 'sweats': '多汗',
            'waking': '频醒', 'early_waking': '早醒'
        }
        lines.append(f"  ⚠️  睡眠问题频率")
        for k, v in sorted(report['problem_frequency'].items(), key=lambda x: -x[1]):
            lines.append(f"     {problem_names.get(k, k)}: {v} 次")
        lines.append("")

    trend_labels = {
        'improving': '📈 改善中',
        'declining': '📉 下降中',
        'stable': '➡️  稳定',
        'insufficient_data': '⏳ 数据不足'
    }
    lines.append(f"  📉 趋势: {trend_labels.get(report['trend'], report['trend'])}")
    lines.append("")

    if report['patterns']:
        lines.append(f"  💡 分析洞察")
        for p in report['patterns']:
            lines.append(f"     • {p}")
        lines.append("")

    # Daily breakdown
    lines.append(f"  📅 每日详情")
    lines.append(f"     {'日期':<12} {'时长':>6} {'分类':>6} {'质量':>6}")
    lines.append(f"     {'─' * 35}")
    for d in report['daily_hours']:
        cls_label = '早睡' if d['classification'] == 'early' else '晚睡'
        qual_label = {'good': '良好', 'average': '一般', 'poor': '较差'}.get(d['quality'], d['quality'])
        lines.append(f"     {d['date']:<12} {d['hours']:>5.1f}h {cls_label:>6} {qual_label:>6}")
    lines.append("")

    return '\n'.join(lines)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Sleep Tracker Report Generator')
    parser.add_argument('--period', choices=['weekly', 'monthly'], default='weekly',
                        help='Report period (default: weekly)')
    parser.add_argument('--from', dest='from_date', default=None,
                        help='Start date in YYYY-MM-DD format')
    parser.add_argument('--output', default=None,
                        help='Output file path (default: print to stdout)')
    parser.add_argument('--json', action='store_true',
                        help='Output raw JSON instead of formatted text')

    args = parser.parse_args()

    report = generate_report(period=args.period, from_date=args.from_date)

    if args.json:
        output = json.dumps(report, ensure_ascii=False, indent=2)
    else:
        output = format_report_text(report)

    if args.output:
        with open(args.output, 'w', encoding='utf-8') as f:
            f.write(output)
        print(f"Report written to: {args.output}")
    else:
        # Handle Windows console encoding for emoji
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
        print(output)