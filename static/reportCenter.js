/**
 * reportCenter.js — Unified "分析报告中心".
 *
 * Replaces the previous three separate features:
 *   - 每日综合报告 card (dailyReport.js + /api/daily-report/*)
 *   - 睡眠分析报告 weekly card (reports.js + /api/report)
 *   - AI 分析 daily brief + chat (agent.js + /api/daily-brief*)
 *
 * All three are now one section with a 日/周/月 tab, generate-and-save
 * button, history selector, and (for daily) an inline chat that
 * persists its turns as part of the saved report.
 *
 * Backend: /api/reports/<period>/<date>, /api/reports/<period>/generate,
 *          /api/reports/<period>/dates, /api/reports/daily/<date>/chat.
 */
(function () {
    class ReportCenterManager {
        constructor() {
            this.el = document.getElementById('report-center-output');
            this.chatEl = document.getElementById('report-center-chat');
            this.chatMessagesEl = document.getElementById('report-center-chat-messages');
            this.tabs = document.querySelectorAll('.report-center-tab');
            this.dateInput = document.getElementById('report-center-anchor');
            this.btnGenerate = document.getElementById('btn-report-center-generate');
            this.statusEl = document.getElementById('report-center-status');
            this.historySelect = document.getElementById('report-center-history-select');
            this.btnChatSend = document.getElementById('btn-report-center-chat-send');
            this.chatInput = document.getElementById('report-center-chat-input');
            this._currentPeriod = 'daily';
            this._currentReport = null;     // last loaded/fetched report
            this._init();
        }

        _init() {
            this.tabs.forEach((btn) => {
                btn.addEventListener('click', () => {
                    const period = btn.dataset.period;
                    if (period === this._currentPeriod) return;
                    this.tabs.forEach(b => b.classList.toggle('is-active', b === btn));
                    this._setPeriod(period);
                });
            });
            this.btnGenerate.addEventListener('click', () => this._generate());
            this.historySelect.addEventListener('change', (e) => {
                const date = e.target.value;
                if (date) this._loadReport(date);
            });
            if (this.btnChatSend && this.chatInput) {
                this.btnChatSend.addEventListener('click', () => this._sendChat());
                this.chatInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        this._sendChat();
                    }
                });
            }
            this.dateInput.value = this._todayStr();
            // Initial load: history for the default tab
            this._refreshHistory();
        }

        _setPeriod(period) {
            this._currentPeriod = period;
            this._currentReport = null;
            this._resetOutput();
            this._refreshHistory();
        }

        _todayStr() {
            const d = new Date();
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        }

        _resetOutput() {
            if (this.el) {
                this.el.classList.add('hidden');
                this.el.innerHTML = '';
            }
            if (this.chatEl) this.chatEl.classList.add('hidden');
            if (this.chatMessagesEl) this.chatMessagesEl.innerHTML = '';
        }

        _setStatus(text, type = '') {
            if (!this.statusEl) return;
            this.statusEl.textContent = text || '';
            this.statusEl.className = 'report-center-status' + (type ? ` is-${type}` : '');
        }

        _periodLabel(period) {
            return period === 'daily' ? '日报' : period === 'weekly' ? '周报' : '月报';
        }

        async _refreshHistory() {
            if (!this.historySelect) return;
            const period = this._currentPeriod;
            try {
                const resp = await fetch(`/api/reports/${period}/dates`);
                const data = await resp.json();
                const dates = data.dates || [];
                const opts = [`<option value="">查看历史（${this._periodLabel(period)}）…</option>`]
                    .concat(dates.map(d => `<option value="${d}">${d}</option>`));
                this.historySelect.innerHTML = opts.join('');
            } catch (err) {
                console.warn('[report-center] history load failed', err);
            }
        }

        _anchorForPeriod(period, anchor) {
            // For weekly/monthly, server normalizes the anchor. We just send it.
            return anchor || this._todayStr();
        }

        async _generate() {
            const period = this._currentPeriod;
            const date = this._anchorForPeriod(period, this.dateInput.value);
            this._setStatus('正在生成…', 'pending');
            this.btnGenerate.disabled = true;
            try {
                const resp = await fetch(`/api/reports/${period}/generate?date=${encodeURIComponent(date)}`, {
                    method: 'POST',
                });
                const data = await resp.json();
                if (!resp.ok) {
                    this._setStatus('❌ ' + (data.error || '生成失败'), 'error');
                    this._renderError(data.error || '生成失败');
                    return;
                }
                this._currentReport = data.report;
                this._setStatus(`✅ 已保存 ${this._periodLabel(period)} (${data.report.period === 'daily' ? data.report.report_date : this._formatPeriod(data.report.period, data.report.report_date)})`, 'success');
                this._renderReport(data.report);
                await this._refreshHistory();
            } catch (err) {
                this._setStatus('❌ 网络错误：' + err.message, 'error');
                this._renderError('网络错误：' + err.message);
            } finally {
                this.btnGenerate.disabled = false;
            }
        }

        _formatPeriod(period, startDate) {
            // For weekly/monthly show date range using server-provided bounds.
            if (period === 'daily') return startDate;
            // weekly=+6 days; monthly=last day of month
            const d = new Date(startDate + 'T00:00:00');
            if (period === 'weekly') {
                const end = new Date(d.getTime() + 6 * 86400000);
                return `${startDate} ~ ${end.toISOString().slice(0, 10)}`;
            }
            if (period === 'monthly') {
                const year = d.getFullYear();
                const month = d.getMonth() + 1;
                const last = new Date(year, month, 0).getDate();
                return `${startDate} ~ ${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
            }
            return startDate;
        }

        async _loadReport(date) {
            const period = this._currentPeriod;
            this._setStatus('加载中…', 'pending');
            try {
                const resp = await fetch(`/api/reports/${period}/${encodeURIComponent(date)}`);
                const data = await resp.json();
                if (!resp.ok || !data.report) {
                    this._setStatus('该日期暂无已保存的报告', '');
                    this._renderEmpty(date);
                    return;
                }
                this._currentReport = data.report;
                this._setStatus(`✅ 已加载 ${this._periodLabel(period)} (${this._formatPeriod(period, data.report.report_date)})`, 'success');
                this._renderReport(data.report);
            } catch (err) {
                this._setStatus('❌ 网络错误：' + err.message, 'error');
            }
        }

        _renderEmpty(date) {
            if (!this.el) return;
            this.el.innerHTML = `<p class="report-placeholder">${date} 的「${this._periodLabel(this._currentPeriod)}」尚未生成。点击上方"🤖 生成并保存"创建一份。</p>`;
            this.el.classList.remove('hidden');
            if (this.chatEl) this.chatEl.classList.add('hidden');
        }

        _renderError(msg) {
            if (!this.el) return;
            this.el.innerHTML = `<div class="report-center-error">❌ ${this._escape(msg)}</div>`;
            this.el.classList.remove('hidden');
        }

        _renderReport(report) {
            if (!this.el) return;
            // Prefer combined_text (pre-rendered markdown-ish), fall back to
            // structured pieces if the server only stored ai_brief_text.
            const text = report.combined_text
                || (report.ai_brief_text
                    ? `## 🤖 AI 简报\n\n${report.ai_brief_text}`
                    : '');
            const html = this._formatCombinedText(text || '（该报告无内容）');
            this.el.innerHTML = `
                <div class="report-center-meta">
                    <span class="report-center-period-chip">${this._periodLabel(report.period)}</span>
                    <span class="report-center-date-chip">${this._formatPeriod(report.period, report.report_date)}</span>
                </div>
                <div class="report-center-body">${html}</div>
            `;
            this.el.classList.remove('hidden');

            // Chat only meaningful for daily reports.
            if (report.period === 'daily') {
                this._renderChat(report);
                if (this.chatEl) this.chatEl.classList.remove('hidden');
            } else {
                if (this.chatEl) this.chatEl.classList.add('hidden');
            }
        }

        _renderChat(report) {
            if (!this.chatMessagesEl) return;
            const chat = report.chat || [];
            this.chatMessagesEl.innerHTML = chat.map(m => {
                const cls = m.role === 'user' ? 'report-center-msg report-center-msg--user' : 'report-center-msg report-center-msg--ai';
                const icon = m.role === 'user' ? '🧑' : '🤖';
                return `<div class="${cls}"><span class="report-center-msg__icon">${icon}</span><div class="report-center-msg__bubble">${this._escape(m.content || '').replace(/\n/g, '<br>')}</div></div>`;
            }).join('');
            this.chatMessagesEl.scrollTop = this.chatMessagesEl.scrollHeight;
        }

        async _sendChat() {
            if (!this._currentReport || this._currentReport.period !== 'daily') {
                this._setStatus('⚠️ 只能对日报追问，请先选择或生成一份日报', 'warn');
                return;
            }
            const text = (this.chatInput.value || '').trim();
            if (!text) return;
            this.btnChatSend.disabled = true;
            this.chatInput.disabled = true;
            const date = this._currentReport.report_date;
            try {
                const resp = await fetch(`/api/reports/daily/${encodeURIComponent(date)}/chat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: text }),
                });
                const data = await resp.json();
                if (!resp.ok) {
                    this._setStatus('❌ ' + (data.error || '回复失败'), 'error');
                    return;
                }
                this._currentReport = data;
                this._renderChat(data);
                this.chatInput.value = '';
                this._setStatus('✅ 已保存到该日报告', 'success');
            } catch (err) {
                this._setStatus('❌ 网络错误：' + err.message, 'error');
            } finally {
                this.btnChatSend.disabled = false;
                this.chatInput.disabled = false;
                this.chatInput.focus();
            }
        }

        // ── Helpers ──
        _formatCombinedText(text) {
            // Convert headings + paragraphs + bold into HTML. We deliberately
            // avoid pulling in a markdown library to keep this module light.
            const escaped = this._escape(text);
            return escaped
                .replace(/^### (.+)$/gm, '<h4>$1</h4>')
                .replace(/^## (.+)$/gm, '<h3>$1</h3>')
                .replace(/^# (.+)$/gm, '<h2>$1</h2>')
                .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                .replace(/^\s*[-•]\s+(.+)$/gm, '<li>$1</li>')
                .replace(/(?:<li>.*?<\/li>(?:\s*<li>.*?<\/li>)*)/g, m => `<ul>${m}</ul>`)
                .split(/\n\n+/)
                .map(blk => this._wrapBriefBlock(blk))
                .join('\n');
        }

        // Detect structured brief lines and wrap them in card styles.
        // Works line-by-line so it also handles blocks where a heading and
        // brief points are joined by single newlines (no blank line).
        _wrapBriefBlock(blk) {
            const trimmed = blk.trim();
            if (!trimmed) return blk;

            const out = [];
            let plain = [];
            const flushPlain = () => {
                if (plain.length) {
                    out.push(`<p>${plain.join('<br>')}</p>`);
                    plain = [];
                }
            };
            for (const rawLine of trimmed.split('\n')) {
                const l = rawLine.trim();
                if (!l) continue;
                if (/^<(h\d|ul|li|ol)/.test(l)) {
                    flushPlain();
                    out.push(l);
                    continue;
                }
                if (/^(✅|⚠️|🔴)/.test(l) || l.includes('一句话结论')) {
                    flushPlain();
                    out.push(`<div class="brief-conclusion">${l}</div>`);
                } else if (/^(⚖️|🍚|💧|😴|💊|📈|🎯)/.test(l)) {
                    flushPlain();
                    const cls = l.startsWith('🎯')
                        ? 'brief-point brief-point--action'
                        : 'brief-point';
                    out.push(`<div class="${cls}">${l}</div>`);
                } else {
                    plain.push(l);
                }
            }
            flushPlain();
            return out.join('\n');
        }

        _escape(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
    }

    window.ReportCenterManager = ReportCenterManager;
    document.addEventListener('DOMContentLoaded', () => {
        if (document.getElementById('report-center-output')) {
            window.reportCenter = new ReportCenterManager();
        }
    });
})();