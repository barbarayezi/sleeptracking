/**
 * calendar.js — Month / Year calendar board.
 * Renders sleep quality, period shading, ovulation & next-period prediction
 * markers on calendar cells. Mirrors the Timeline overlay but in calendar form
 * so the user can read their data across weeks and months at a glance.
 *
 * Exposes: Calendar class
 *   new Calendar()                       // auto-binds DOM, loads today's month
 *   .setView('month' | 'year')          // switch board mode
 *   .prev() / .next() / .goToday()      // navigate
 *   .showDate('YYYY-MM-DD')             // jump to a date's month & select it
 *   .refresh()                          // re-fetch data & redraw
 */

const QUALITY_COLORS = { good: '#16a34a', average: '#d97706', poor: '#dc2626' };
const QUALITY_RANK = { good: 1, average: 2, poor: 3 };

/** Pick a tier key for a numeric device sleep score (0-100). */
function scoreTier(score) {
    if (score == null) return null;
    if (score >= 80) return 'great';
    if (score >= 65) return 'good';
    if (score >= 50) return 'average';
    return 'poor';
}

/** Whoop-style recovery tier (≥67 = primed, 34-66 = fair, <34 = poor). */
function recoveryTier(score) {
    if (score == null) return null;
    if (score >= 67) return 'primed';
    if (score >= 34) return 'fair';
    return 'poor';
}

class Calendar {
    constructor() {
        this.container = document.getElementById('calendar-board');
        if (!this.container) return;

        this.viewMode = 'month';                 // 'month' | 'year'
        this.current = new Date();               // anchored to the 1st of a month
        this.current.setDate(1);

        this.data = { records: [], periods: [], meals: [], summary: null };
        this._sleepByDate = new Map();           // date -> quality
        this._scoreByDate = new Map();           // date -> { sum, count } for device_score
        this._recoveryByDate = new Map();        // date -> { sum, count } for Whoop recovery
        this._mealDates = new Set();             // dates with meals
        this._periodDays = new Map();            // date -> { flow, isStart }
        this._loadedKey = null;                  // range key currently fetched

        this._initControls();
        this._bindEvents();
        this.refresh();
    }

    /* ── Public API ───────────────────────── */

    async refresh() {
        const { from, to } = this._range();
        const key = from + '|' + to + '|' + this.viewMode;
        if (this._loadedKey === key && this.data.summary) {
            this._render();
            return;
        }
        try {
            const [rResp, pResp, mResp, sResp] = await Promise.all([
                fetch(`/api/records?from=${from}&to=${to}`),
                fetch(`/api/periods?from=${from}&to=${to}`),
                fetch(`/api/meals?from=${from}&to=${to}`),
                fetch('/api/periods/summary')
            ]);
            this.data.records = rResp.ok ? await rResp.json() : [];
            this.data.periods = pResp.ok ? await pResp.json() : [];
            this.data.meals = mResp.ok ? await mResp.json() : [];
            this.data.summary = sResp.ok ? await sResp.json() : null;
            this._loadedKey = key;
            this._indexData();
        } catch (err) {
            console.error('Calendar refresh failed:', err);
        }
        this._render();
    }

    setView(mode) {
        if (mode !== 'month' && mode !== 'year') return;
        this.viewMode = mode;
        this._updateToggle();
        this._render();
        this.refresh();
    }

    prev() {
        if (this.viewMode === 'year') {
            this.current = new Date(this.current.getFullYear() - 1, 0, 1);
        } else {
            this.current = new Date(this.current.getFullYear(), this.current.getMonth() - 1, 1);
        }
        this._loadedKey = null;
        this.refresh();
    }

    next() {
        if (this.viewMode === 'year') {
            this.current = new Date(this.current.getFullYear() + 1, 0, 1);
        } else {
            this.current = new Date(this.current.getFullYear(), this.current.getMonth() + 1, 1);
        }
        this._loadedKey = null;
        this.refresh();
    }

    goToday() {
        this.current = new Date();
        this.current.setDate(1);
        this._loadedKey = null;
        this.refresh();
    }

    /** Jump to the month containing dateStr and select it. */
    showDate(dateStr) {
        if (!dateStr) return;
        const d = new Date(dateStr + 'T12:00:00');
        const newMonth = new Date(d.getFullYear(), d.getMonth(), 1);
        const sameMonth = (
            newMonth.getFullYear() === this.current.getFullYear() &&
            newMonth.getMonth() === this.current.getMonth()
        );
        this.current = newMonth;
        if (sameMonth && this._loadedKey) {
            this._render();           // already have data, just redraw highlight
        } else {
            this._loadedKey = null;
            this.refresh();
        }
    }

    /* ── Data indexing ─────────────────────── */

    _indexData() {
        // Sleep quality per day (worst of the day's records).
        this._sleepByDate = new Map();
        for (const r of (this.data.records || [])) {
            const d = r.record_date;
            const q = r.sleep_quality;
            if (!q) continue;
            const prev = this._sleepByDate.get(d);
            if (!prev || QUALITY_RANK[q] > QUALITY_RANK[prev]) {
                this._sleepByDate.set(d, q);
            }
        }

        // Device sleep score per day (averaged across records on the same day).
        this._scoreByDate = new Map();
        for (const r of (this.data.records || [])) {
            const d = r.record_date;
            const s = r.device_score;
            if (s == null || s === '') continue;
            const num = Number(s);
            if (!Number.isFinite(num)) continue;
            const entry = this._scoreByDate.get(d) || { sum: 0, count: 0 };
            entry.sum += num;
            entry.count += 1;
            this._scoreByDate.set(d, entry);
        }

        // Whoop recovery score per day (averaged if multiple records carry one).
        this._recoveryByDate = new Map();
        for (const r of (this.data.records || [])) {
            const d = r.record_date;
            const s = r.recovery_score;
            if (s == null || s === '') continue;
            const num = Number(s);
            if (!Number.isFinite(num)) continue;
            const entry = this._recoveryByDate.get(d) || { sum: 0, count: 0 };
            entry.sum += num;
            entry.count += 1;
            this._recoveryByDate.set(d, entry);
        }

        // Meal dates.
        this._mealDates = new Set((this.data.meals || []).map(m => m.meal_date || m.record_date));

        // Period days (explicit flow days + spans between start markers).
        this._periodDays = this._computePeriodDays();
    }

    _computePeriodDays() {
        const periods = this.data.periods || [];
        const summary = this.data.summary;
        const map = new Map();   // date -> { flow, isStart }

        // 1) Explicit records with bleeding flow.
        for (const p of periods) {
            if (p.flow && p.flow !== 'none') {
                map.set(p.record_date, { flow: p.flow, isStart: !!p.is_period_start });
            } else if (p.is_period_start && !map.has(p.record_date)) {
                map.set(p.record_date, { flow: 'none', isStart: true });
            }
        }

        // 2) Fill spans between consecutive period-start markers.
        const starts = periods.filter(p => p.is_period_start)
            .map(p => p.record_date).sort();
        const periodLen = (summary && summary.period_length) || 5;
        for (let i = 0; i < starts.length; i++) {
            const s = starts[i];
            let end;
            if (i + 1 < starts.length) {
                const next = starts[i + 1];
                end = this._addDays(s, periodLen - 1);
                if (end > next) end = this._addDays(next, -1);   // don't overlap next period
            } else {
                end = this._addDays(s, periodLen - 1);
            }
            let d = s;
            while (d <= end) {
                if (!map.has(d)) map.set(d, { flow: 'none', isStart: d === s });
                else if (d === s) map.get(d).isStart = true;
                d = this._addDays(d, 1);
            }
        }
        return map;
    }

    /* ── Rendering ─────────────────────────── */

    _render() {
        if (!this.container) return;

        const titleEl = document.getElementById('calendar-title');
        if (titleEl) {
            titleEl.textContent = this.viewMode === 'year'
                ? `${this.current.getFullYear()} 年`
                : `${this.current.getFullYear()} 年 ${this.current.getMonth() + 1} 月`;
        }

        const boardEl = document.getElementById('calendar-grid');
        if (!boardEl) return;
        boardEl.innerHTML = this.viewMode === 'year' ? this._renderYear() : this._renderMonth();
        this._wireCellClicks(boardEl);

        this._renderLegend();
    }

    _renderMonth() {
        const year = this.current.getFullYear();
        const month = this.current.getMonth();
        const first = new Date(year, month, 1);
        const leading = first.getDay();                       // 0=Sun .. 6=Sat
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const total = Math.max(42, Math.ceil((leading + daysInMonth) / 7) * 7);

        const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
        let html = '<div class="calendar-weekdays">';
        for (const w of weekdays) {
            html += `<div class="calendar-weekday${w === '六' || w === '日' ? ' calendar-weekday--weekend' : ''}">${w}</div>`;
        }
        html += '</div><div class="calendar-cells">';

        const todayStr = this._todayStr();
        const selectedStr = (typeof App !== 'undefined' && App.currentDate) ? App.currentDate : todayStr;

        for (let i = 0; i < total; i++) {
            const dayNum = i - leading + 1;
            if (dayNum < 1 || dayNum > daysInMonth) {
                html += '<div class="calendar-cell calendar-cell--empty"></div>';
                continue;
            }
            const dateStr = this._fmt(year, month, dayNum);
            html += this._cellHtml(dateStr, dayNum, dateStr === todayStr, dateStr === selectedStr, false);
        }
        html += '</div>';
        return html;
    }

    _renderYear() {
        let html = '<div class="calendar-year">';
        const year = this.current.getFullYear();
        for (let m = 0; m < 12; m++) {
            const first = new Date(year, m, 1);
            const leading = first.getDay();
            const daysInMonth = new Date(year, m + 1, 0).getDate();
            const total = Math.ceil((leading + daysInMonth) / 7) * 7;

            html += `<div class="mini-month" data-month="${m}">`;
            html += `<div class="mini-month-title">${m + 1}月</div>`;
            html += '<div class="mini-grid">';
            for (let i = 0; i < total; i++) {
                const dayNum = i - leading + 1;
                if (dayNum < 1 || dayNum > daysInMonth) {
                    html += '<div class="mini-cell mini-cell--empty"></div>';
                    continue;
                }
                const dateStr = this._fmt(year, m, dayNum);
                html += this._miniCellHtml(dateStr);
            }
            html += '</div></div>';
        }
        html += '</div>';
        return html;
    }

    _cellHtml(dateStr, dayNum, isToday, isSelected, isMini) {
        const sleep = this._sleepByDate.get(dateStr);
        const scoreEntry = this._scoreByDate.get(dateStr);
        const scoreAvg = scoreEntry
            ? Math.round(scoreEntry.sum / scoreEntry.count)
            : null;
        const score = scoreAvg != null ? scoreAvg : null;
        const recoveryEntry = this._recoveryByDate.get(dateStr);
        const recoveryAvg = recoveryEntry
            ? Math.round(recoveryEntry.sum / recoveryEntry.count)
            : null;
        const recovery = recoveryAvg != null ? recoveryAvg : null;
        const hasMeal = this._mealDates.has(dateStr);
        const pd = this._periodDays.get(dateStr);
        const summary = this.data.summary;
        const isOvulation = summary && summary.ovulation_prediction === dateStr;
        const isNext = summary && summary.next_period_prediction === dateStr;

        const classes = ['calendar-cell'];
        if (pd) classes.push('calendar-cell--period');
        if (pd && pd.isStart) classes.push('calendar-cell--period-start');
        if (isToday) classes.push('calendar-cell--today');
        if (isSelected) classes.push('calendar-cell--selected');
        if (isOvulation) classes.push('calendar-cell--ovulation');
        if (isNext && !pd) classes.push('calendar-cell--next-period');

        // Numeric score badges take priority over the legacy quality dot.
        // device_score (device sleep score) and recovery_score (Whoop recovery)
        // each get their own colour-tier badge.
        let markers = '';
        if (score != null) {
            const tier = scoreTier(score);
            markers += `<span class="sleep-score sleep-score--${tier}" title="设备睡眠评分：${score}（${this._scoreLabel(tier)}）">${score}</span>`;
        } else if (sleep) {
            markers += `<span class="sleep-dot sleep-dot--${sleep}" title="睡眠质量：${this._qLabel(sleep)}"></span>`;
        }
        if (recovery != null) {
            const tier = recoveryTier(recovery);
            markers += `<span class="recovery-score recovery-score--${tier}" title="Whoop 恢复评分：${recovery}（${this._recoveryLabel(tier)}）">${recovery}</span>`;
        }
        if (hasMeal) markers += '<span class="meal-dot" title="有饮食记录">🍽</span>';
        if (isOvulation) markers += '<span class="ovulation-dot" title="预计排卵期"></span>';
        if (isNext && !pd) markers += '<span class="next-period-badge" title="预计下次经期">预</span>';

        return `<div class="${classes.join(' ')}" data-date="${dateStr}">`
            + `<span class="calendar-date">${dayNum}</span>`
            + `<div class="calendar-markers">${markers}</div>`
            + (pd && pd.isStart ? '<span class="period-start-badge" title="经期开始">🌸</span>' : '')
            + '</div>';
    }

    _miniCellHtml(dateStr) {
        const pd = this._periodDays.get(dateStr);
        const summary = this.data.summary;
        const isOvulation = summary && summary.ovulation_prediction === dateStr;
        const isNext = summary && summary.next_period_prediction === dateStr;
        const classes = ['mini-cell'];
        if (pd) classes.push('mini-period');
        if (pd && pd.isStart) classes.push('mini-period-start');
        if (isOvulation) classes.push('mini-ovulation');
        if (isNext && !pd) classes.push('mini-next');
        const dayNum = parseInt(dateStr.slice(-2), 10);
        return `<div class="${classes.join(' ')}" data-date="${dateStr}" title="${dateStr}">${dayNum}</div>`;
    }

    _renderLegend() {
        const el = document.getElementById('calendar-legend');
        if (!el) return;
        el.innerHTML = `
            <span class="legend-item"><span class="legend-swatch legend-swatch--period"></span>经期</span>
            <span class="legend-item"><span class="legend-swatch legend-swatch--start">🌸</span>经期开始</span>
            <span class="legend-item"><span class="legend-swatch legend-swatch--ovulation"></span>排卵期</span>
            <span class="legend-item"><span class="legend-swatch legend-swatch--next">预</span>预计经期</span>
            <span class="legend-item"><span class="legend-score legend-score--great">优秀</span>睡眠 ≥ 80</span>
            <span class="legend-item"><span class="legend-score legend-score--good">良好</span>睡眠 65-79</span>
            <span class="legend-item"><span class="legend-score legend-score--average">一般</span>睡眠 50-64</span>
            <span class="legend-item"><span class="legend-score legend-score--poor">较差</span>睡眠 &lt; 50</span>
            <span class="legend-item"><span class="legend-recovery legend-recovery--primed">蓄能</span>恢复 ≥ 67</span>
            <span class="legend-item"><span class="legend-recovery legend-recovery--fair">尚可</span>恢复 34-66</span>
            <span class="legend-item"><span class="legend-recovery legend-recovery--poor">透支</span>恢复 &lt; 34</span>
            <span class="legend-item"><span class="legend-dot legend-dot--good"></span>睡眠好</span>
            <span class="legend-item"><span class="legend-dot legend-dot--average"></span>睡眠一般</span>
            <span class="legend-item"><span class="legend-dot legend-dot--poor"></span>睡眠差</span>
            <span class="legend-item"><span class="legend-swatch legend-swatch--meal">🍽</span>饮食</span>
        `;
    }

    /* ── Controls & Events ─────────────────── */

    _initControls() {
        this._updateToggle();
    }

    _updateToggle() {
        const btnMonth = document.getElementById('cal-view-month');
        const btnYear = document.getElementById('cal-view-year');
        if (btnMonth) btnMonth.classList.toggle('active', this.viewMode === 'month');
        if (btnYear) btnYear.classList.toggle('active', this.viewMode === 'year');
    }

    _bindEvents() {
        const prev = document.getElementById('cal-prev');
        const next = document.getElementById('cal-next');
        const today = document.getElementById('cal-today');
        const btnMonth = document.getElementById('cal-view-month');
        const btnYear = document.getElementById('cal-view-year');

        if (prev) prev.addEventListener('click', () => this.prev());
        if (next) next.addEventListener('click', () => this.next());
        if (today) today.addEventListener('click', () => this.goToday());
        if (btnMonth) btnMonth.addEventListener('click', () => this.setView('month'));
        if (btnYear) btnYear.addEventListener('click', () => this.setView('year'));

        // Year-view mini-month title click → switch to that month.
        const grid = document.getElementById('calendar-grid');
        if (grid) {
            grid.addEventListener('click', (e) => {
                const title = e.target.closest('.mini-month-title');
                if (title && this.viewMode === 'year') {
                    const m = parseInt(title.parentElement.dataset.month, 10);
                    this.current = new Date(this.current.getFullYear(), m, 1);
                    this._loadedKey = null;
                    this.setView('month');
                }
            });
        }
    }

    _wireCellClicks(grid) {
        grid.addEventListener('click', (e) => {
            const cell = e.target.closest('[data-date]');
            if (!cell) return;
            const dateStr = cell.dataset.date;
            if (typeof App !== 'undefined' && App.onTimelineClick) {
                App.onTimelineClick(dateStr);
            }
        });
    }

    /* ── Date helpers ───────────────────────── */

    _range() {
        if (this.viewMode === 'year') {
            const y = this.current.getFullYear();
            return { from: `${y}-01-01`, to: `${y}-12-31` };
        }
        const y = this.current.getFullYear();
        const m = this.current.getMonth();
        return { from: this._fmt(y, m, 1), to: this._fmt(y, m + 1, 0) };
    }

    _fmt(y, m, d) {
        const dt = new Date(y, m, d);
        return dt.getFullYear() + '-' +
            String(dt.getMonth() + 1).padStart(2, '0') + '-' +
            String(dt.getDate()).padStart(2, '0');
    }

    _addDays(dateStr, days) {
        const d = new Date(dateStr + 'T12:00:00');
        d.setDate(d.getDate() + days);
        return d.getFullYear() + '-' +
            String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0');
    }

    _todayStr() {
        const d = new Date();
        return d.getFullYear() + '-' +
            String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0');
    }

    _qLabel(q) {
        return { good: '好', average: '一般', poor: '差' }[q] || q;
    }

    _scoreLabel(tier) {
        return { great: '优秀', good: '良好', average: '一般', poor: '较差' }[tier] || '';
    }

    _recoveryLabel(tier) {
        return { primed: '已蓄能', fair: '尚可', poor: '透支' }[tier] || '';
    }
}
