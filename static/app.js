/**
 * app.js — Main orchestrator: initializes all modules, wires events,
 * coordinates timeline/form/report refresh.
 */

const App = {
    form: null,
    meal: null,
    timeline: null,
    report: null,
    currentDate: null,

    /** Initialize the application. */
    async init() {
        // Create module instances
        this.form = new FormManager();
        this.meal = new MealManager();
        this.timeline = new Timeline('timeline-canvas', 'timeline-empty');
        this.report = new ReportManager();

        // Wire date navigation
        this._initDateNavigation();

        // Wire timeline days selector
        document.getElementById('timeline-days').addEventListener('change', (e) => {
            this.timeline.setDays(parseInt(e.target.value));
        });

        // Load today's data
        this.currentDate = this._todayStr();
        this._updateDateLabel();
        await this.form.loadDate(this.currentDate);
        await this.meal.loadDate(this.currentDate);
        await this._refreshTimeline();
    },

    /* ── Callbacks (called by child modules) ── */

    onRecordSaved(record) {
        this._refreshTimeline();
    },

    onRecordDeleted(dateStr) {
        this._refreshTimeline();
    },

    onTimelineClick(dateStr) {
        this.currentDate = dateStr;
        this._updateDateLabel();
        this.form.loadDate(dateStr);
        this.meal.loadDate(dateStr);
    },

    /* ── Date Navigation ──────────────────── */

    _initDateNavigation() {
        document.getElementById('btn-prev-day').addEventListener('click', () => {
            this.currentDate = this._addDays(this.currentDate, -1);
            this._updateDateLabel();
            this.form.loadDate(this.currentDate);
            this.meal.loadDate(this.currentDate);
        });

        document.getElementById('btn-next-day').addEventListener('click', () => {
            this.currentDate = this._addDays(this.currentDate, 1);
            this._updateDateLabel();
            this.form.loadDate(this.currentDate);
            this.meal.loadDate(this.currentDate);
        });

        document.getElementById('btn-today').addEventListener('click', () => {
            this.currentDate = this._todayStr();
            this._updateDateLabel();
            this.form.loadDate(this.currentDate);
            this.meal.loadDate(this.currentDate);
        });
    },

    _updateDateLabel() {
        const label = document.getElementById('current-date-label');
        const today = this._todayStr();
        const yesterday = this._addDays(today, -1);
        const tomorrow = this._addDays(today, 1);

        if (this.currentDate === today) {
            label.textContent = '📅 今天';
        } else if (this.currentDate === yesterday) {
            label.textContent = '📅 昨天';
        } else if (this.currentDate === tomorrow) {
            label.textContent = '📅 明天';
        } else {
            label.textContent = '📅 ' + this.currentDate;
        }
    },

    /* ── Data Refresh ─────────────────────── */

    async _refreshTimeline() {
        try {
            const resp = await fetch('/api/records');
            if (resp.ok) {
                const records = await resp.json();
                this.timeline.setRecords(records);
            }
        } catch (err) {
            console.error('Failed to refresh timeline:', err);
        }
    },

    /* ── Date Utilities ───────────────────── */

    _todayStr() {
        const d = new Date();
        return d.getFullYear() + '-' +
            String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0');
    },

    _addDays(dateStr, days) {
        const d = new Date(dateStr + 'T12:00:00');
        d.setDate(d.getDate() + days);
        return d.getFullYear() + '-' +
            String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0');
    }
};

// Boot
document.addEventListener('DOMContentLoaded', () => App.init());