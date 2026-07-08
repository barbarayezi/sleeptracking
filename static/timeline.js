/**
 * timeline.js — Canvas-based sleep timeline (Gantt-chart style).
 * Supports multiple records per date (night, nap, segment).
 * Exposes: Timeline class
 */

class Timeline {
    constructor(canvasId, emptyId) {
        this.canvas = document.getElementById(canvasId);
        this.emptyEl = document.getElementById(emptyId);
        this.ctx = this.canvas.getContext('2d');
        this.records = [];
        this._grouped = {};
        this._dates = [];
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

        // Type-specific alpha
        this.typeAlpha = {
            night: 1.0,
            segment: 0.7,
            nap: 0.7
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
        this.records = records;
        this._groupByDate();
        this.render();
    }

    /* ── Grouping ─────────────────────────── */

    _groupByDate() {
        this._grouped = {};
        for (const r of this.records) {
            if (!this._grouped[r.record_date]) {
                this._grouped[r.record_date] = [];
            }
            this._grouped[r.record_date].push(r);
        }
        // Sort dates descending
        this._dates = Object.keys(this._grouped).sort().reverse();
    }

    /* ── Render ───────────────────────────── */

    render() {
        const dates = this._dates.slice(0, this.daysToShow);

        if (dates.length === 0) {
            this.emptyEl.classList.remove('hidden');
            this.canvas.classList.add('hidden');
            return;
        }

        this.emptyEl.classList.add('hidden');
        this.canvas.classList.remove('hidden');

        // Set canvas size
        const containerWidth = this.canvas.parentElement.clientWidth;
        const totalHeight = this.TOP_OFFSET + dates.length * this.ROW_HEIGHT + 10;

        this.canvas.width = containerWidth * window.devicePixelRatio;
        this.canvas.height = totalHeight * window.devicePixelRatio;
        this.canvas.style.width = containerWidth + 'px';
        this.canvas.style.height = totalHeight + 'px';

        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

        const ctx = this.ctx;
        const chartWidth = containerWidth - this.LEFT_MARGIN - this.RIGHT_MARGIN;

        // 24-hour window: 18:00 to 18:00 (next day)
        const TOTAL_MINUTES = 1440;
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
            ctx.beginPath();
            ctx.moveTo(x, this.TOP_OFFSET - 10);
            ctx.lineTo(x, totalHeight);
            ctx.stroke();
            ctx.fillText(hourLabels[i], x, this.TOP_OFFSET - 14);
        }

        // Draw bars
        dates.forEach((date, index) => {
            const y = this.TOP_OFFSET + index * this.ROW_HEIGHT;
            const dayRecords = this._grouped[date];

            // Sort: night first, then segment, then nap
            const typeOrder = { night: 1, segment: 2, nap: 3 };
            dayRecords.sort((a, b) => (typeOrder[a.record_type] || 9) - (typeOrder[b.record_type] || 9));

            // Date label
            ctx.fillStyle = '#94a3b8';
            ctx.textAlign = 'right';
            ctx.font = '12px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
            const dateDisplay = date.slice(5); // MM-DD
            ctx.fillText(dateDisplay, this.LEFT_MARGIN - 8, y + this.BAR_Y_OFFSET + 14);

            // Draw each record bar
            dayRecords.forEach((record) => {
                this._drawBar(ctx, record, y, pxPerMinute);
            });
        });
    }

    _drawBar(ctx, record, rowY, pxPerMinute) {
        const sleepTime = this._parseTime(record.sleep_time);
        const wakeTime = this._parseTime(record.wake_time);

        // Convert to minutes from 18:00
        let sleepOffset = (sleepTime.hour - 18) * 60 + sleepTime.minute;
        if (sleepOffset < 0) sleepOffset += 1440;

        let wakeOffset = (wakeTime.hour - 18) * 60 + wakeTime.minute;
        if (wakeOffset < 0) wakeOffset += 1440;
        if (wakeOffset <= sleepOffset) wakeOffset += 1440;

        const barX = this.LEFT_MARGIN + sleepOffset * pxPerMinute;
        const barWidth = Math.max((wakeOffset - sleepOffset) * pxPerMinute, 4);
        const barY = rowY + this.BAR_Y_OFFSET;

        // Color by quality, alpha by type
        const color = this.colors[record.sleep_quality] || '#94a3b8';
        const alpha = this.typeAlpha[record.record_type] || 1.0;

        // Draw bar
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        this._roundRect(ctx, barX, barY, barWidth, this.BAR_HEIGHT, 4);
        ctx.fill();

        // For nap type, draw a dotted border to distinguish from night
        if (record.record_type === 'nap') {
            ctx.globalAlpha = 1.0;
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([2, 4]);
            this._roundRect(ctx, barX, barY, barWidth, this.BAR_HEIGHT, 4);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // For segment type, draw a dashed border
        if (record.record_type === 'segment') {
            ctx.globalAlpha = 1.0;
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([3, 3]);
            this._roundRect(ctx, barX, barY, barWidth, this.BAR_HEIGHT, 4);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        ctx.globalAlpha = 1.0;

        // Duration text
        const durationHours = (wakeOffset - sleepOffset) / 60;
        const typeIndicator = { night: '', nap: '💤', segment: '🔄' }[record.record_type] || '';
        ctx.fillStyle = '#e2e8f0';
        ctx.textAlign = 'left';
        ctx.font = '11px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
        const hoursText = durationHours.toFixed(1) + 'h' + (typeIndicator ? ' ' + typeIndicator : '');
        ctx.fillText(hoursText, barX + barWidth + 6, barY + 15);

        // Store hit region for click detection
        record._hitRegion = {
            x: barX,
            y: barY,
            w: barWidth,
            h: this.BAR_HEIGHT
        };
    }

    /* ── Click Handling ───────────────────── */

    _initClickHandler() {
        this.canvas.addEventListener('click', (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            for (const date of this._dates.slice(0, this.daysToShow)) {
                const dayRecords = this._grouped[date];
                for (const record of dayRecords) {
                    if (!record._hitRegion) continue;
                    const r = record._hitRegion;
                    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
                        if (typeof App !== 'undefined' && App.onTimelineClick) {
                            App.onTimelineClick(record.record_date);
                        }
                        return;
                    }
                }
            }
        });

        this.canvas.addEventListener('mousemove', (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            let hovering = false;
            for (const date of this._dates.slice(0, this.daysToShow)) {
                for (const record of this._grouped[date]) {
                    if (!record._hitRegion) continue;
                    const r = record._hitRegion;
                    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
                        hovering = true;
                        break;
                    }
                }
                if (hovering) break;
            }
            this.canvas.style.cursor = hovering ? 'pointer' : 'default';
        });
    }

    /* ── Helpers ──────────────────────────── */

    _parseTime(dtStr) {
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