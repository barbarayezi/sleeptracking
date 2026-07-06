/**
 * timeline.js — Canvas-based sleep timeline (Gantt-chart style).
 * Exposes: Timeline class
 */

class Timeline {
    constructor(canvasId, emptyId) {
        this.canvas = document.getElementById(canvasId);
        this.emptyEl = document.getElementById(emptyId);
        this.ctx = this.canvas.getContext('2d');
        this.records = [];
        this.daysToShow = 14;

        // Layout constants
        this.LEFT_MARGIN = 90;
        this.RIGHT_MARGIN = 60;
        this.TOP_OFFSET = 30;
        this.ROW_HEIGHT = 36;
        this.BAR_HEIGHT = 20;
        this.BAR_Y_OFFSET = 8;

        // Color mapping
        this.colors = {
            good: '#4ade80',
            average: '#fbbf24',
            poor: '#f87171'
        };

        this._initClickHandler();
    }

    /* ── Public API ───────────────────────── */

    /** Set the number of days to display. */
    setDays(days) {
        this.daysToShow = days;
        this.render();
    }

    /** Update records and re-render. */
    setRecords(records) {
        // Sort by date desc (most recent first)
        this.records = [...records].sort((a, b) =>
            b.record_date.localeCompare(a.record_date)
        );
        this.render();
    }

    /** Render the timeline. */
    render() {
        const records = this.records.slice(0, this.daysToShow);

        if (records.length === 0) {
            this.emptyEl.classList.remove('hidden');
            this.canvas.classList.add('hidden');
            return;
        }

        this.emptyEl.classList.add('hidden');
        this.canvas.classList.remove('hidden');

        // Set canvas size
        const containerWidth = this.canvas.parentElement.clientWidth;
        const totalHeight = this.TOP_OFFSET + records.length * this.ROW_HEIGHT + 10;

        this.canvas.width = containerWidth * window.devicePixelRatio;
        this.canvas.height = totalHeight * window.devicePixelRatio;
        this.canvas.style.width = containerWidth + 'px';
        this.canvas.style.height = totalHeight + 'px';

        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

        const ctx = this.ctx;
        const chartWidth = containerWidth - this.LEFT_MARGIN - this.RIGHT_MARGIN;

        // 24-hour window: 18:00 to 18:00 (next day)
        const TOTAL_MINUTES = 1440; // 24 * 60
        const pxPerMinute = chartWidth / TOTAL_MINUTES;

        // Clear
        ctx.clearRect(0, 0, containerWidth, totalHeight);

        // Draw grid lines & hour labels
        ctx.fillStyle = '#94a3b8';
        ctx.font = '11px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.strokeStyle = '#334155';
        ctx.lineWidth = 0.5;

        const hourLabels = ['18', '19', '20', '21', '22', '23', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '17', '18'];
        for (let i = 0; i <= 24; i++) {
            const x = this.LEFT_MARGIN + i * 60 * pxPerMinute;
            // Grid line
            ctx.beginPath();
            ctx.moveTo(x, this.TOP_OFFSET - 10);
            ctx.lineTo(x, totalHeight);
            ctx.stroke();
            // Label
            ctx.fillText(hourLabels[i], x, this.TOP_OFFSET - 14);
        }

        // Draw bars
        records.forEach((record, index) => {
            const y = this.TOP_OFFSET + index * this.ROW_HEIGHT;

            // Date label
            ctx.fillStyle = '#94a3b8';
            ctx.textAlign = 'right';
            ctx.font = '12px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
            const dateDisplay = record.record_date.slice(5); // MM-DD
            ctx.fillText(dateDisplay, this.LEFT_MARGIN - 8, y + this.BAR_Y_OFFSET + 14);

            // Parse times
            const sleepTime = this._parseTime(record.sleep_time);
            const wakeTime = this._parseTime(record.wake_time);

            // Convert to minutes from 18:00
            let sleepOffset = (sleepTime.hour - 18) * 60 + sleepTime.minute;
            if (sleepOffset < 0) sleepOffset += 1440; // Before 18:00 — wrap to next day

            let wakeOffset = (wakeTime.hour - 18) * 60 + wakeTime.minute;
            if (wakeOffset < 0) wakeOffset += 1440;
            // If wake is before sleep in this 18:00-based timeline, add 24h
            if (wakeOffset <= sleepOffset) wakeOffset += 1440;

            const barX = this.LEFT_MARGIN + sleepOffset * pxPerMinute;
            const barWidth = Math.max((wakeOffset - sleepOffset) * pxPerMinute, 4);

            // Draw bar
            const color = this.colors[record.sleep_quality] || '#94a3b8';
            ctx.fillStyle = color;
            this._roundRect(ctx, barX, y + this.BAR_Y_OFFSET, barWidth, this.BAR_HEIGHT, 4);
            ctx.fill();

            // Duration text
            const durationHours = (wakeOffset - sleepOffset) / 60;
            ctx.fillStyle = '#e2e8f0';
            ctx.textAlign = 'left';
            ctx.font = '11px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
            const hoursText = durationHours.toFixed(1) + 'h';
            ctx.fillText(hoursText, barX + barWidth + 6, y + this.BAR_Y_OFFSET + 15);

            // Store hit region for click detection
            record._hitRegion = {
                x: barX,
                y: y + this.BAR_Y_OFFSET,
                w: barWidth,
                h: this.BAR_HEIGHT
            };
        });
    }

    /* ── Click Handling ───────────────────── */

    _initClickHandler() {
        this.canvas.addEventListener('click', (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            const records = this.records.slice(0, this.daysToShow);
            for (const record of records) {
                if (!record._hitRegion) continue;
                const r = record._hitRegion;
                if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
                    if (typeof App !== 'undefined' && App.onTimelineClick) {
                        App.onTimelineClick(record.record_date);
                    }
                    return;
                }
            }
        });

        // Cursor style
        this.canvas.addEventListener('mousemove', (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            const records = this.records.slice(0, this.daysToShow);
            let hovering = false;
            for (const record of records) {
                if (!record._hitRegion) continue;
                const r = record._hitRegion;
                if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
                    hovering = true;
                    break;
                }
            }
            this.canvas.style.cursor = hovering ? 'pointer' : 'default';
        });
    }

    /* ── Helpers ──────────────────────────── */

    _parseTime(dtStr) {
        // Parse "YYYY-MM-DDTHH:MM" or "YYYY-MM-DD HH:MM:SS"
        const match = dtStr.match(/[T ](\d{2}):(\d{2})/);
        if (match) {
            return { hour: parseInt(match[1]), minute: parseInt(match[2]) };
        }
        return { hour: 0, minute: 0 };
    }

    _roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.arcTo(x + w, y, x + w, y + r, r);
        ctx.lineTo(x + w, y + h - r);
        ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
        ctx.lineTo(x + r, y + h);
        ctx.arcTo(x, y + h, x, y + h - r, r);
        ctx.lineTo(x, y + r);
        ctx.arcTo(x, y, x + r, y, r);
        ctx.closePath();
    }
}