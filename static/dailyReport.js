/**
 * dailyReport.js — 每日综合报告：把当天睡眠摘要与 AI 分析结论合并保存，
 * 并按日期回看。配合 GET/POST /api/daily-report 与 /api/daily-report/dates。
 */

class DailyReportManager {
    constructor(options = {}) {
        this.onDateChange = options.onDateChange || null;

        this.generateBtn = document.getElementById('btn-daily-report-generate');
        this.statusEl = document.getElementById('daily-report-status');
        this.outputEl = document.getElementById('daily-report-output');
        this.dateSelect = document.getElementById('daily-report-date-select');

        this.currentDate = null;
        this._initEvents();
    }

    _initEvents() {
        if (this.generateBtn) {
            this.generateBtn.addEventListener('click', () => this.generate());
        }
        if (this.dateSelect) {
            this.dateSelect.addEventListener('change', (e) => {
                const date = e.target.value;
                if (!date || date === this.currentDate) return;
                if (typeof this.onDateChange === 'function') {
                    this.onDateChange(date);
                }
            });
        }
    }

    /* ── Public API ───────────────────────── */

    async init(dateStr) {
        this.loadDates();
        await this.loadDate(dateStr);
    }

    async loadDate(dateStr) {
        if (!dateStr || !this.outputEl) return;
        this.currentDate = dateStr;
        this._setStatus('');
        this.outputEl.classList.add('hidden');

        try {
            const resp = await fetch(`/api/daily-report?date=${encodeURIComponent(dateStr)}`);
            if (resp.status === 404) {
                this._renderEmpty(dateStr);
                return;
            }
            const data = await resp.json();
            if (!resp.ok) {
                this._renderError(data.error || '加载失败');
                return;
            }
            this._render(data.report);
        } catch (err) {
            this._renderError('网络错误：' + err.message);
        }

        if (this.dateSelect && this.dateSelect.value !== dateStr) {
            this.dateSelect.value = dateStr;
        }
    }

    async generate() {
        if (!this.currentDate || !this.generateBtn) return;
        const dateStr = this.currentDate;
        const originalText = this.generateBtn.textContent;

        this.generateBtn.disabled = true;
        this.generateBtn.textContent = '生成中…';
        this._setStatus('');

        try {
            const resp = await fetch(
                `/api/daily-report/generate?date=${encodeURIComponent(dateStr)}`,
                { method: 'POST' }
            );
            const data = await resp.json();
            if (!resp.ok) {
                this._setStatus(data.error || '生成失败', true);
                return;
            }
            this._render(data.report);
            this.loadDates();
        } catch (err) {
            this._setStatus('网络错误：' + err.message, true);
        } finally {
            this.generateBtn.disabled = false;
            this.generateBtn.textContent = originalText;
        }
    }

    async loadDates() {
        if (!this.dateSelect) return;
        try {
            const resp = await fetch('/api/daily-report/dates');
            const data = await resp.json();
            this._populateDateSelect(data.dates || []);
        } catch (e) {
            console.error('[DailyReport] loadDates failed:', e);
        }
    }

    /* ── Rendering ────────────────────────── */

    _render(report) {
        if (!this.outputEl) return;
        const s = report.sleep_summary || {};
        const q = s.quality_breakdown || { good: 0, average: 0, poor: 0 };
        const c = s.classification_breakdown || { early: 0, late: 0 };

        const problemNames = {
            insomnia: '失眠', dreams: '多梦', sweats: '多汗',
            waking: '频醒', early_waking: '早醒'
        };
        let problemsHtml = '';
        if (s.problem_frequency && Object.keys(s.problem_frequency).length > 0) {
            problemsHtml = `
                <div class="breakdown-group" style="margin-top:12px;">
                    <h4>⚠️ 睡眠问题</h4>
                    <div class="breakdown-bars">
                        ${Object.entries(s.problem_frequency)
                            .sort((a, b) => b[1] - a[1])
                            .map(([k, v]) => this._barRow(problemNames[k] || k, v, s.total_records, 'poor'))
                            .join('')}
                    </div>
                </div>`;
        }

        this.outputEl.innerHTML = `
            <div class="daily-report-head">
                <span class="daily-report-date">📅 ${this._esc(s.date || report.report_date)}</span>
                <span class="daily-report-badge">已保存</span>
            </div>
            <div class="report-summary" style="margin-top:12px;">
                ${this._statCard((s.total_hours || 0) + 'h', '总睡眠')}
                ${this._statCard((s.total_records || 0) + '条', '记录数')}
                ${this._statCard(`${q.good || 0}/${q.average || 0}/${q.poor || 0}`, '良/一般/差')}
            </div>
            <div class="report-breakdown" style="margin-top:12px;">
                <div class="breakdown-group">
                    <h4>😴 睡眠质量</h4>
                    <div class="breakdown-bars">
                        ${this._barRow('良好', q.good || 0, s.total_records || 0, 'good')}
                        ${this._barRow('一般', q.average || 0, s.total_records || 0, 'average')}
                        ${this._barRow('较差', q.poor || 0, s.total_records || 0, 'poor')}
                    </div>
                </div>
                <div class="breakdown-group">
                    <h4>⏰ 入睡分类</h4>
                    <div class="breakdown-bars">
                        ${this._barRow('早睡', c.early || 0, s.total_records || 0, 'early')}
                        ${this._barRow('晚睡', c.late || 0, s.total_records || 0, 'late')}
                    </div>
                </div>
            </div>
            ${problemsHtml}
            <div class="daily-report-ai">
                <h4>🤖 AI 分析结论</h4>
                <div class="brief-text">${this._esc(report.ai_brief_text || '').replace(/\n/g, '<br>')}</div>
            </div>
        `;
        this.outputEl.classList.remove('hidden');
    }

    _renderEmpty(dateStr) {
        if (!this.outputEl) return;
        this.outputEl.innerHTML = `<p class="report-placeholder">${this._esc(dateStr)} 尚无综合报告，点击上方「生成/刷新当日报告」创建。</p>`;
        this.outputEl.classList.remove('hidden');
    }

    _renderError(msg) {
        if (!this.outputEl) return;
        this.outputEl.innerHTML = `<p class="report-placeholder" style="color:var(--danger)">❌ ${this._esc(msg)}</p>`;
        this.outputEl.classList.remove('hidden');
    }

    _populateDateSelect(dates) {
        if (!this.dateSelect) return;
        const current = this.currentDate;
        this.dateSelect.innerHTML = '<option value="">选择日期…</option>' +
            dates.map(d => `<option value="${this._esc(d)}">${this._esc(d)}</option>`).join('');
        if (current) this.dateSelect.value = current;
    }

    _setStatus(text, isError) {
        if (!this.statusEl) return;
        this.statusEl.textContent = text || '';
        this.statusEl.classList.toggle('error', !!isError);
    }

    _statCard(value, label) {
        return `<div class="stat-card">
            <div class="stat-value">${this._esc(value)}</div>
            <div class="stat-label">${this._esc(label)}</div>
        </div>`;
    }

    _barRow(label, count, total, cssClass) {
        const pct = total > 0 ? Math.round(count / total * 100) : 0;
        return `<div class="bar-row">
            <span class="bar-label">${this._esc(label)}</span>
            <span class="bar-track"><span class="bar-fill ${this._esc(cssClass)}" style="width:${pct}%"></span></span>
            <span class="bar-count">${count}天</span>
        </div>`;
    }

    _esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[c]));
    }
}

// Expose for App.js
window.DailyReportManager = DailyReportManager;
