/**
 * app.js — Main orchestrator: initializes all modules, wires events,
 * coordinates timeline/form/report refresh.
 */

const App = {
    form: null,
    meal: null,
    period: null,
    medication: null,
    timeline: null,
    calendar: null,
    health: null,
    research: null,
    currentDate: null,
    deferredInstallPrompt: null,

    /** Initialize the application. */
    async init() {
        // Create module instances
        this.form = new FormManager();
        this.meal = new MealManager();
        this.period = new PeriodManager();
        this.medication = new MedicationManager();
        this.timeline = new Timeline('timeline-canvas', 'timeline-empty');
        this.calendar = new Calendar();
        this.health = new HealthOverview();
        this.research = new ResearchDashboard({
            range: 30,
            onDateChange: (dateStr) => this.setDate(dateStr)
        });
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
        await this.medication.loadDate(this.currentDate);

        // 图表分析 Tab 的重模块（时间线/科研看板/健康总览）改为首进该 Tab 时懒加载，
        // 见 _loadChartsTab()——首屏只保证概览页秒开。

        // Load Hero 首页概览（昨晚睡眠 + 指标芯片 + 本周/Whoop 总览）
        if (window.HeroOverview) HeroOverview.refresh();

        // Initialize Whoop integration
        this._initWhoop();

        // Register Service Worker & PWA install
        this._registerServiceWorker();
        this._initInstallPrompt();
        // Tab 导航（含根据 hash 决定是否立即加载图表 Tab）
        this._initCategoryNav();

        // Backup: export / import
        this._initBackup();
    },

    /** Fetch with a timeout so a wedged backend does not leave the UI hanging forever. */
    async _fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const resp = await fetch(url, { ...options, signal: controller.signal });
            return resp;
        } finally {
            clearTimeout(id);
        }
    },

    /* ── Callbacks (called by child modules) ── */

    onRecordSaved(record) {
        this._refreshTimeline();
        this.calendar.refresh();
        if (window.HeroOverview) HeroOverview.refresh();
        this.health.refresh();
        if (this.research) this.research.refresh();
    },

    onRecordDeleted(dateStr) {
        this._refreshTimeline();
        this.calendar.refresh();
        if (window.HeroOverview) HeroOverview.refresh();
        this.health.refresh();
        if (this.research) this.research.refresh();
    },

    onPeriodSaved() {
        this._refreshTimeline();
        this.calendar.refresh();
        if (window.HeroOverview) HeroOverview.refresh();
        this.health.refresh();
        if (this.research) this.research.refresh();
    },

    onTimelineClick(dateStr) {
        this.setDate(dateStr);
    },

    /* ── Today at a glance ─────────────────── */

    async _loadToday() {
        try {
            const resp = await fetch('/api/dashboard/today');
            if (!resp.ok) return;
            const d = await resp.json();
            this._renderToday(d);
        } catch (e) {
            console.error('today load failed', e);
        }
    },

    _renderToday(d) {
        const grid = document.getElementById('today-grid');
        if (!grid) return;
        const qMap = { good: '良好', average: '一般', poor: '较差' };
        const cMap = { early: '早睡', late: '晚睡' };
        const typeNames = { breakfast: '早', lunch: '午', dinner: '晚', snack: '加' };
        const sleepTypeNames = { night: '夜间', nap: '午睡', segment: '分段' };
        const phaseNames = { menstrual: '经期', follicular: '卵泡期', ovulation: '排卵期', luteal: '黄体期' };
        const cells = [];

        // Last sleep
        const sl = d.last_sleep;
        if (sl) {
            const when = (sl.record_date === this._todayStr()) ? '今晨' : (sl.record_date || '');
            const tName = sleepTypeNames[sl.record_type] || '';
            const qtxt = qMap[sl.quality] || sl.quality || '';
            const hours = sl.hours != null ? sl.hours + '<small>h</small>' : '—';
            cells.push(`<div class="today-cell">
                <div class="today-cell__label">😴 最近睡眠</div>
                <div class="today-cell__value ${sl.quality || ''}">${hours}</div>
                <div class="today-cell__hint">${when}${tName ? ' · ' + tName : ''}${qtxt ? ' · ' + qtxt : ''}${cMap[sl.classification] ? ' · ' + cMap[sl.classification] : ''}${sl.device_score != null ? ' · 手环' + sl.device_score : ''}</div>
            </div>`);
        } else {
            cells.push(`<div class="today-cell">
                <div class="today-cell__label">😴 最近睡眠</div>
                <div class="today-cell__value">—</div>
                <div class="today-cell__hint">还没有记录，点下方「记录睡眠」</div>
            </div>`);
        }

        // Today meals
        const m = d.today_meals || { count: 0, types: [] };
        const done = (m.types || []).map(t => typeNames[t] || t).join(' ');
        cells.push(`<div class="today-cell">
            <div class="today-cell__label">🍽️ 今日饮食</div>
            <div class="today-cell__value">${m.count}<small>餐</small></div>
            <div class="today-cell__hint">${m.count ? '已记：' + done : '今天还没记录饮食'}</div>
        </div>`);

        // Cycle
        const cy = d.cycle || {};
        let cycleVal = '—', cycleHint = '记录两次经期开始日可自动推算';
        if (cy.has_data) {
            cycleVal = phaseNames[cy.current_phase] || cy.current_phase || '—';
            if (cy.days_until_next != null) {
                if (cy.days_until_next > 0) cycleHint = '距下次经期约 ' + cy.days_until_next + ' 天';
                else if (cy.days_until_next === 0) cycleHint = '预计今天来潮';
                else cycleHint = '已过预测日 ' + (-cy.days_until_next) + ' 天';
            }
        }
        cells.push(`<div class="today-cell">
            <div class="today-cell__label">🌸 经期阶段</div>
            <div class="today-cell__value">${cycleVal}</div>
            <div class="today-cell__hint">${cycleHint}</div>
        </div>`);

        // Whoop sync
        const w = d.whoop || {};
        const whoopHint = w.last_sync_date ? '最近同步 ' + w.last_sync_date : '尚未同步手环数据';
        cells.push(`<div class="today-cell">
            <div class="today-cell__label">⌚ Whoop 同步</div>
            <div class="today-cell__value">${w.authenticated ? '已连接' : '未连接'}</div>
            <div class="today-cell__hint">${whoopHint}</div>
        </div>`);

        grid.innerHTML = cells.join('');
    },

    /* ── Date Navigation ──────────────────── */

    _initDateNavigation() {
        document.getElementById('btn-prev-day').addEventListener('click', () => {
            this.setDate(this._addDays(this.currentDate, -1));
        });

        document.getElementById('btn-next-day').addEventListener('click', () => {
            this.setDate(this._addDays(this.currentDate, 1));
        });

        document.getElementById('btn-today').addEventListener('click', () => {
            this.setDate(this._todayStr());
        });
    },

    /** Central date switcher: update all date-bound modules together. */
    setDate(dateStr) {
        if (!dateStr || dateStr === this.currentDate) return;
        this.currentDate = dateStr;
        this._updateDateLabel();
        this.form.loadDate(dateStr);
        this.meal.loadDate(dateStr);
        this.period.loadDate(dateStr);
        this.medication.loadDate(dateStr);
        this.calendar.showDate(dateStr);
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

        // 轮询同步任务状态，直到完成（最多 ~120s）
        this._pollSyncUntilDone = async (onProgress) => {
            const deadline = Date.now() + 120000;
            while (Date.now() < deadline) {
                try {
                    const resp = await this._fetchWithTimeout('/api/whoop/sync/status', {}, 5000);
                    const st = await resp.json();
                    if (!st.running) return st;
                    if (onProgress) onProgress(st.elapsed || 0);
                } catch (_) {}
                await new Promise(r => setTimeout(r, 2000));
            }
            return null;
        };

        // 静默自动同步（页面加载 / 定时）：触发后轮询，完成时刷新时间线
        this._autoSync = async (days) => {
            try {
                await this._fetchWithTimeout(`/api/whoop/sync?days=${days}`, { method: 'POST' }, 8000);
                const st = await this._pollSyncUntilDone(null);
                if (st && !st.error) {
                    await this._refreshTimeline();
                    await this.form.loadDate(this.currentDate);
                    this._checkSyncHealth();
                    if (window.HeroOverview) HeroOverview.refresh();
                }
            } catch (_) {}
        };

        // Sync button → trigger async sync (returns immediately, UI polls status)
        this._whoopSyncWithUI = async (days) => {
            syncBtn.textContent = '🔄 同步中...';
            syncBtn.disabled = true;
            resultEl.textContent = '';
            try {
                const resp = await this._fetchWithTimeout(`/api/whoop/sync?days=${days}`, { method: 'POST' }, 8000);
                const data = await resp.json();
                if (data.status === 'already_running') {
                    resultEl.textContent = '同步已在进行中…';
                }
                const st = await this._pollSyncUntilDone((elapsed) => {
                    resultEl.textContent = `🔄 同步中…（已 ${elapsed}s）`;
                });
                if (!st) {
                    resultEl.textContent = '同步状态查询超时，请稍后刷新页面查看';
                    resultEl.className = 'form-message';
                } else if (st.error) {
                    resultEl.textContent = '同步失败: ' + st.error.message;
                    resultEl.className = 'form-message error';
                    if (st.error.need_auth) {
                        statusText.textContent = '❌ 未连接';
                        connectBtn.style.display = 'inline-block';
                        syncBtn.style.display = 'none';
                        disconnectBtn.style.display = 'none';
                    }
                } else {
                    const s = (st.result && st.result.sleep) || {};
                    if ((s.created || 0) > 0 || (s.updated || 0) > 0) {
                        resultEl.textContent = `✅ 同步完成！新增 ${s.created} 条，更新 ${s.updated} 条`;
                    } else {
                        resultEl.textContent = '✅ 已是最新（Whoop 暂无新睡眠数据）';
                    }
                    resultEl.className = 'form-message success';
                    await this._refreshTimeline();
                    await this.form.loadDate(this.currentDate);
                    this._checkSyncHealth();
                }
            } catch (err) {
                if (err.name === 'AbortError') {
                    resultEl.textContent = '同步请求超时：后端未响应，请检查后端是否卡住或重启服务';
                } else {
                    resultEl.textContent = '同步请求失败: ' + err.message;
                }
                resultEl.className = 'form-message error';
            } finally {
                syncBtn.textContent = '🔄 同步数据';
                syncBtn.disabled = false;
            }
        };
        syncBtn.addEventListener('click', () => this._whoopSyncWithUI(30));

        // Auto-sync: when page loads, silently sync recent data
        if (statusText.textContent.includes('已连接')) {
            setTimeout(() => this._autoSync(2), 2000);
        }

        // Periodic auto-sync every 5 minutes (near-real-time while page is open)
        setInterval(() => {
            if (statusText.textContent.includes('已连接')) {
                this._autoSync(2);
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

        // Initial health check (after we know connection status)
        this._checkSyncHealth();
    },

    /* ── Sync health: detect missing sleep + show last sync ── */

    async _checkSyncHealth() {
        const alertEl = document.getElementById('whoop-gap-alert');
        const lastSyncEl = document.getElementById('whoop-last-sync');
        const statusText = document.getElementById('whoop-status-text');
        if (!alertEl || !lastSyncEl) return;
        try {
            const resp = await fetch('/api/sync-health?date=' + this._todayStr());
            if (!resp.ok) return;
            const d = await resp.json();

            // 连接状态以后端为准；旧版接口无 authenticated 字段时退回 DOM 文本
            const connected = (typeof d.authenticated === 'boolean')
                ? d.authenticated
                : !!(statusText && statusText.textContent.includes('已连接'));

            // 同步失败时不再谎报“最后同步：刚刚”，改为显示真实原因
            if (d.last_sync_error) {
                lastSyncEl.textContent = '⚠️ 上次同步未取到数据：' + d.last_sync_error;
            } else {
                lastSyncEl.textContent = d.last_sync_at
                    ? '🕒 最后同步：' + d.last_sync_at
                    : '';
            }

            const hour = new Date().getHours();
            const missingDays = d.missing_days || 0;

            if (!connected && d.has_history) {
                // 未连接 = 静默丢数据的真凶，此前完全无提示
                alertEl.innerHTML = '⚠️ <strong>Whoop 未连接，睡眠数据已停止同步'
                    + (missingDays >= 2 ? '（最近 ' + missingDays + ' 天无记录）' : '')
                    + '。</strong>请点击上方「连接 Whoop」重新授权；'
                    + '授权成功后会自动补拉最近 30 天数据。';
                alertEl.style.display = 'block';
            } else if (connected && d.has_history && missingDays >= 2) {
                alertEl.innerHTML = '⚠️ <strong>最近 ' + missingDays +
                    ' 天没有睡眠数据。</strong>最常见原因是 Whoop 手环蓝牙断开、' +
                    '没把数据同步到云端。请打开 Whoop App 确认手环已连接并手动同步一次；' +
                    '重新同步后本应用会在几分钟内自动补上。';
                alertEl.style.display = 'block';
            } else if (connected && d.sleep_count === 0 && hour >= 9) {
                alertEl.innerHTML = '⚠️ <strong>今天（' + d.date +
                    '）的睡眠数据还没收到。</strong>最常见原因是 Whoop 手环蓝牙断开、' +
                    '没把数据同步到云端。请打开 Whoop App 确认手环已连接并手动同步一次；' +
                    '重新同步后本应用会在几分钟内自动补上。';
                alertEl.style.display = 'block';
            } else {
                alertEl.style.display = 'none';
            }
        } catch (e) {
            // Non-fatal: never block the UI over a health-check failure
            alertEl.style.display = 'none';
        }
    },

    /* ── PWA: Service Worker & Install ────────── */

    _registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return;
        navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
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

    /* ── Category Nav (Tab 单页切换) ──────────── */
    _initCategoryNav() {
        this._catNavItems = Array.from(document.querySelectorAll('.cat-nav-item'));
        if (!this._catNavItems.length) return;

        this._catNavItems.forEach((a) => {
            a.addEventListener('click', (e) => {
                e.preventDefault();
                const id = a.getAttribute('href').slice(1);
                this._showGroup(id, /*updateHash*/ true);
            });
        });

        // Deep-link: honour #group-xxx on load, fall back to 概览.
        const initial = (location.hash || '').replace('#', '');
        const valid = this._catNavItems.some((a) => a.getAttribute('href') === '#' + initial);
        this._showGroup(valid ? initial : 'group-overview', /*updateHash*/ valid);

        // Back/forward buttons follow the hash.
        window.addEventListener('hashchange', () => {
            const id = (location.hash || '').replace('#', '');
            if (this._catNavItems.some((a) => a.getAttribute('href') === '#' + id)) {
                this._showGroup(id, false);
            }
        });
    },

    /** Show one category group, hide the rest, mark nav + lazily load heavy tabs. */
    _showGroup(id, updateHash) {
        document.querySelectorAll('.category-group').forEach((g) =>
            g.classList.toggle('active', g.id === id)
        );
        (this._catNavItems || []).forEach((a) =>
            a.classList.toggle('active', a.getAttribute('href') === '#' + id)
        );
        if (updateHash) {
            // replace (not push) so tab switches don't spam the history stack
            history.replaceState(null, '', '#' + id);
        }
        if (id === 'group-display') this._loadChartsTab();
    },

    /** Lazily load the heavy chart modules the first time 图表分析 is opened. */
    _loadChartsTab() {
        if (this._chartsTabLoaded) return;
        this._chartsTabLoaded = true;
        if (this.timeline) this._refreshTimeline();
        if (this.research) this.research.load();
        if (this.health) this.health.load();
    },

    _initBackup() {
        const exportBtn = document.getElementById('btn-export');
        const importBtn = document.getElementById('btn-import');
        const fileInput = document.getElementById('import-file');
        const msg = document.getElementById('backup-msg');
        if (exportBtn) {
            exportBtn.addEventListener('click', () => {
                const a = document.createElement('a');
                a.href = '/api/export';
                a.download = 'sleep-tracker-backup.json';
                document.body.appendChild(a);
                a.click();
                a.remove();
            });
        }
        if (importBtn && fileInput) {
            importBtn.addEventListener('click', () => fileInput.click());
            fileInput.addEventListener('change', async (e) => {
                const file = e.target.files && e.target.files[0];
                if (!file) return;
                importBtn.disabled = true;
                msg.textContent = '导入中…';
                msg.className = 'form-message';
                try {
                    const text = await file.text();
                    const resp = await fetch('/api/import', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: text
                    });
                    const data = await resp.json();
                    if (data.ok) {
                        const n = Object.keys(data.summary || {}).length;
                        msg.textContent = '✅ 导入成功（' + n + ' 张表）';
                        msg.className = 'form-message success';
                        this.meal.loadDate(this.currentDate);
                        this.period.loadDate(this.currentDate);
                        this.form.loadDate(this.currentDate);
                        this._refreshTimeline();
                        this._loadToday();
                    } else {
                        msg.textContent = '❌ ' + (data.error || '导入失败');
                        msg.className = 'form-message error';
                    }
                } catch (err) {
                    msg.textContent = '❌ ' + err.message;
                    msg.className = 'form-message error';
                } finally {
                    importBtn.disabled = false;
                    fileInput.value = '';
                }
            });
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