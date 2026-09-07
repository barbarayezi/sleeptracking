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
        this.periods = [];
        this.daily = [];
        this.steps = [];
        this._periodByDate = {};
        this._cycleInfo = null;
        this._grouped = {};
        this._mealByDate = {};
        this._dailyByDate = {};
        this._stepsByDate = {};
        this._dates = [];
        this.daysToShow = 14;

        // Layout constants
        this.LEFT_MARGIN = 90;
        this.RIGHT_MARGIN = 104;
        this.TOP_OFFSET = 30;
        this.ROW_HEIGHT = 36;
        this.BAR_HEIGHT = 20;
        this.BAR_Y_OFFSET = 8;
        this.MEAL_DOT_RADIUS = 4.5;

        // 夜间参考带：22:00 – 06:00（次日），辅助判断入睡/醒来的"理想窗口"
        this.NIGHT_BAND_START = 22;   // 22:00
        this.NIGHT_BAND_END = 6;      // 06:00（次日）

        // Color mapping（DS 语义色）
        this.colors = {
            good: '#16a34a',
            average: '#d97706',
            poor: '#dc2626'
        };

        // Meal markers: single neutral color (quality owns RAG channel);
        // meal type is encoded by SHAPE instead of color.
        this.mealColor = '#94a3b8';

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
        console.log('[timeline] records loaded:', records.length, 'dates:', this._dates);
        this.render();
    }

    /** Update meal records and re-render. */
    setMeals(meals) {
        this.meals = meals || [];
        this._groupMealsByDate();
        this.render();
    }

    /** Update period records and re-render (overlay on timeline). */
    setPeriods(periods) {
        this.periods = periods || [];
        this._groupPeriodsByDate();
        this.render();
    }

    /** Update cycle summary (ovulation prediction marker etc.). */
    setCycleInfo(summary) {
        this._cycleInfo = summary || null;
        this.render();
    }

    /** Update Whoop daily metrics (recovery/strain/HR) and re-render. */
    setDailyMetrics(daily) {
        this.daily = daily || [];
        this._dailyByDate = {};
        for (const d of this.daily) {
            const key = d.record_date || d.date;
            if (key) this._dailyByDate[key] = d;
        }
        this.render();
    }

    /** Update Apple Health step series and re-render. */
    setSteps(steps) {
        this.steps = steps || [];
        this._stepsByDate = {};
        for (const s of this.steps) {
            const key = s.date || s.metric_date;
            if (key) this._stepsByDate[key] = s.value;
        }
        this.render();
    }

    _groupPeriodsByDate() {
        this._periodByDate = {};
        for (const p of this.periods) {
            const d = p.record_date;
            if (!this._periodByDate[d]) this._periodByDate[d] = [];
            this._periodByDate[d].push(p);
        }
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

    /** Return today's date as YYYY-MM-DD in local time. */
    _todayStr() {
        const d = new Date();
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    /** Add/subtract days from a YYYY-MM-DD string. */
    _addDays(dateStr, days) {
        const d = new Date(dateStr + 'T12:00:00');
        d.setDate(d.getDate() + days);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    /** Return the weekday label (周一..周日) for a YYYY-MM-DD string. */
    _weekdayLabel(dateStr) {
        if (!dateStr) return '';
        const d = new Date(dateStr + 'T12:00:00');
        if (isNaN(d.getTime())) return '';
        const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
        return names[d.getDay()];
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
        // Always anchor the timeline to today so empty days (no data) are still shown.
        const today = this._todayStr();
        const anchorDates = [];
        for (let i = 0; i < this.daysToShow; i++) {
            anchorDates.push(this._addDays(today, -i));
        }

        // Merge any data-bearing dates that might be older than the anchored window.
        const dataDates = new Set(anchorDates);
        for (const d of this._dates) dataDates.add(d);
        for (const d of Object.keys(this._mealByDate)) dataDates.add(d);
        for (const d of Object.keys(this._dailyByDate)) dataDates.add(d);
        for (const d of Object.keys(this._stepsByDate)) dataDates.add(d);

        // Sort descending and truncate to daysToShow, but keep today at the top.
        const allDates = Array.from(dataDates).sort().reverse();
        const todayIndex = allDates.indexOf(today);
        let displayDates;
        if (todayIndex === -1) {
            displayDates = allDates.slice(0, this.daysToShow);
        } else {
            displayDates = allDates.slice(todayIndex, todayIndex + this.daysToShow);
        }

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

        // 夜间参考带（先铺底，再画网格，避免遮住网格线）
        this._drawNightBand(ctx, pxPerMinute, totalHeight);

        // Draw grid lines & hour labels
        ctx.fillStyle = '#64748b';
        ctx.font = '11px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.strokeStyle = '#e2e8f0';
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

            // Date label (MM-DD + 周几，周末用暖色高亮)
            ctx.textAlign = 'right';
            const weekday = this._weekdayLabel(date);
            const isWeekend = (weekday === '周六' || weekday === '周日');
            // 第一行：周几
            ctx.fillStyle = isWeekend ? '#d97706' : '#64748b';
            ctx.font = '11px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
            ctx.fillText(weekday, this.LEFT_MARGIN - 8, y + this.BAR_Y_OFFSET + 6);
            // 第二行：MM-DD
            ctx.fillStyle = isWeekend ? '#fcd34d' : '#cbd5e1';
            ctx.font = '12px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
            ctx.fillText(date.slice(5), this.LEFT_MARGIN - 8, y + this.BAR_Y_OFFSET + 21);

            // Period + ovulation markers (left icon column)
            const dayPeriods = this._periodByDate[date] || [];
            if (dayPeriods.length > 0) {
                this._drawPeriodMarker(ctx, dayPeriods, y);
            }
            if (this._cycleInfo && this._cycleInfo.ovulation_prediction === date) {
                this._drawOvulationMarker(ctx, y);
            }

            // Draw each record bar
            dayRecords.forEach((record) => {
                this._drawBar(ctx, record, y, pxPerMinute);
            });

            // Draw meal markers on the bottom of the row
            if (dayMeals.length > 0) {
                this._drawMealMarkers(ctx, dayMeals, y, pxPerMinute);
            }

            // Daily metrics cluster (recovery dot + strain bar + steps) on the right
            this._drawMetricCluster(ctx, date, y, containerWidth);
        });

        // Draw meal legend (top-right corner)
        this._drawMealLegend(ctx, containerWidth);
    }

    _drawNightBand(ctx, pxPerMinute, totalHeight) {
        // 22:00 → 06:00 铺浅灰底
        const startOffset = (this.NIGHT_BAND_START - 18) * 60;      // 240 min
        let endOffset = (this.NIGHT_BAND_END - 18) * 60;            // -720 → +1440 = 720
        if (endOffset <= startOffset) endOffset += 1440;
        const x = this.LEFT_MARGIN + startOffset * pxPerMinute;
        const w = (endOffset - startOffset) * pxPerMinute;
        ctx.fillStyle = 'rgba(100,116,139,0.07)';
        ctx.fillRect(x, this.TOP_OFFSET - 8, w, totalHeight - this.TOP_OFFSET + 8);

        // 0 点基准虚线（18:00 后 6 小时 = 360 分钟）
        const mx = this.LEFT_MARGIN + 360 * pxPerMinute;
        ctx.strokeStyle = 'rgba(100,116,139,0.35)';
        ctx.lineWidth = 0.5;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(mx, this.TOP_OFFSET - 8);
        ctx.lineTo(mx, totalHeight);
        ctx.stroke();
        ctx.setLineDash([]);
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

        // Duration text：优先放条右侧；条右端若逼近右边界（指标簇），改为内嵌白字防碰撞
        const durationHours = (wakeOffset - sleepOffset) / 60;
        const typeIndicator = { night: '', nap: '💤', segment: '🔄' }[record.record_type] || '';
        const hoursText = durationHours.toFixed(1) + 'h' + (typeIndicator ? ' ' + typeIndicator : '');
        ctx.font = '11px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
        // 条右侧文字需约 52px 空间；右侧指标簇从 chartWidth+LEFT_MARGIN 之后开始
        const rightEdgeLimit = this.canvas.style.width ? parseFloat(this.canvas.style.width) - this.RIGHT_MARGIN - 8 : 0;
        const textOutsideX = barX + barWidth + 6;
        const textWidth = ctx.measureText(hoursText).width;
        if (rightEdgeLimit && textOutsideX + textWidth > rightEdgeLimit) {
            // 内嵌：白字居中于条内
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            ctx.fillText(hoursText, barX + barWidth / 2, barY + 15);
        } else {
            ctx.fillStyle = '#0f172a';
            ctx.textAlign = 'left';
            ctx.fillText(hoursText, textOutsideX, barY + 15);
        }

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

        meals.forEach((meal) => {
            const time = this._parseMealTime(meal.meal_time);
            // Convert to minutes from 18:00
            let offset = (time.hour - 18) * 60 + time.minute;
            if (offset < 0) offset += 1440;

            const dotX = this.LEFT_MARGIN + offset * pxPerMinute;

            // 统一灰点（质量通道独占 RAG 色），餐类型靠形状区分：早=空心圆、午=实心圆、晚=实心三角、加=空心三角
            ctx.fillStyle = this.mealColor;
            ctx.globalAlpha = 0.9;
            const mt = meal.meal_type;
            const r = this.MEAL_DOT_RADIUS;
            if (mt === 'lunch') {
                // 实心圆
                ctx.beginPath();
                ctx.arc(dotX, dotY, r, 0, Math.PI * 2);
                ctx.fill();
            } else if (mt === 'dinner') {
                // 实心向下三角
                ctx.beginPath();
                ctx.moveTo(dotX, dotY - r);
                ctx.lineTo(dotX + r * 1.1, dotY + r * 0.9);
                ctx.lineTo(dotX - r * 1.1, dotY + r * 0.9);
                ctx.closePath();
                ctx.fill();
            } else if (mt === 'snack') {
                // 空心三角
                ctx.beginPath();
                ctx.moveTo(dotX, dotY - r);
                ctx.lineTo(dotX + r * 1.1, dotY + r * 0.9);
                ctx.lineTo(dotX - r * 1.1, dotY + r * 0.9);
                ctx.closePath();
                ctx.lineWidth = 1.2;
                ctx.strokeStyle = this.mealColor;
                ctx.stroke();
            } else {
                // breakfast / 默认：空心圆
                ctx.beginPath();
                ctx.arc(dotX, dotY, r, 0, Math.PI * 2);
                ctx.lineWidth = 1.2;
                ctx.strokeStyle = this.mealColor;
                ctx.stroke();
            }
            ctx.globalAlpha = 1.0;
        });
    }

    _drawMealLegend(ctx, containerWidth) {
        const legendX = containerWidth - this.RIGHT_MARGIN + 4;
        const legendY = this.TOP_OFFSET - 4;
        const c = this.mealColor;
        const items = [
            { label: '早', shape: 'hollow' },
            { label: '午', shape: 'solid' },
            { label: '晚', shape: 'tri' },
            { label: '加', shape: 'hollowTri' }
        ];

        ctx.font = '10px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'left';
        ctx.fillStyle = c;
        ctx.strokeStyle = c;

        items.forEach((item, i) => {
            const itemX = legendX + i * 38;
            const r = 3.5;
            if (item.shape === 'solid') {
                ctx.beginPath();
                ctx.arc(itemX, legendY, r, 0, Math.PI * 2);
                ctx.fill();
            } else if (item.shape === 'hollow') {
                ctx.beginPath();
                ctx.arc(itemX, legendY, r, 0, Math.PI * 2);
                ctx.lineWidth = 1.2;
                ctx.stroke();
            } else if (item.shape === 'tri') {
                ctx.beginPath();
                ctx.moveTo(itemX, legendY - r);
                ctx.lineTo(itemX + r * 1.1, legendY + r * 0.9);
                ctx.lineTo(itemX - r * 1.1, legendY + r * 0.9);
                ctx.closePath();
                ctx.fill();
            } else {
                ctx.beginPath();
                ctx.moveTo(itemX, legendY - r);
                ctx.lineTo(itemX + r * 1.1, legendY + r * 0.9);
                ctx.lineTo(itemX - r * 1.1, legendY + r * 0.9);
                ctx.closePath();
                ctx.lineWidth = 1.2;
                ctx.stroke();
            }
            ctx.fillStyle = '#94a3b8';
            ctx.fillText(item.label, itemX + 6, legendY + 3);
            ctx.fillStyle = c;
        });
    }

    _drawPeriodMarker(ctx, periods, rowY) {
        const hasStart = periods.some(p => p.is_period_start);
        const flowRank = { none: 0, light: 1, normal: 2, heavy: 3 };
        let maxFlow = 'none';
        for (const p of periods) {
            if ((flowRank[p.flow] || 0) > (flowRank[maxFlow] || 0)) maxFlow = p.flow;
        }
        const color = { none: '#94a3b8', light: '#fb7185', normal: '#f43f5e', heavy: '#dc2626' }[maxFlow] || '#f43f5e';
        const x = 16, yDot = rowY + 9;
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.95;
        ctx.beginPath();
        ctx.arc(x, yDot, 4.5, 0, Math.PI * 2);
        ctx.fill();
        if (hasStart) {
            ctx.strokeStyle = '#f8fafc';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(x, yDot, 6.5, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.globalAlpha = 1.0;
    }

    _drawOvulationMarker(ctx, rowY) {
        const x = 16, yDot = rowY + 22;
        ctx.fillStyle = '#2563eb';
        ctx.globalAlpha = 0.95;
        ctx.beginPath();
        ctx.arc(x, yDot, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1.0;
    }

    /* ── Daily metrics cluster (right margin) ── */

    _recoveryColor(score) {
        // 恢复分统一用靛蓝（与首页评分环/Whoop 语义色对齐），不再复用红黄绿
        return '#6366f1';
    }

    _drawMetricCluster(ctx, date, rowY, containerWidth) {
        const baseX = containerWidth - this.RIGHT_MARGIN + 10;
        const daily = this._dailyByDate[date];
        const steps = this._stepsByDate[date];
        if (!daily && steps == null) return;

        ctx.textAlign = 'left';
        ctx.font = '10px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';

        // Recovery dot (color by zone)
        if (daily && daily.recovery_score != null) {
            const rc = this._recoveryColor(daily.recovery_score);
            ctx.fillStyle = rc;
            ctx.globalAlpha = 0.95;
            ctx.beginPath();
            ctx.arc(baseX + 2, rowY + 11, 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1.0;
            ctx.fillStyle = '#cbd5e1';
            ctx.fillText(String(daily.recovery_score), baseX + 11, rowY + 14);
        }

        // Strain mini bar (0-21 scale)
        if (daily && daily.strain != null) {
            const maxW = 40;
            const w = Math.max(2, Math.min(maxW, (daily.strain / 21) * maxW));
            const barY = rowY + 20;
            ctx.fillStyle = 'rgba(129,140,248,0.25)';
            this._roundRect(ctx, baseX, barY, maxW, 6, 3);
            ctx.fill();
            ctx.fillStyle = '#2563eb';
            this._roundRect(ctx, baseX, barY, w, 6, 3);
            ctx.fill();
            ctx.fillStyle = '#94a3b8';
            ctx.fillText('S' + daily.strain.toFixed(1), baseX + maxW + 4, barY + 6);
        }

        // Steps glyph + number（去掉 emoji 鞋，用「步」前缀纯文本，视觉更干净）
        if (steps != null) {
            ctx.fillStyle = '#38bdf8';
            ctx.fillText('步 ' + this._fmtSteps(steps), baseX + 58, rowY + 14);
        }
    }

    _fmtSteps(n) {
        n = Number(n) || 0;
        if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
        return String(n);
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