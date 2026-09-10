/**
 * workout.js — 运动打卡（舞蹈课等）：表单、列表、一键打卡 + 图表分析卡。
 *
 * 设计要点：
 *   - 一键打卡默认 60 分钟 / 中等强度，课后点一下即可
 *   - 列表里自动带上同日 Whoop 捕获的 Strain/心率/消耗（后端 /api/workouts 已按日关联）
 *   - WorkoutAnalytics 渲染「图表分析」Tab 的运动统计 + 相关性卡
 *
 * Exposes: WorkoutManager class, window.WorkoutAnalytics
 */

const WORKOUT_TYPE_LABELS = {
    jazz: '💃 Jazz', hiphop: '🕺 Hiphop', kpop: '🎤 K-pop',
    urban: '🌆 Urban', breaking: '🌀 Breaking', other: '🏃 其他',
};
const WORKOUT_TYPE_EMOJI = {
    jazz: '💃', hiphop: '🕺', kpop: '🎤', urban: '🌆', breaking: '🌀', other: '🏃',
};
const WORKOUT_INTENSITY_LABELS = { low: '轻松', medium: '中等', high: '高强度' };

class WorkoutManager {
    constructor() {
        this.form = document.getElementById('workout-form');
        this.btnSave = document.getElementById('btn-workout-save');
        this.btnDelete = document.getElementById('btn-workout-delete');
        this.btnCancel = document.getElementById('btn-workout-cancel');
        this.msgEl = document.getElementById('workout-form-message');
        this.listEl = document.getElementById('workouts-list');
        this.daySummaryEl = document.getElementById('workout-day-summary');

        this._selectedDate = this._todayStr();
        this._workoutsForDate = [];
        this._editingId = null;
        this._quickButtons = Array.from(document.querySelectorAll('.btn-quick-workout'));

        this._initEvents();
    }

    /* ── Public API ───────────────────────── */

    async loadDate(dateStr) {
        this._selectedDate = dateStr;
        this._editingId = null;
        this._resetForm();
        this._updateFormMode();

        const fetcher = window.ApiCache
            ? (url) => window.ApiCache.fetch(url, { ttlMs: 30000 })
            : (url) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))));

        try {
            const records = await fetcher(`/api/workouts?date=${dateStr}`);
            this._workoutsForDate = records || [];
            this._renderList();
            this._renderDaySummary();
        } catch (err) {
            this._workoutsForDate = [];
            this._renderList();
            this._renderDaySummary();
        }
    }

    /* ── Events ───────────────────────────── */

    _initEvents() {
        if (this.form) {
            this.form.addEventListener('submit', (e) => { e.preventDefault(); this._save(); });
        }
        if (this.btnDelete) this.btnDelete.addEventListener('click', () => this._delete());
        if (this.btnCancel) this.btnCancel.addEventListener('click', () => this._cancelEdit());
        this._quickButtons.forEach(btn => btn.addEventListener('click', () => this._quickLog(btn)));
    }

    /* ── One-Tap Quick Log ────────────────── */

    async _quickLog(btn) {
        const payload = {
            workout_date: this._selectedDate,
            workout_type: (btn.dataset.type || 'other').trim(),
            duration_min: parseInt(btn.dataset.duration || '60', 10) || 60,
            intensity: btn.dataset.intensity || 'medium',
            content: '',
            notes: '一键打卡',
        };

        const labels = new Map();
        this._quickButtons.forEach((b) => {
            labels.set(b, b.textContent);
            b.disabled = true;
            if (b === btn) b.textContent = '⏳ 记录中…';
        });

        try {
            const fetchWithTimeout = (window.App && window.App._fetchWithTimeout)
                ? (url, opts, ms) => window.App._fetchWithTimeout(url, opts, ms)
                : (url, opts) => fetch(url, opts);
            const resp = await fetchWithTimeout('/api/workouts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            }, 8000);
            const data = await resp.json();
            if (!resp.ok) {
                this._showMessage('❌ ' + (data.error || '记录失败'), 'error');
                return;
            }
            this._workoutsForDate.push(data);
            this._renderList();
            this._renderDaySummary();
            if (window.ApiCache) {
                window.ApiCache.invalidatePrefix('/api/workouts');
                window.ApiCache.invalidateAll();
            }
            const label = WORKOUT_TYPE_LABELS[payload.workout_type] || payload.workout_type;
            this._showMessage(`✅ 已打卡 ${label} · ${payload.duration_min} 分钟`, 'success');
        } catch (err) {
            this._showMessage('❌ ' + (err.name === 'AbortError' ? '请求超时，请稍后重试' : '网络错误: ' + err.message), 'error');
        } finally {
            this._quickButtons.forEach((b) => { b.disabled = false; b.textContent = labels.get(b); });
        }
    }

    /* ── Day summary chips ────────────────── */

    _renderDaySummary() {
        if (!this.daySummaryEl) return;
        const list = this._workoutsForDate;
        if (!list.length) {
            this.daySummaryEl.classList.add('hidden');
            this.daySummaryEl.innerHTML = '';
            return;
        }
        const totalMin = list.reduce((s, w) => s + (w.duration_min || 0), 0);
        const chips = list.map(w =>
            `<span class="med-summary-chip med-summary-chip--supplement">${WORKOUT_TYPE_EMOJI[w.workout_type] || '🏃'} ${WORKOUT_TYPE_LABELS[w.workout_type] ? WORKOUT_TYPE_LABELS[w.workout_type].split(' ')[1] : w.workout_type} ${w.duration_min}min</span>`);
        chips.push(`<span class="med-summary-chip med-summary-chip--total">合计 ${totalMin} 分钟</span>`);
        this.daySummaryEl.innerHTML = `
            <div class="summary-title">今日运动打卡 <span class="summary-hint">${this._selectedDate}</span></div>
            <div class="med-summary-chips">${chips.join('')}</div>`;
        this.daySummaryEl.classList.remove('hidden');
    }

    /* ── List ─────────────────────────────── */

    _renderList() {
        const emptyEl = document.getElementById('workouts-empty');
        if (!this._workoutsForDate.length) {
            this.listEl.innerHTML = '';
            if (emptyEl) emptyEl.style.display = '';
            return;
        }
        if (emptyEl) emptyEl.style.display = 'none';

        let html = '';
        for (const w of this._workoutsForDate) {
            const isEditing = (this._editingId === w.id);
            const typeLabel = WORKOUT_TYPE_LABELS[w.workout_type] || w.workout_type;
            const intLabel = WORKOUT_INTENSITY_LABELS[w.intensity] || w.intensity;

            html += `<div class="record-card workout-card${isEditing ? ' record-card--editing' : ''}">`;
            html += '<div class="record-card__body">';
            html += `<span class="medication-card__cat" style="background:var(--success-soft); color:var(--success)">${typeLabel}</span>`;
            html += `<span class="medication-card__name">${w.duration_min} 分钟 · ${intLabel}</span>`;
            if (w.content) html += `<span class="medication-card__notes">🎯 ${this._escapeHtml(w.content)}</span>`;
            if (w.notes && w.notes !== '一键打卡') html += `<span class="medication-card__notes">📝 ${this._escapeHtml(w.notes)}</span>`;
            // Whoop 同日自动捕获的生理负荷
            for (const wo of (w.whoop || [])) {
                const bits = [];
                if (wo.sport_name) bits.push(wo.sport_name);
                if (wo.strain != null) bits.push('Strain ' + Number(wo.strain).toFixed(1));
                if (wo.avg_heart_rate != null) bits.push('❤️ ' + wo.avg_heart_rate);
                if (wo.kilojoule != null) bits.push(Math.round(wo.kilojoule / 4.184) + ' kcal');
                if (bits.length) html += `<span class="workout-card__whoop">⌚ ${this._escapeHtml(bits.join(' · '))}</span>`;
            }
            html += '</div>';
            html += '<div class="record-card__actions">';
            if (!isEditing) {
                html += `<button class="btn-record-edit" data-id="${w.id}" title="编辑">✏️</button>`;
                html += `<button class="btn-record-delete" data-id="${w.id}" title="删除">🗑️</button>`;
            }
            html += '</div></div>';
        }
        this.listEl.innerHTML = html;

        this.listEl.querySelectorAll('.btn-record-edit').forEach(btn => {
            btn.addEventListener('click', (e) => this._edit(parseInt(e.currentTarget.dataset.id, 10)));
        });
        this.listEl.querySelectorAll('.btn-record-delete').forEach(btn => {
            btn.addEventListener('click', (e) => this._deleteById(parseInt(e.currentTarget.dataset.id, 10)));
        });
    }

    /* ── Edit / Form ──────────────────────── */

    _edit(id) {
        const w = this._workoutsForDate.find(x => x.id === id);
        if (!w) return;
        this._editingId = id;
        this._populateForm(w);
        this._updateFormMode();
        this._renderList();
    }

    _cancelEdit() {
        this._editingId = null;
        this._resetForm();
        this._updateFormMode();
        this._renderList();
    }

    _updateFormMode() {
        const isEditing = (this._editingId !== null);
        if (this.btnSave) this.btnSave.textContent = isEditing ? '💾 更新运动' : '💾 保存运动';
        if (this.btnCancel) this.btnCancel.classList.toggle('hidden', !isEditing);
        if (this.btnDelete) this.btnDelete.classList.toggle('hidden', !isEditing);
    }

    _resetForm() {
        if (this.form) this.form.reset();
        this._showMessage('', '');
        const type = document.getElementById('workout-type');
        if (type) type.value = 'jazz';
        const dur = document.getElementById('workout-duration');
        if (dur) dur.value = '60';
        const inten = document.getElementById('workout-intensity');
        if (inten) inten.value = 'medium';
        const content = document.getElementById('workout-content');
        if (content) content.value = '';
        const notes = document.getElementById('workout-notes');
        if (notes) notes.value = '';
    }

    _populateForm(w) {
        const type = document.getElementById('workout-type');
        if (type) type.value = w.workout_type || 'jazz';
        const dur = document.getElementById('workout-duration');
        if (dur) dur.value = String(w.duration_min != null ? w.duration_min : 60);
        const inten = document.getElementById('workout-intensity');
        if (inten) inten.value = w.intensity || 'medium';
        document.getElementById('workout-content').value = w.content || '';
        document.getElementById('workout-notes').value = w.notes || '';
    }

    _collectFormData() {
        const durStr = (document.getElementById('workout-duration')?.value || '').trim();
        const dur = durStr === '' ? 60 : parseInt(durStr, 10);
        return {
            workout_date: this._selectedDate,
            workout_type: document.getElementById('workout-type')?.value || 'jazz',
            duration_min: Number.isFinite(dur) ? dur : 60,
            intensity: document.getElementById('workout-intensity')?.value || 'medium',
            content: (document.getElementById('workout-content')?.value || '').trim(),
            notes: (document.getElementById('workout-notes')?.value || '').trim(),
        };
    }

    /* ── Save / Delete ────────────────────── */

    async _save() {
        const data = this._collectFormData();
        if (!data.workout_date) { this._showMessage('请选择日期。', 'error'); return; }
        if (!Number.isFinite(data.duration_min) || data.duration_min < 5 || data.duration_min > 600) {
            this._showMessage('时长必须是 5–600 分钟之间的整数。', 'error');
            return;
        }

        this.btnSave.disabled = true;
        this.btnSave.textContent = '保存中...';
        try {
            const isUpdate = (this._editingId !== null);
            const url = isUpdate ? `/api/workouts/${this._editingId}` : '/api/workouts';
            const resp = await fetch(url, {
                method: isUpdate ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
            });
            if (resp.ok) {
                const saved = await resp.json();
                this._showMessage(isUpdate ? '✅ 已更新' : '✅ 保存成功！', 'success');
                if (isUpdate) {
                    const idx = this._workoutsForDate.findIndex(x => x.id === saved.id);
                    if (idx >= 0) this._workoutsForDate[idx] = saved;
                } else {
                    this._workoutsForDate.push(saved);
                }
                this._editingId = null;
                this._resetForm();
                this._updateFormMode();
                this._renderList();
                this._renderDaySummary();
                if (window.ApiCache) { window.ApiCache.invalidatePrefix('/api/workouts'); window.ApiCache.invalidateAll(); }
            } else {
                const err = await resp.json();
                this._showMessage('❌ ' + (err.error || '保存失败'), 'error');
            }
        } catch (err) {
            this._showMessage('❌ 网络错误: ' + err.message, 'error');
        } finally {
            this.btnSave.disabled = false;
            this.btnSave.textContent = this._editingId !== null ? '💾 更新运动' : '💾 保存运动';
        }
    }

    async _delete() {
        if (this._editingId == null) return;
        await this._deleteById(this._editingId);
    }

    async _deleteById(id) {
        if (!id) return;
        if (!confirm('确定要删除这条运动打卡吗？')) return;
        try {
            const resp = await fetch(`/api/workouts/${id}`, { method: 'DELETE' });
            if (resp.ok || resp.status === 204) {
                this._workoutsForDate = this._workoutsForDate.filter(x => x.id !== id);
                if (this._editingId === id) {
                    this._editingId = null;
                    this._resetForm();
                    this._updateFormMode();
                }
                this._renderList();
                this._renderDaySummary();
                if (window.ApiCache) { window.ApiCache.invalidatePrefix('/api/workouts'); window.ApiCache.invalidateAll(); }
                this._showMessage('已删除。', 'success');
            } else {
                const err = await resp.json();
                this._showMessage('❌ ' + (err.error || '删除失败'), 'error');
            }
        } catch (err) {
            this._showMessage('❌ 网络错误: ' + err.message, 'error');
        }
    }

    /* ── Helpers ──────────────────────────── */

    _showMessage(text, type) {
        if (!this.msgEl) return;
        this.msgEl.textContent = text;
        this.msgEl.className = 'form-message ' + type;
    }

    _todayStr() {
        const d = new Date();
        return d.getFullYear() + '-' +
            String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0');
    }

    _escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text == null ? '' : String(text);
        return div.innerHTML;
    }
}


/* ══════════════════════════════════════════════
 * WorkoutAnalytics —「图表分析」Tab 的运动统计 + 相关性卡
 * 由 App._loadChartsTab() 首进图表 Tab 时触发 load()。
 * ══════════════════════════════════════════════ */
const WorkoutAnalytics = {
    _el: null,

    async load() {
        this._el = document.getElementById('workout-analytics');
        if (!this._el) return;
        const fetcher = window.ApiCache
            ? (url) => ApiCache.fetch(url).catch(() => null)
            : (url) => fetch(url).then(r => r.ok ? r.json() : null).catch(() => null);
        try {
            const [summary, corr] = await Promise.all([
                fetcher('/api/workouts/summary?days=30'),
                fetcher('/api/workout-correlation'),
            ]);
            this._render(summary, corr);
        } catch (e) {
            this._el.innerHTML = '<p class="report-placeholder">运动数据加载失败，稍后可点右上角刷新。</p>';
        }
    },

    _render(summary, corr) {
        if (!summary || !summary.total_sessions) {
            this._el.innerHTML = '<p class="report-placeholder">近 30 天还没有运动打卡。去「✍️ 记录」Tab 点一下 💃/🕺 一键打卡，攒几天数据后这里会出现统计与相关性分析。</p>';
            return;
        }

        // ── 顶部统计 chips ──
        const hours = (summary.total_minutes / 60).toFixed(1);
        const typeBits = Object.entries(summary.by_type || {})
            .map(([t, n]) => `${WORKOUT_TYPE_LABELS[t] || t} ×${n}`).join(' · ');
        const chipsHtml = `<div class="wk-stat-chips">
            <span class="wk-chip"><b>${summary.total_sessions}</b> 次 / 30 天</span>
            <span class="wk-chip"><b>${hours}</b> 小时总时长</span>
            <span class="wk-chip"><b>${summary.this_week_sessions}</b> 次本周（${summary.this_week_minutes} 分钟）</span>
            ${summary.current_streak >= 2 ? `<span class="wk-chip wk-chip--streak">🔥 连续 ${summary.current_streak} 天</span>` : ''}
        </div>
        <div class="wk-type-line">${typeBits}</div>`;

        // ── 近 14 天 mini 柱 ──
        const perDay = summary.per_day || {};
        const days = [];
        const today = new Date();
        for (let i = 13; i >= 0; i--) {
            const d = new Date(today);
            d.setDate(today.getDate() - i);
            days.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'));
        }
        const maxMin = Math.max(60, ...days.map(ds => (perDay[ds] || {}).minutes || 0));
        const barsHtml = days.map(ds => {
            const agg = perDay[ds];
            const mins = agg ? agg.minutes : 0;
            const h = mins ? Math.max(8, Math.round(mins / maxMin * 48)) : 2;
            const emojis = agg ? agg.types.map(t => WORKOUT_TYPE_EMOJI[t] || '🏃').join('') : '';
            const tip = agg ? `${ds} ${emojis} ${mins} 分钟` : `${ds} 无打卡`;
            return `<div class="wk-bar-col" title="${tip}">
                ${agg ? `<div class="wk-bar-emoji">${emojis}</div>` : '<div class="wk-bar-emoji"></div>'}
                <div class="wk-bar ${agg ? 'wk-bar--on' : ''}" style="height:${h}px"></div>
                <div class="wk-bar-date">${parseInt(ds.slice(8), 10)}</div>
            </div>`;
        }).join('');

        // ── 相关性 ──
        let corrHtml = '';
        if (corr && corr.has_data) {
            const w = corr.segments.workout_night, r = corr.segments.rest_night;
            const cmpRow = (label, wv, rv, unit, dec) => {
                const fmt = (v) => v == null ? '—' : (dec ? Number(v).toFixed(dec) : Math.round(v));
                return `<tr><td>${label}</td><td class="wk-num">${fmt(wv)}${unit}</td><td class="wk-num">${fmt(rv)}${unit}</td></tr>`;
            };
            corrHtml = `<div class="wk-corr">
                <div class="wk-corr-title">跳舞当晚 vs 非运动日<small>${corr.pairing_note}</small></div>
                <table class="wk-table">
                    <thead><tr><th></th><th>💃 运动日次日（${w.days}天）</th><th>😌 非运动日（${r.days}天）</th></tr></thead>
                    <tbody>
                        ${cmpRow('睡眠时长', w.sleep_hours_mean, r.sleep_hours_mean, 'h', 1)}
                        ${cmpRow('深睡占比', w.deep_pct_mean, r.deep_pct_mean, '%', 1)}
                        ${cmpRow('恢复分', w.recovery_mean, r.recovery_mean, '', 0)}
                        ${cmpRow('HRV', w.hrv_mean, r.hrv_mean, 'ms', 0)}
                        ${cmpRow('静息心率', w.rhr_mean, r.rhr_mean, 'bpm', 0)}
                    </tbody>
                </table>
                <ul class="wk-notes">${(corr.interpretation || []).map(n => `<li>${n}</li>`).join('')}</ul>
            </div>`;
        } else if (corr && corr.message) {
            corrHtml = `<div class="wk-corr"><div class="wk-corr-title">跳舞当晚 vs 非运动日</div>
                <p class="report-placeholder">${corr.message}</p></div>`;
        }

        this._el.innerHTML = chipsHtml
            + `<div class="wk-bars-title">近 14 天打卡</div><div class="wk-bars">${barsHtml}</div>`
            + corrHtml;
    },
};

window.WorkoutAnalytics = WorkoutAnalytics;
