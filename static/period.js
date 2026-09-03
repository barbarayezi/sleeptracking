/**
 * period.js — Menstrual / period record form handling, list rendering, submission.
 * Tracks period days (flow, symptoms, mood, notes) and period-start markers.
 * Exposes: PeriodManager class
 */

class PeriodManager {
    constructor() {
        this.form = document.getElementById('period-form');
        this.btnSave = document.getElementById('btn-period-save');
        this.btnDelete = document.getElementById('btn-period-delete');
        this.btnCancel = document.getElementById('btn-period-cancel');
        this.msgEl = document.getElementById('period-form-message');
        this.listEl = document.getElementById('periods-list');

        this._selectedDate = this._todayStr();
        this._periodsForDate = [];
        this._editingPeriodId = null;

        this._initEvents();
    }

    /* ── Public API ───────────────────────── */

    async loadDate(dateStr) {
        this._selectedDate = dateStr;
        this._editingPeriodId = null;
        this._resetForm();
        this._updateFormMode();

        try {
            const resp = await fetch(`/api/periods?date=${dateStr}`);
            if (resp.ok) {
                this._periodsForDate = await resp.json();
            } else {
                this._periodsForDate = [];
            }
        } catch (err) {
            this._periodsForDate = [];
            this._showMessage('加载失败: ' + err.message, 'error');
        }

        this._renderPeriodList();
    }

    /* ── Event Wiring ─────────────────────── */

    _initEvents() {
        this.form.addEventListener('submit', (e) => {
            e.preventDefault();
            this._savePeriod();
        });
        this.btnDelete.addEventListener('click', () => this._deletePeriod());
        this.btnCancel.addEventListener('click', () => this._cancelEdit());
    }

    /* ── List Rendering ───────────────────── */

    _renderPeriodList() {
        const emptyEl = document.getElementById('periods-empty');

        if (this._periodsForDate.length === 0) {
            this.listEl.innerHTML = '';
            if (emptyEl) emptyEl.style.display = '';
            return;
        }

        if (emptyEl) emptyEl.style.display = 'none';

        const flowLabels = { none: '无', light: '量少', normal: '量中', heavy: '量多' };
        const flowColors = { none: '#94a3b8', light: '#fb7185', normal: '#f43f5e', heavy: '#dc2626' };
        const symptomNames = {
            cramps: '痛经', headache: '头痛', bloating: '腹胀',
            breast_tender: '胸胀', mood_swings: '情绪波动',
            fatigue: '疲劳', acne: '长痘'
        };
        const moodNames = { good: '心情好', average: '心情一般', low: '心情低落', irritable: '烦躁' };

        let html = '';
        for (const p of this._periodsForDate) {
            const isEditing = (this._editingPeriodId === p.id);
            const flowLabel = flowLabels[p.flow] || p.flow;
            const flowColor = flowColors[p.flow] || '#94a3b8';
            const symptoms = Array.isArray(p.symptoms) ? p.symptoms : [];
            const mood = Array.isArray(p.mood) && p.mood.length ? p.mood[0] : (p.mood || '');

            html += `<div class="record-card period-card${isEditing ? ' record-card--editing' : ''}">`;
            html += '<div class="record-card__body">';
            if (p.is_period_start) {
                html += '<span class="record-type-badge period-type-badge period-type--start">🌸 经期开始</span>';
            }
            html += `<span class="record-card__quality" style="color:${flowColor}">● ${flowLabel}</span>`;
            if (symptoms.length) {
                html += `<span class="period-card__symptoms">${symptoms.map(s => symptomNames[s] || s).join('、')}</span>`;
            }
            if (mood) {
                html += `<span class="period-card__mood">${moodNames[mood] || mood}</span>`;
            }
            if (p.notes) {
                html += `<span class="period-card__notes">📝 ${this._escapeHtml(p.notes)}</span>`;
            }
            html += '</div>';
            html += '<div class="record-card__actions">';
            if (!isEditing) {
                html += `<button class="btn-record-edit" data-id="${p.id}" title="编辑">✏️</button>`;
                html += `<button class="btn-record-delete" data-id="${p.id}" title="删除">🗑️</button>`;
            }
            html += '</div>';
            html += '</div>';
        }
        this.listEl.innerHTML = html;

        this.listEl.querySelectorAll('.btn-record-edit').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = parseInt(e.currentTarget.dataset.id);
                this._editPeriod(id);
            });
        });
        this.listEl.querySelectorAll('.btn-record-delete').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = parseInt(e.currentTarget.dataset.id);
                this._deletePeriod(id);
            });
        });
    }

    /* ── Edit / Cancel ─────────────────────── */

    _editPeriod(periodId) {
        const period = this._periodsForDate.find(p => p.id === periodId);
        if (!period) return;
        this._editingPeriodId = periodId;
        this._populateForm(period);
        this._updateFormMode();
        this._renderPeriodList();
    }

    _cancelEdit() {
        this._editingPeriodId = null;
        this._resetForm();
        this._updateFormMode();
        this._renderPeriodList();
    }

    _updateFormMode() {
        const isEditing = (this._editingPeriodId !== null);
        this.btnSave.textContent = isEditing ? '💾 更新经期' : '💾 保存经期';
        this.btnCancel.classList.toggle('hidden', !isEditing);
        if (isEditing) {
            this.btnDelete.classList.remove('hidden');
        } else {
            this.btnDelete.classList.add('hidden');
        }
    }

    /* ── Form Population / Reset ──────────── */

    _resetForm() {
        this.form.reset();
        this._showMessage('', '');
        const noneRadio = this.form.querySelector('input[name="flow"][value="none"]');
        if (noneRadio) noneRadio.checked = true;
        const avgRadio = this.form.querySelector('input[name="period_mood"][value="average"]');
        if (avgRadio) avgRadio.checked = true;
        document.getElementById('period-notes').value = '';
        document.getElementById('period-start').checked = false;
    }

    _populateForm(period) {
        document.getElementById('period-start').checked = !!period.is_period_start;

        const flowRadio = this.form.querySelector(`input[name="flow"][value="${period.flow || 'none'}"]`);
        if (flowRadio) flowRadio.checked = true;

        const symptoms = Array.isArray(period.symptoms) ? period.symptoms : [];
        this.form.querySelectorAll('input[name="period_symptoms"]').forEach(cb => {
            cb.checked = symptoms.includes(cb.value);
        });

        const mood = Array.isArray(period.mood) && period.mood.length ? period.mood[0] : (period.mood || 'average');
        const moodRadio = this.form.querySelector(`input[name="period_mood"][value="${mood}"]`);
        if (moodRadio) moodRadio.checked = true;

        document.getElementById('period-notes').value = period.notes || '';
    }

    /* ── Save / Delete ────────────────────── */

    async _savePeriod() {
        const data = this._collectFormData();
        const errors = this._validate(data);
        if (errors.length > 0) {
            this._showMessage(errors[0], 'error');
            return;
        }

        this.btnSave.disabled = true;
        this.btnSave.textContent = '保存中...';

        try {
            const isUpdate = (this._editingPeriodId !== null);
            const url = isUpdate ? `/api/periods/${this._editingPeriodId}` : '/api/periods';
            const method = isUpdate ? 'PUT' : 'POST';

            const resp = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });

            if (resp.ok) {
                const saved = await resp.json();
                this._showMessage('✅ 保存成功！', 'success');

                if (isUpdate) {
                    const idx = this._periodsForDate.findIndex(p => p.id === saved.id);
                    if (idx >= 0) this._periodsForDate[idx] = saved;
                } else {
                    this._periodsForDate.push(saved);
                }

                this._editingPeriodId = null;
                this._resetForm();
                this._updateFormMode();
                this._renderPeriodList();

                // Refresh cycle summary + timeline markers
                if (typeof App !== 'undefined' && App.onPeriodSaved) {
                    App.onPeriodSaved();
                }
            } else {
                const err = await resp.json();
                this._showMessage('❌ ' + (err.error || '保存失败'), 'error');
            }
        } catch (err) {
            this._showMessage('❌ 网络错误: ' + err.message, 'error');
        } finally {
            this.btnSave.disabled = false;
            this.btnSave.textContent = '💾 保存经期';
        }
    }

    async _deletePeriod(periodId) {
        if (!periodId) return;
        if (!confirm('确定要删除这条经期记录吗？')) return;

        try {
            const resp = await fetch(`/api/periods/${periodId}`, { method: 'DELETE' });
            if (resp.ok || resp.status === 204) {
                this._periodsForDate = this._periodsForDate.filter(p => p.id !== periodId);
                if (this._editingPeriodId === periodId) {
                    this._editingPeriodId = null;
                    this._resetForm();
                    this._updateFormMode();
                }
                this._renderPeriodList();
                this._showMessage('已删除。', 'success');
                if (typeof App !== 'undefined' && App.onPeriodSaved) {
                    App.onPeriodSaved();
                }
            } else {
                const err = await resp.json();
                this._showMessage('❌ ' + (err.error || '删除失败'), 'error');
            }
        } catch (err) {
            this._showMessage('❌ 网络错误: ' + err.message, 'error');
        }
    }

    /* ── Helpers ──────────────────────────── */

    _collectFormData() {
        const isStart = document.getElementById('period-start').checked;
        const flow = this.form.querySelector('input[name="flow"]:checked')?.value || 'none';
        const symptoms = Array.from(
            this.form.querySelectorAll('input[name="period_symptoms"]:checked')
        ).map(cb => cb.value);
        const mood = this.form.querySelector('input[name="period_mood"]:checked')?.value || 'average';
        const notes = document.getElementById('period-notes').value.trim();

        return {
            record_date: this._selectedDate,
            is_period_start: isStart,
            flow,
            symptoms,
            mood: [mood],
            notes
        };
    }

    _validate(data) {
        const errors = [];
        if (!data.record_date) errors.push('请选择日期。');
        if (data.flow && !['none', 'light', 'normal', 'heavy'].includes(data.flow)) {
            errors.push('流量取值无效。');
        }
        return errors;
    }

    _showMessage(text, type) {
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
        div.textContent = text;
        return div.innerHTML;
    }
}
