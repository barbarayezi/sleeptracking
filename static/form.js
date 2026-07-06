/**
 * form.js — Sleep record form handling, conditional logic, validation, and submission.
 * Supports multiple records per date (night sleep, nap, segmented sleep).
 * Exposes: FormManager class
 */

class FormManager {
    constructor() {
        this.form = document.getElementById('sleep-form');
        this.btnSave = document.getElementById('btn-save');
        this.btnDelete = document.getElementById('btn-delete');
        this.btnCancel = document.getElementById('btn-cancel-edit');
        this.msgEl = document.getElementById('form-message');
        this.problemsGroup = document.getElementById('sleep-problems-group');
        this.recordsListEl = document.getElementById('records-list');

        this._selectedDate = this._todayStr();
        this._recordsForDate = [];     // All records for current date
        this._editingRecordId = null;  // ID being edited, null = new record

        this._initEvents();
    }

    /* ── Public API ───────────────────────── */

    /** Load all records for a given date (YYYY-MM-DD) into the form. */
    async loadDate(dateStr) {
        this._selectedDate = dateStr;
        this._editingRecordId = null;
        this._resetForm();
        document.getElementById('record-date').value = dateStr;
        this._setDefaultTimes();
        this._updateFormMode();

        try {
            const resp = await fetch(`/api/records?date=${dateStr}`);
            if (resp.ok) {
                this._recordsForDate = await resp.json();
            } else {
                this._recordsForDate = [];
            }
        } catch (err) {
            this._recordsForDate = [];
            this._showMessage('加载失败: ' + err.message, 'error');
        }

        this._renderRecordList();
    }

    /** Return the currently selected date. */
    get selectedDate() {
        return this._selectedDate;
    }

    /* ── Event Wiring ─────────────────────── */

    _initEvents() {
        // Conditional: show/hide sleep problems based on quality
        const qualityRadios = this.form.querySelectorAll('input[name="sleep_quality"]');
        qualityRadios.forEach(radio => {
            radio.addEventListener('change', () => this._handleQualityChange());
        });

        // Form submit
        this.form.addEventListener('submit', (e) => {
            e.preventDefault();
            this._saveRecord();
        });

        // Delete button
        this.btnDelete.addEventListener('click', () => this._deleteRecord());

        // Cancel edit button
        this.btnCancel.addEventListener('click', () => this._cancelEdit());
    }

    /* ── Conditional Logic ────────────────── */

    _handleQualityChange() {
        const selected = this.form.querySelector('input[name="sleep_quality"]:checked');
        if (!selected) return;

        if (selected.value === 'good') {
            this.problemsGroup.style.display = 'none';
            this.form.querySelectorAll('input[name="sleep_problems"]')
                .forEach(cb => { cb.checked = false; });
        } else {
            this.problemsGroup.style.display = 'block';
        }
    }

    /* ── Record List Rendering ────────────── */

    _renderRecordList() {
        if (this._recordsForDate.length === 0) {
            this.recordsListEl.classList.add('hidden');
            this.recordsListEl.innerHTML = '';
            return;
        }

        this.recordsListEl.classList.remove('hidden');

        const typeLabels = { night: '🌙 夜间', nap: '☀️ 午睡', segment: '🔄 分段' };
        const qualLabels = { good: '良好', average: '一般', poor: '较差' };
        const qualColors = { good: 'var(--green)', average: 'var(--yellow)', poor: 'var(--red)' };

        let html = '';
        for (const r of this._recordsForDate) {
            const isEditing = (this._editingRecordId === r.id);
            const duration = this._calcDuration(r.sleep_time, r.wake_time);
            const typeLabel = typeLabels[r.record_type] || r.record_type;
            const qualLabel = qualLabels[r.sleep_quality] || r.sleep_quality;
            const qualColor = qualColors[r.sleep_quality] || '#94a3b8';

            html += `<div class="record-card${isEditing ? ' record-card--editing' : ''}">`;
            html += '<div class="record-card__body">';
            html += `<span class="record-type-badge record-type--${r.record_type}">${typeLabel}</span>`;
            html += `<span class="record-card__time">${this._formatTime(r.sleep_time)} → ${this._formatTime(r.wake_time)}</span>`;
            html += `<span class="record-card__duration">${duration.toFixed(1)}h</span>`;
            html += `<span class="record-card__quality" style="color:${qualColor}">● ${qualLabel}</span>`;
            html += '</div>';
            html += '<div class="record-card__actions">';
            if (!isEditing) {
                html += `<button class="btn-record-edit" data-id="${r.id}" title="编辑">✏️</button>`;
                html += `<button class="btn-record-delete" data-id="${r.id}" title="删除">🗑️</button>`;
            }
            html += '</div>';
            html += '</div>';
        }
        this.recordsListEl.innerHTML = html;

        // Wire edit buttons
        this.recordsListEl.querySelectorAll('.btn-record-edit').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = parseInt(e.currentTarget.dataset.id);
                this._editRecord(id);
            });
        });

        // Wire delete buttons
        this.recordsListEl.querySelectorAll('.btn-record-delete').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = parseInt(e.currentTarget.dataset.id);
                this._deleteRecord(id);
            });
        });
    }

    /* ── Edit / Cancel ─────────────────────── */

    _editRecord(recordId) {
        const record = this._recordsForDate.find(r => r.id === recordId);
        if (!record) return;

        this._editingRecordId = recordId;
        this._populateForm(record);
        this._updateFormMode();
        this._renderRecordList();
    }

    _cancelEdit() {
        this._editingRecordId = null;
        this._resetForm();
        document.getElementById('record-date').value = this._selectedDate;
        this._setDefaultTimes();
        this._updateFormMode();
        this._renderRecordList();
    }

    _updateFormMode() {
        const isEditing = (this._editingRecordId !== null);
        this.btnSave.textContent = isEditing ? '💾 更新记录' : '💾 保存记录';
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
        this.problemsGroup.style.display = 'none';
        this._showMessage('', '');
        // Reset record_type to default
        const nightRadio = this.form.querySelector('input[name="record_type"][value="night"]');
        if (nightRadio) nightRadio.checked = true;
    }

    _setDefaultTimes() {
        const d = this._selectedDate;
        document.getElementById('sleep-time').value = `${d}T23:00`;
        const nextDay = this._addDays(d, 1);
        document.getElementById('wake-time').value = `${nextDay}T07:00`;
    }

    _populateForm(record) {
        document.getElementById('record-date').value = record.record_date;

        // Format datetimes for datetime-local input
        document.getElementById('sleep-time').value = this._formatForInput(record.sleep_time);
        document.getElementById('wake-time').value = this._formatForInput(record.wake_time);

        // Record type
        const typeRadio = this.form.querySelector(`input[name="record_type"][value="${record.record_type || 'night'}"]`);
        if (typeRadio) typeRadio.checked = true;

        // Classification
        const clsRadio = this.form.querySelector(`input[name="classification"][value="${record.classification}"]`);
        if (clsRadio) clsRadio.checked = true;

        // Quality
        const qualRadio = this.form.querySelector(`input[name="sleep_quality"][value="${record.sleep_quality}"]`);
        if (qualRadio) qualRadio.checked = true;

        // Sleep problems (conditional)
        if (record.sleep_quality !== 'good' && record.sleep_problems && record.sleep_problems.length > 0) {
            this.problemsGroup.style.display = 'block';
            record.sleep_problems.forEach(p => {
                const cb = this.form.querySelector(`input[name="sleep_problems"][value="${p}"]`);
                if (cb) cb.checked = true;
            });
        } else {
            this.problemsGroup.style.display = 'none';
        }

        // Dream journal
        document.getElementById('dream-journal').value = record.dream_journal || '';
    }

    /* ── Save / Delete ────────────────────── */

    async _saveRecord() {
        const data = this._collectFormData();
        const errors = this._validate(data);
        if (errors.length > 0) {
            this._showMessage(errors[0], 'error');
            return;
        }

        this.btnSave.disabled = true;
        this.btnSave.textContent = '保存中...';

        try {
            const isUpdate = (this._editingRecordId !== null);
            const url = isUpdate ? `/api/records/${this._editingRecordId}` : '/api/records';
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
                    // Update in-place in the records list
                    const idx = this._recordsForDate.findIndex(r => r.id === saved.id);
                    if (idx >= 0) this._recordsForDate[idx] = saved;
                } else {
                    this._recordsForDate.push(saved);
                }

                // Notify app to refresh timeline
                if (typeof App !== 'undefined' && App.onRecordSaved) {
                    App.onRecordSaved(saved);
                }

                // Reset form for next entry
                this._editingRecordId = null;
                this._resetForm();
                document.getElementById('record-date').value = this._selectedDate;
                this._setDefaultTimes();
                this._updateFormMode();
                this._renderRecordList();
            } else {
                const err = await resp.json();
                this._showMessage('❌ ' + (err.error || '保存失败'), 'error');
            }
        } catch (err) {
            this._showMessage('❌ 网络错误: ' + err.message, 'error');
        } finally {
            this.btnSave.disabled = false;
            this.btnSave.textContent = '💾 保存记录';
        }
    }

    async _deleteRecord(recordId) {
        if (!recordId) return;
        if (!confirm('确定要删除这条睡眠记录吗？')) return;

        try {
            const resp = await fetch(`/api/records/${recordId}`, { method: 'DELETE' });
            if (resp.ok || resp.status === 204) {
                this._recordsForDate = this._recordsForDate.filter(r => r.id !== recordId);

                // If we were editing this record, reset form
                if (this._editingRecordId === recordId) {
                    this._editingRecordId = null;
                    this._resetForm();
                    document.getElementById('record-date').value = this._selectedDate;
                    this._setDefaultTimes();
                    this._updateFormMode();
                }

                this._renderRecordList();
                this._showMessage('已删除。', 'success');

                if (typeof App !== 'undefined' && App.onRecordDeleted) {
                    App.onRecordDeleted(this._selectedDate);
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
        const sleepProblems = [];
        this.form.querySelectorAll('input[name="sleep_problems"]:checked')
            .forEach(cb => sleepProblems.push(cb.value));

        const quality = this.form.querySelector('input[name="sleep_quality"]:checked');
        const recordType = this.form.querySelector('input[name="record_type"]:checked');

        return {
            record_date: document.getElementById('record-date').value,
            record_type: recordType?.value || 'night',
            sleep_time: document.getElementById('sleep-time').value,
            wake_time: document.getElementById('wake-time').value,
            classification: this.form.querySelector('input[name="classification"]:checked')?.value || '',
            sleep_quality: quality?.value || '',
            sleep_problems: quality?.value === 'good' ? [] : sleepProblems,
            dream_journal: document.getElementById('dream-journal').value.trim()
        };
    }

    _validate(data) {
        const errors = [];
        if (!data.record_date) errors.push('请选择日期。');
        if (!data.sleep_time) errors.push('请选择入睡时间。');
        if (!data.wake_time) errors.push('请选择醒来时间。');
        if (!data.classification) errors.push('请选择定性（早睡/晚睡）。');
        if (!data.sleep_quality) errors.push('请选择睡眠质量。');

        if (data.sleep_time && data.wake_time) {
            const sleep = new Date(data.sleep_time);
            const wake = new Date(data.wake_time);
            if (wake <= sleep) {
                const diffMs = wake.getTime() - sleep.getTime() + (24 * 60 * 60 * 1000);
                if (diffMs > 24 * 60 * 60 * 1000) {
                    errors.push('醒来时间与入睡时间相差过大。');
                }
            } else if (wake.getTime() - sleep.getTime() > 24 * 60 * 60 * 1000) {
                errors.push('睡眠时长不能超过24小时。');
            }
        }

        if (data.sleep_quality === 'average' || data.sleep_quality === 'poor') {
            if (data.sleep_problems.length === 0) {
                errors.push('请至少选择一个睡眠问题。');
            }
        }

        return errors;
    }

    _showMessage(text, type) {
        this.msgEl.textContent = text;
        this.msgEl.className = 'form-message ' + type;
    }

    /* ── Date & Time Utilities ────────────── */

    _todayStr() {
        const d = new Date();
        return d.getFullYear() + '-' +
            String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0');
    }

    _addDays(dateStr, days) {
        const d = new Date(dateStr + 'T12:00:00');
        d.setDate(d.getDate() + days);
        return d.getFullYear() + '-' +
            String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0');
    }

    _formatForInput(dtStr) {
        if (!dtStr) return '';
        let s = dtStr.replace(' ', 'T');
        if (s.length > 16) s = s.substring(0, 16);
        return s;
    }

    _formatTime(dtStr) {
        const match = dtStr.match(/[T ](\d{2}):(\d{2})/);
        return match ? match[1] + ':' + match[2] : dtStr;
    }

    _calcDuration(sleepTime, wakeTime) {
        const sleep = new Date(sleepTime);
        const wake = new Date(wakeTime);
        let diff = (wake - sleep) / 3600000;
        if (diff <= 0) diff += 24;
        return diff;
    }
}