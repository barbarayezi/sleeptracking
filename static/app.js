/**
 * app.js — Main orchestrator: initializes all modules, wires events,
 * coordinates timeline/form/report refresh.
 */

const App = {
    form: null,
    meal: null,
    period: null,
    timeline: null,
    calendar: null,
    report: null,
    health: null,
    currentDate: null,
    deferredInstallPrompt: null,

    /** Initialize the application. */
    async init() {
        // Create module instances
        this.form = new FormManager();
        this.meal = new MealManager();
        this.period = new PeriodManager();
        this.timeline = new Timeline('timeline-canvas', 'timeline-empty');
        this.calendar = new Calendar();
        this.report = new ReportManager();
        this.health = new HealthOverview();
        const healthRefresh = document.getElementById('btn-health-refresh');
        if (healthRefresh) {
            healthRefresh.addEventListener('click', () => this.health.load());
        }

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
        await this.period.loadDate(this.currentDate);
        await this._refreshTimeline();
        await this.health.load();

        // Initialize Whoop integration
        this._initWhoop();

        // Register Service Worker & PWA install
        this._registerServiceWorker();
        this._initInstallPrompt();
        this._initCategoryNav();
    },

    /* ── Callbacks (called by child modules) ── */

    onRecordSaved(record) {
        this._refreshTimeline();
        this.calendar.refresh();
    },

    onRecordDeleted(dateStr) {
        this._refreshTimeline();
        this.calendar.refresh();
    },

    onPeriodSaved() {
        this._refreshTimeline();
        this.calendar.refresh();
    },

    onTimelineClick(dateStr) {
        this.currentDate = dateStr;
        this._updateDateLabel();
        this.form.loadDate(dateStr);
        this.meal.loadDate(dateStr);
        this.period.loadDate(dateStr);
        this.calendar.showDate(dateStr);
    },

    /* ── Date Navigation ──────────────────── */

    _initDateNavigation() {
        document.getElementById('btn-prev-day').addEventListener('click', () => {
            this.currentDate = this._addDays(this.currentDate, -1);
            this._updateDateLabel();
            this.form.loadDate(this.currentDate);
            this.meal.loadDate(this.currentDate);
            this.period.loadDate(this.currentDate);
            this.calendar.showDate(this.currentDate);
        });

        document.getElementById('btn-next-day').addEventListener('click', () => {
            this.currentDate = this._addDays(this.currentDate, 1);
            this._updateDateLabel();
            this.form.loadDate(this.currentDate);
            this.meal.loadDate(this.currentDate);
            this.period.loadDate(this.currentDate);
            this.calendar.showDate(this.currentDate);
        });

        document.getElementById('btn-today').addEventListener('click', () => {
            this.currentDate = this._todayStr();
            this._updateDateLabel();
            this.form.loadDate(this.currentDate);
            this.meal.loadDate(this.currentDate);
            this.period.loadDate(this.currentDate);
            this.calendar.showDate(this.currentDate);
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
            const [recordsResp, mealsResp, periodsResp, summaryResp, dailyResp, stepsResp] = await Promise.all([
                fetch('/api/records'),
                fetch('/api/meals'),
                fetch('/api/periods'),
                fetch('/api/periods/summary'),
                fetch('/api/whoop/daily'),
                fetch('/api/healthkit/metrics?type=steps')
            ]);
            if (recordsResp.ok) {
                const records = await recordsResp.json();
                this.timeline.setRecords(records);
            }
            if (mealsResp.ok) {
                const meals = await mealsResp.json();
                this.timeline.setMeals(meals);
            }
            if (periodsResp.ok) {
                const periods = await periodsResp.json();
                this.timeline.setPeriods(periods);
            }
            if (summaryResp.ok) {
                const summary = await summaryResp.json();
                this.timeline.setCycleInfo(summary);
                this._updateCycleBadge(summary);
            }
            if (dailyResp.ok) {
                const daily = await dailyResp.json();
                this.timeline.setDailyMetrics(daily);
            }
            if (stepsResp.ok) {
                const steps = await stepsResp.json();
                this.timeline.setSteps(steps);
            }
            // Keep the health overview dashboard in sync (non-blocking)
            if (this.health) this.health.refresh();
        } catch (err) {
            console.error('Failed to refresh timeline:', err);
        }
    },

    _updateCycleBadge(summary) {
        const el = document.getElementById('period-cycle-badge');
        if (!el) return;
        if (!summary || !summary.has_data) {
            el.innerHTML = '<span class="cycle-badge__empty">记录两次经期开始日即可自动推算周期 🌸</span>';
            return;
        }
        const phaseNames = { menstrual: '经期', follicular: '卵泡期', ovulation: '排卵期', luteal: '黄体期' };
        const phase = phaseNames[summary.current_phase] || summary.current_phase || '—';
        let txt = `当前阶段：${phase}`;
        if (summary.days_until_next != null) {
            if (summary.days_until_next > 0) txt += ` · 距下次经期约 ${summary.days_until_next} 天`;
            else if (summary.days_until_next === 0) txt += ` · 预计今天来潮`;
            else txt += ` · 已过预测日 ${-summary.days_until_next} 天`;
        }
        if (summary.avg_cycle_length) txt += ` · 平均周期 ${summary.avg_cycle_length} 天`;
        el.innerHTML = `<span class="cycle-badge__info">🌿 ${txt}</span>`;
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

        // Check URL params (redirected back from Whoop OAuth)
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('whoop') === 'connected') {
            resultEl.textContent = '✅ Whoop 连接成功！点击"同步数据"拉取手环数据。';
            resultEl.className = 'form-message success';
            // Refresh status
            statusText.textContent = '✅ 已连接';
            connectBtn.style.display = 'none';
            syncBtn.style.display = 'inline-block';
            disconnectBtn.style.display = 'inline-block';
            // Clean URL
            window.history.replaceState({}, '', window.location.pathname);
        } else if (urlParams.get('whoop') === 'error') {
            resultEl.textContent = '❌ 连接失败: ' + (urlParams.get('msg') || '未知错误');
            resultEl.className = 'form-message error';
            window.history.replaceState({}, '', window.location.pathname);
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
        this._whoopSyncWithUI = async (days) => {
            syncBtn.textContent = '🔄 同步中...';
            syncBtn.disabled = true;
            resultEl.textContent = '';
            try {
                const resp = await fetch(`/api/whoop/sync?days=${days}`, { method: 'POST' });
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
        };
        syncBtn.addEventListener('click', () => this._whoopSyncWithUI(30));

        // Auto-sync: when page loads, silently sync recent data
        if (statusText.textContent.includes('已连接')) {
            setTimeout(async () => {
                try {
                    const resp = await fetch('/api/whoop/sync?days=2', { method: 'POST' });
                    const data = await resp.json();
                    if (!data.error) {
                        await this._refreshTimeline();
                        await this.form.loadDate(this.currentDate);
                    }
                } catch (_) {}
            }, 2000);
        }

        // Periodic auto-sync every 5 minutes (near-real-time while page is open)
        setInterval(async () => {
            if (statusText.textContent.includes('已连接')) {
                try {
                    const resp = await fetch('/api/whoop/sync?days=2', { method: 'POST' });
                    if (!resp.ok) return;
                    const data = await resp.json();
                    if (!data.error) {
                        await this._refreshTimeline();
                        await this.form.loadDate(this.currentDate);
                    }
                } catch (_) {}
            }
        }, 5 * 60 * 1000);

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

    /* ── PWA: Service Worker & Install ────────── */

    _registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return;
        navigator.serviceWorker.register('/sw.js')
            .then((reg) => {
                console.log('SW registered, scope:', reg.scope);
                // 主动检查更新；发现新 SW 时尝试让它立即生效
                const tryUpdate = () => reg.update().catch(() => {});
                if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
                setInterval(tryUpdate, 60 * 1000); // 每分钟检查一次
                tryUpdate();
            })
            .catch((err) => console.warn('SW registration failed:', err));

        // 当控制页面的 SW 发生变化（新版本生效）时，自动刷新一次以显示最新 UI
        let reloaded = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (reloaded) return;
            reloaded = true;
            window.location.reload();
        });
    },

    _initInstallPrompt() {
        const installBtn = document.getElementById('btn-install');

        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            this.deferredInstallPrompt = e;
            installBtn.classList.remove('hidden');
        });

        installBtn.addEventListener('click', async () => {
            if (!this.deferredInstallPrompt) return;
            this.deferredInstallPrompt.prompt();
            const { outcome } = await this.deferredInstallPrompt.userChoice;
            if (outcome === 'accepted') {
                installBtn.classList.add('hidden');
            }
            this.deferredInstallPrompt = null;
        });

        // Hide button if app is already installed
        window.addEventListener('appinstalled', () => {
            installBtn.classList.add('hidden');
            this.deferredInstallPrompt = null;
        });
    },

    /* ── Category Nav (scroll-spy) ──────────── */
    _initCategoryNav() {
        const navItems = Array.from(document.querySelectorAll('.cat-nav-item'));
        if (!navItems.length || !('IntersectionObserver' in window)) return;
        const groups = navItems
            .map((a) => document.querySelector(a.getAttribute('href')))
            .filter(Boolean);
        if (!groups.length) return;

        const setActive = (id) => {
            navItems.forEach((a) =>
                a.classList.toggle('active', a.getAttribute('href') === '#' + id)
            );
        };

        const observer = new IntersectionObserver(
            (entries) => {
                entries.forEach((e) => {
                    if (e.isIntersecting) setActive(e.target.id);
                });
            },
            { rootMargin: '-140px 0px -60% 0px', threshold: 0 }
        );
        groups.forEach((g) => observer.observe(g));
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