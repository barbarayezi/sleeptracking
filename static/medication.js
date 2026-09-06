/**
 * medication.js — Medication/supplement record form, list rendering, one-tap logging.
 *
 * Tracks daily meds + supplements:
 *   - 4 one-tap quick-log buttons for the user's common daily meds
 *   - generic form for any other drug/supplement
 *   - list grouped by administration slot (morning/noon/evening/night)
 *
 * Exposes: MedicationManager class
 */

class MedicationManager {
    constructor() {
        this.form = document.getElementById('medication-form');
        this.btnSave = document.getElementById('btn-medication-save');
        this.btnDelete = document.getElementById('btn-medication-delete');
        this.btnCancel = document.getElementById('btn-medication-cancel');
        this.msgEl = document.getElementById('medication-form-message');
        this.listEl = document.getElementById('medications-list');
        this.daySummaryEl = document.getElementById('medication-day-summary');

        this._selectedDate = this._todayStr();
        this._medicationsForDate = [];   // All meds for the selected date
        this._editingMedicationId = null;
        this._quickfillButtons = Array.from(document.querySelectorAll('.btn-quick-med'));

        this._initEvents();
    }

    /* ── Public API ───────────────────────── */

    /** Load all medication records for a given date (YYYY-MM-DD). */
    async loadDate(dateStr) {
        this._selectedDate = dateStr;
        this._editingMedicationId = null;
        this._resetForm();
        this._updateFormMode();

        try {
            const resp = await fetch(`/api/medications?date=${dateStr}`);
            if (resp.ok) {
                this._medicationsForDate = await resp.json();
            } else {
                this._medicationsForDate = [];
            }
        } catch (err) {
            this._medicationsForDate = [];
            this._showMessage('加载失败: ' + err.message, 'error');
        }

        this._renderList();
        await this._loadDaySummary();
    }

    /* ── Event Wiring ─────────────────────── */

    _initEvents() {
        if (this.form) {
            this.form.addEventListener('submit', (e) => {
                e.preventDefault();
                this._save();
            });
        }
        if (this.btnDelete) {
            this.btnDelete.addEventListener('click', () => this._delete());
        }
        if (this.btnCancel) {
            this.btnCancel.addEventListener('click', () => this._cancelEdit());
        }

        // One-tap quick-log buttons — POST directly, no form edit needed.
        this._quickfillButtons.forEach(btn => {
            btn.addEventListener('click', () => this._quickLog(btn));
        });
    }

    /* ── One-Tap Quick Log ────────────────── */

    /** POST a single med record using the button's data-* attributes. */
    async _quickLog(btn) {
        const slot = (btn.dataset.slot || 'morning').trim();
        // Default intake time per slot so the timestamp on the row matches when
        // the user actually took it (08:00 morning / 20:00 evening / etc.).
        const slotTime = {
            morning: '08:00',
            noon:    '12:00',
            evening: '20:00',
            night:   '22:00',
        };
        const payload = {
            record_date: this._selectedDate,
            record_time: slotTime[slot] || '08:00',
            medication_name: (btn.dataset.name || '').trim(),
            dosage: parseFloat(btn.dataset.dosage || '1') || 1,
            dosage_unit: btn.dataset.unit || '粒',
            category: btn.dataset.category || 'supplement',
            administration_slot: slot,
            notes: '一键打卡',
        };
        if (!payload.medication_name) {
            this._showMessage('按钮缺失药名属性，请刷新页面再试。', 'error');
            return;
        }

        const originalLabel = btn.textContent;
        btn.disabled = true;
        btn.textContent = '⏳ 记录中…';
        try {
            const resp = await fetch('/api/medications', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await resp.json();
            if (!resp.ok) {
                this._showMessage('❌ ' + (data.error || '记录失败'), 'error');
                return;
            }
            this._medicationsForDate.push(data);
            this._renderList();
            await this._loadDaySummary();
            const slotTxt = {morning:'早',noon:'午',evening:'晚',night:'睡前'}[slot] || '早';
            this._showMessage('✅ 已记录 ' + payload.medication_name + '（' + slotTxt + '）', 'success');
        } catch (err) {
            this._showMessage('❌ 网络错误: ' + err.message, 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = originalLabel;
        }
    }

    /* ── Daily Summary (top chips) ────────── */

    async _loadDaySummary() {
        if (!this.daySummaryEl) return;
        try {
            const resp = await fetch(`/api/medications/summary?date=${encodeURIComponent(this._selectedDate)}`);
            if (!resp.ok) {
                this.daySummaryEl.classList.add('hidden');
                return;
            }
            const data = await resp.json();
            this._renderDaySummary(data.summary || {});
        } catch (err) {
            this.daySummaryEl.classList.add('hidden');
        }
    }

    _renderDaySummary(summary) {
        if (!this.daySummaryEl) return;
        const total = (summary.taken_total || 0);
        if (!total) {
            this.daySummaryEl.classList.add('hidden');
            this.daySummaryEl.innerHTML = '';
            return;
        }
        const sup = summary.supplement_taken || 0;
        const adr = summary.antidepressant_taken || 0;
        const oth = summary.other_taken || 0;

        const chips = [];
        if (sup)  chips.push(`<span class="med-summary-chip med-summary-chip--supplement">🍃 保健 ${sup}</span>`);
        if (adr)  chips.push(`<span class="med-summary-chip med-summary-chip--antidepressant">💊 抗抑郁 ${adr}</span>`);
        if (oth)  chips.push(`<span class="med-summary-chip med-summary-chip--other">📦 其他 ${oth}</span>`);
        chips.push(`<span class="med-summary-chip med-summary-chip--total">合计 ${total}</span>`);

        this.daySummaryEl.innerHTML = `
            <div class="summary-title">今日服药打卡 <span class="summary-hint">${this._selectedDate}</span></div>
            <div class="med-summary-chips">${chips.join('')}</div>`;
        this.daySummaryEl.classList.remove('hidden');
    }

    /* ── List Rendering ───────────────────── */

    _renderList() {
        const emptyEl = document.getElementById('medications-empty');

        if (this._medicationsForDate.length === 0) {
            this.listEl.innerHTML = '';
            if (emptyEl) emptyEl.style.display = '';
            return;
        }
        if (emptyEl) emptyEl.style.display = 'none';

        const slotLabels = { morning: '🌅 早上', noon: '☀️ 中午', evening: '🌇 晚上', night: '🌙 睡前' };
        const slotOrder  = ['morning', 'noon', 'evening', 'night'];
        const categoryLabels = { supplement: '🍃 保健类', antidepressant: '💊 抗抑郁药', other: '📦 其他' };
        const categoryColors = {
            supplement:     'var(--success)',
            antidepressant: 'var(--primary)',
            other:          'var(--gray-500)',
        };

        // Group rows by slot, preserving server-side ordering inside each slot.
        const bySlot = { morning: [], noon: [], evening: [], night: [] };
        for (const m of this._medicationsForDate) {
            const slot = m.administration_slot || 'morning';
            (bySlot[slot] || bySlot.morning).push(m);
        }

        let html = '';
        for (const slot of slotOrder) {
            const rows = bySlot[slot];
            if (!rows.length) continue;
            html += `<div class="med-slot-head">${slotLabels[slot]}</div>`;
            for (const m of rows) {
                const isEditing = (this._editingMedicationId === m.id);
                const catLabel = categoryLabels[m.category] || m.category;
                const catColor = categoryColors[m.category] || '#94a3b8';
                const dose = (m.dosage === 1 || m.dosage === 1.0) ? m.dosage_unit
                    : `${m.dosage}${m.dosage_unit}`;

                html += `<div class="record-card medication-card${isEditing ? ' record-card--editing' : ''}">`;
                html += '<div class="record-card__body">';
                html += `<span class="medication-card__cat" style="background:${catColor}1a; color:${catColor}">${catLabel}</span>`;
                html += `<span class="medication-card__name">${this._escapeHtml(m.medication_name)}</span>`;
                html += `<span class="medication-card__dose">${this._escapeHtml(String(dose))}</span>`;
                if (m.record_time && m.record_time !== '08:00') {
                    html += `<span class="medication-card__time">⏰ ${m.record_time}</span>`;
                }
                if (m.notes) {
                    html += `<span class="medication-card__notes">📝 ${this._escapeHtml(m.notes)}</span>`;
                }
                html += '</div>';
                html += '<div class="record-card__actions">';
                if (!isEditing) {
                    html += `<button class="btn-record-edit" data-id="${m.id}" title="编辑">✏️</button>`;
                    html += `<button class="btn-record-delete" data-id="${m.id}" title="删除">🗑️</button>`;
                }
                html += '</div>';
                html += '</div>';
            }
        }
        this.listEl.innerHTML = html;

        this.listEl.querySelectorAll('.btn-record-edit').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = parseInt(e.currentTarget.dataset.id, 10);
                this._edit(id);
            });
        });
        this.listEl.querySelectorAll('.btn-record-delete').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = parseInt(e.currentTarget.dataset.id, 10);
                this._deleteById(id);
            });
        });
    }

    /* ── Edit / Cancel / Form ─────────────── */

    _edit(medId) {
        const med = this._medicationsForDate.find(m => m.id === medId);
        if (!med) return;
        this._editingMedicationId = medId;
        this._populateForm(med);
        this._updateFormMode();
        this._renderList();
    }

    _cancelEdit() {
        this._editingMedicationId = null;
        this._resetForm();
        this._updateFormMode();
        this._renderList();
    }

    _updateFormMode() {
        const isEditing = (this._editingMedicationId !== null);
        if (this.btnSave) this.btnSave.textContent = isEditing ? '💾 更新药物' : '💾 保存药物';
        if (this.btnCancel) this.btnCancel.classList.toggle('hidden', !isEditing);
        if (this.btnDelete) {
            if (isEditing) this.btnDelete.classList.remove('hidden');
            else this.btnDelete.classList.add('hidden');
        }
    }

    _resetForm() {
        if (this.form) this.form.reset();
        this._showMessage('', '');
        // Defaults
        const timeSelect = document.getElementById('medication-time');
        if (timeSelect) timeSelect.value = 'morning';
        const catSelect = document.getElementById('medication-category');
        if (catSelect) catSelect.value = 'supplement';
        const dose = document.getElementById('medication-dosage');
        if (dose) dose.value = '1';
        const unit = document.getElementById('medication-unit');
        if (unit) unit.value = '粒';
        document.getElementById('medication-name').value = '';
        document.getElementById('medication-notes').value = '';
    }

    _populateForm(med) {
        const timeSelect = document.getElementById('medication-time');
        if (timeSelect) timeSelect.value = med.administration_slot || 'morning';
        const catSelect = document.getElementById('medication-category');
        if (catSelect) catSelect.value = med.category || 'supplement';
        document.getElementById('medication-name').value = med.medication_name || '';
        const dose = document.getElementById('medication-dosage');
        if (dose) dose.value = (med.dosage != null) ? String(med.dosage) : '1';
        const unit = document.getElementById('medication-unit');
        if (unit) unit.value = med.dosage_unit || '粒';
        document.getElementById('medication-notes').value = med.notes || '';
    }

    _collectFormData() {
        const timeSelect  = document.getElementById('medication-time');
        const catSelect   = document.getElementById('medication-category');
        const doseInput   = document.getElementById('medication-dosage');
        const unitSelect  = document.getElementById('medication-unit');
        const notesInput  = document.getElementById('medication-notes');
        const nameInput   = document.getElementById('medication-name');

        const doseStr = doseInput ? doseInput.value.trim() : '';
        const dosage = doseStr === '' ? 1 : parseFloat(doseStr);

        return {
            record_date: this._selectedDate,
            record_time: '08:00',  // can be expanded if user wants HH:MM later
            medication_name: (nameInput?.value || '').trim(),
            dosage: Number.isFinite(dosage) ? dosage : 1,
            dosage_unit: unitSelect?.value || '粒',
            category: catSelect?.value || 'supplement',
            administration_slot: timeSelect?.value || 'morning',
            notes: (notesInput?.value || '').trim(),
        };
    }

    _validate(data) {
        const errors = [];
        if (!data.medication_name) errors.push('请填写药名 / 补剂名。');
        if (!data.record_date) errors.push('请选择日期。');
        if (!Number.isFinite(data.dosage) || data.dosage <= 0) {
            errors.push('剂量必须是大于 0 的数字。');
        }
        return errors;
    }

    /* ── Save / Delete ────────────────────── */

    async _save() {
        const data = this._collectFormData();
        const errors = this._validate(data);
        if (errors.length > 0) {
            this._showMessage(errors[0], 'error');
            return;
        }

        if (!this.btnSave) return;
        this.btnSave.disabled = true;
        this.btnSave.textContent = '保存中...';

        try {
            const isUpdate = (this._editingMedicationId !== null);
            const url = isUpdate ? `/api/medications/${this._editingMedicationId}` : '/api/medications';
            const method = isUpdate ? 'PUT' : 'POST';

            const resp = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
            });

            if (resp.ok) {
                const saved = await resp.json();
                this._showMessage(isUpdate ? '✅ 已更新' : '✅ 保存成功！', 'success');

                if (isUpdate) {
                    const idx = this._medicationsForDate.findIndex(m => m.id === saved.id);
                    if (idx >= 0) this._medicationsForDate[idx] = saved;
                } else {
                    this._medicationsForDate.push(saved);
                }

                this._editingMedicationId = null;
                this._resetForm();
                this._updateFormMode();
                this._renderList();
                await this._loadDaySummary();
                if (window.ApiCache) ApiCache.invalidateAll();
            } else {
                const err = await resp.json();
                this._showMessage('❌ ' + (err.error || '保存失败'), 'error');
            }
        } catch (err) {
            this._showMessage('❌ 网络错误: ' + err.message, 'error');
        } finally {
            this.btnSave.disabled = false;
            this.btnSave.textContent = '💾 保存药物';
        }
    }

    async _delete() {
        if (this._editingMedicationId == null) return;
        await this._deleteById(this._editingMedicationId);
    }

    async _deleteById(medId) {
        if (!medId) return;
        if (!confirm('确定要删除这条药物记录吗？')) return;
        try {
            const resp = await fetch(`/api/medications/${medId}`, { method: 'DELETE' });
            if (resp.ok || resp.status === 204) {
                this._medicationsForDate = this._medicationsForDate.filter(m => m.id !== medId);
                if (this._editingMedicationId === medId) {
                    this._editingMedicationId = null;
                    this._resetForm();
                    this._updateFormMode();
                }
                this._renderList();
                await this._loadDaySummary();
                if (window.ApiCache) ApiCache.invalidateAll();
                this._showMessage('已删除。', 'success');
            } else {
                const err = await resp.json();
                this._showMessage('❌ ' + (err.error || '删除失败'), 'error');
            }
        } catch (err) {
            this._showMessage('❌ 网络错误: ' + err.message, 'error');
        }
    }

    _showMessage(text, type) {
        if (!this.msgEl) return;
        this.msgEl.textContent = text;
        this.msgEl.className = 'form-message ' + type;
    }

    /* ── Helpers ──────────────────────────── */

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
