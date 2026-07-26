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

        // Initialize Whoop integration
        this._initWhoop();
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
            const [recordsResp, mealsResp] = await Promise.all([
                fetch('/api/records'),
                fetch('/api/meals')
            ]);
            if (recordsResp.ok) {
                const records = await recordsResp.json();
                this.timeline.setRecords(records);
            }
            if (mealsResp.ok) {
                const meals = await mealsResp.json();
                this.timeline.setMeals(meals);
            }
        } catch (err) {
            console.error('Failed to refresh timeline:', err);
        }
    },

    /* ── Whoop Integration ─────────────────── */

    async _initWhoop() {
        const statusText = document.getElementById('whoop-status-text');
        const connectBtn = document.getElementById('btn-whoop-connect');
        const syncBtn = document.getElementById('btn-whoop-sync');
        const disconnectBtn = document.getElementById('btn-whoop-disconnect');
        const resultEl = document.getElementById('whoop-result');

        try {
            const resp = await fetch('/api/whoop/status');
            const data = await resp.json();
            if (data.authenticated) {
                statusText.textContent = '✅ 已连接（' + (data.client_id || '') + '）';
                syncBtn.style.display = 'inline-block';
                disconnectBtn.style.display = 'inline-block';
            } else {
                statusText.textContent = '❌ 未连接';
                connectBtn.style.display = 'inline-block';
            }
        } catch (err) {
            statusText.textContent = '❌ 无法检查状态';
            connectBtn.style.display = 'inline-block';
        }

        // Connect button → redirect to Whoop auth
        connectBtn.addEventListener('click', async () => {
            try {
                const resp = await fetch('/api/whoop/auth');
                const data = await resp.json();
                if (data.auth_url) {
                    // Redirect to Whoop OAuth page
                    window.location.href = data.auth_url;
                } else {
                    resultEl.textContent = '错误: ' + (data.error || '未知错误');
                    resultEl.className = 'form-message error';
                }
            } catch (err) {
                resultEl.textContent = '连接失败: ' + err.message;
                resultEl.className = 'form-message error';
            }
        });

        // Sync button → trigger sync
        syncBtn.addEventListener('click', async () => {
            syncBtn.textContent = '🔄 同步中...';
            syncBtn.disabled = true;
            resultEl.textContent = '';
            try {
                const resp = await fetch('/api/whoop/sync?days=30', { method: 'POST' });
                const data = await resp.json();
                if (data.error) {
                    resultEl.textContent = '同步失败: ' + data.error;
                    resultEl.className = 'form-message error';
                    if (data.need_auth) {
                        statusText.textContent = '❌ 未连接';
                        connectBtn.style.display = 'inline-block';
                        syncBtn.style.display = 'none';
                        disconnectBtn.style.display = 'none';
                    }
                } else {
                    resultEl.textContent = `✅ 同步完成！新增 ${data.created} 条，更新 ${data.updated} 条`;
                    resultEl.className = 'form-message success';
                    // Refresh the timeline to show new data
                    await this._refreshTimeline();
                    await this.form.loadDate(this.currentDate);
                }
            } catch (err) {
                resultEl.textContent = '同步失败: ' + err.message;
                resultEl.className = 'form-message error';
            } finally {
                syncBtn.textContent = '🔄 同步数据';
                syncBtn.disabled = false;
            }
        });

        // Disconnect button
        disconnectBtn.addEventListener('click', async () => {
            if (!confirm('确定断开 Whoop 连接？')) return;
            try {
                await fetch('/api/whoop/disconnect', { method: 'POST' });
                statusText.textContent = '❌ 未连接';
                connectBtn.style.display = 'inline-block';
                syncBtn.style.display = 'none';
                disconnectBtn.style.display = 'none';
                resultEl.textContent = '已断开 Whoop 连接';
                resultEl.className = 'form-message';
            } catch (err) {
                resultEl.textContent = '断开失败: ' + err.message;
                resultEl.className = 'form-message error';
            }
        });
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