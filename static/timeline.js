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
        this.meals = [];
        this._grouped = {};
        this._mealByDate = {};
        this._dates = [];
        this.daysToShow = 14;

        // Layout constants
        this.LEFT_MARGIN = 90;
        this.RIGHT_MARGIN = 60;
        this.TOP_OFFSET = 30;
        this.ROW_HEIGHT = 36;
        this.BAR_HEIGHT = 20;
        this.BAR_Y_OFFSET = 8;
        this.MEAL_DOT_RADIUS = 4.5;

        // Color mapping
        this.colors = {
            good: '#4ade80',
            average: '#fbbf24',
            poor: '#f87171'
        };

        // Meal type colors
        this.mealColors = {
            breakfast: '#fbbf24',  // warm yellow
            lunch: '#4ade80',      // green
            dinner: '#818cf8',     // indigo
            snack: '#f472b6'       // pink
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

    /** Update meal records and re-render. */
    setMeals(meals) {
        this.meals = meals || [];
        this._groupMealsByDate();
        this.render();
    }

    /* ── Grouping ─────────────────────────── */

    _groupByDate() {
        this._grouped = {};
        for (const r of this.records) {
            // 按醒来日期归组：睡眠属于"醒来那天"
            // 例：7月8日 23:00 → 7月9日 07:00 的睡眠归到 7月9日
            const displayDate = this._extractDate(r.wake_time) || r.record_date;
            if (!this._grouped[displayDate]) {
                this._grouped[displayDate] = [];
            }
            this._grouped[displayDate].push(r);
        }
        // Sort dates descending
        this._dates = Object.keys(this._grouped).sort().reverse();
    }

    /** Extract YYYY-MM-DD from an ISO datetime string. */
    _extractDate(dtStr) {
        if (!dtStr) return null;
        const match = dtStr.match(/^(\d{4}-\d{2}-\d{2})/);
        return match ? match[1] : null;
    }

    /** Group meals by their meal_date for timeline display. */
    _groupMealsByDate() {
        this._mealByDate = {};
        for (const m of this.meals) {
            const d = m.meal_date;
            if (!this._mealByDate[d]) {
                this._mealByDate[d] = [];
            }
            this._mealByDate[d].push(m);
        }
    }

    /* ── Render ───────────────────────────── */

    render() {
        const dates = this._dates.slice(0, this.daysToShow);

        // Also include dates that only have meals (no sleep records)
        const mealDates = Object.keys(this._mealByDate);
        for (const md of mealDates) {
            if (!dates.includes(md)) {
                dates.push(md);
            }
        }
        dates.sort().reverse();

        // Truncate to daysToShow after merging
        const displayDates = dates.slice(0, this.daysToShow);

        if (displayDates.length === 0) {
            this.emptyEl.classList.remove('hidden');
            this.canvas.classList.add('hidden');
            return;
        }

        this.emptyEl.classList.add('hidden');
        this.canvas.classList.remove('hidden');

        // Set canvas size
        const containerWidth = this.canvas.parentElement.clientWidth;
        const totalHeight = this.TOP_OFFSET + displayDates.length * this.ROW_HEIGHT + 10;

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

        // Draw bars and meal markers
        displayDates.forEach((date, index) => {
            const y = this.TOP_OFFSET + index * this.ROW_HEIGHT;
            const dayRecords = this._grouped[date] || [];
            const dayMeals = this._mealByDate[date] || [];

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

            // Draw meal markers on the bottom of the row
            if (dayMeals.length > 0) {
                this._drawMealMarkers(ctx, dayMeals, y, pxPerMinute);
            }
        });

        // Draw meal legend (top-right corner)
        this._drawMealLegend(ctx, containerWidth);
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

    /* ── Meal Markers ─────────────────────── */

    _drawMealMarkers(ctx, meals, rowY, pxPerMinute) {
        const dotY = rowY + this.ROW_HEIGHT - 4;  // Bottom of row
        const mealIcons = {
            breakfast: '\u{1F305}',
            lunch: '\u{2600}\u{FE0F}',
            dinner: '\u{1F307}',
            snack: '\u{1F36A}'
        };

        meals.forEach((meal) => {
            const time = this._parseMealTime(meal.meal_time);
            // Convert to minutes from 18:00
            let offset = (time.hour - 18) * 60 + time.minute;
            if (offset < 0) offset += 1440;

            const dotX = this.LEFT_MARGIN + offset * pxPerMinute;
            const color = this.mealColors[meal.meal_type] || '#94a3b8';

            // Draw colored dot
            ctx.fillStyle = color;
            ctx.globalAlpha = 0.9;
            ctx.beginPath();
            ctx.arc(dotX, dotY, this.MEAL_DOT_RADIUS, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1.0;

            // Draw tiny icon next to dot (only if there's room)
            const icon = mealIcons[meal.meal_type] || '';
            if (icon && meals.length <= 4) {
                ctx.font = '9px sans-serif';
                ctx.textAlign = 'left';
                ctx.fillText(icon, dotX + 6, dotY + 4);
            }
        });
    }

    _drawMealLegend(ctx, containerWidth) {
        const legendX = containerWidth - this.RIGHT_MARGIN + 4;
        const legendY = this.TOP_OFFSET - 4;
        const items = [
            { label: '早', color: this.mealColors.breakfast },
            { label: '午', color: this.mealColors.lunch },
            { label: '晚', color: this.mealColors.dinner },
            { label: '加', color: this.mealColors.snack }
        ];

        ctx.font = '10px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'left';

        items.forEach((item, i) => {
            const itemX = legendX + i * 38;
            // Dot
            ctx.fillStyle = item.color;
            ctx.beginPath();
            ctx.arc(itemX, legendY, 3.5, 0, Math.PI * 2);
            ctx.fill();
            // Label
            ctx.fillStyle = '#94a3b8';
            ctx.fillText(item.label, itemX + 6, legendY + 3);
        });
    }

    _parseMealTime(timeStr) {
        if (!timeStr) return { hour: 12, minute: 0 };
        const parts = timeStr.split(':');
        return {
            hour: parseInt(parts[0]) || 12,
            minute: parseInt(parts[1]) || 0
        };
    }

    /* ── Click Handling ───────────────────── */

    _initClickHandler() {
        this.canvas.addEventListener('click', (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            // Build same display list as render()
            const mealDates = Object.keys(this._mealByDate);
            const allDates = [...new Set([...this._dates, ...mealDates])].sort().reverse();
            const displayDates = allDates.slice(0, this.daysToShow);

            for (const date of displayDates) {
                const dayRecords = this._grouped[date] || [];
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

            const mealDates = Object.keys(this._mealByDate);
            const allDates = [...new Set([...this._dates, ...mealDates])].sort().reverse();
            const displayDates = allDates.slice(0, this.daysToShow);

            let hovering = false;
            for (const date of displayDates) {
                for (const record of (this._grouped[date] || [])) {
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