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
        this.healthMetricsGroup = document.getElementById('health-metrics-group');
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

        // Show/hide weight field based on record type
        const typeRadios = this.form.querySelectorAll('input[name="record_type"]');
        typeRadios.forEach(radio => {
            radio.addEventListener('change', () => this._handleRecordTypeChange());
        });
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

    _handleRecordTypeChange() {
        const selected = this.form.querySelector('input[name="record_type"]:checked');
        if (!selected) return;

        if (selected.value === 'night') {
            this.healthMetricsGroup.style.display = '';
        } else {
            this.healthMetricsGroup.style.display = 'none';
            document.getElementById('weight').value = '';
            document.getElementById('water-cups').value = '';
            document.getElementById('steps').value = '';
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
            if (r.device_score != null) {
                html += `<span class="record-card__device-score" title="手环评分">⌚ ${r.device_score}</span>`;
            }
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
        // Reset health metrics and show group (default is night)
        if (this.healthMetricsGroup) this.healthMetricsGroup.style.display = '';
        const weightInput = document.getElementById('weight');
        if (weightInput) weightInput.value = '';
        const waterInput = document.getElementById('water-cups');
        if (waterInput) waterInput.value = '';
        const stepsInput = document.getElementById('steps');
        if (stepsInput) stepsInput.value = '';
        const deviceScoreInput = document.getElementById('device-score');
        if (deviceScoreInput) deviceScoreInput.value = '';
    }

    _setDefaultTimes() {
        // Default: last night's sleep → wake up today
        // e.g. viewing 2026-07-09 → sleep 2026-07-08T23:00, wake 2026-07-09T07:00
        const wakeDate = this._selectedDate;
        const sleepDate = this._addDays(wakeDate, -1);
        document.getElementById('sleep-time').value = `${sleepDate}T23:00`;
        document.getElementById('wake-time').value = `${wakeDate}T07:00`;
    }

    _populateForm(record) {
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

        // Device score (handicap bracelet)
        document.getElementById('device-score').value = record.device_score != null ? record.device_score : '';

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

        // Health metrics (only show for night records)
        if (record.record_type === 'night') {
            this.healthMetricsGroup.style.display = '';
            document.getElementById('weight').value = record.weight != null ? record.weight : '';
            document.getElementById('water-cups').value = record.water_cups != null ? record.water_cups : '';
            document.getElementById('steps').value = record.steps != null ? record.steps : '';
        } else {
            this.healthMetricsGroup.style.display = 'none';
            document.getElementById('weight').value = '';
            document.getElementById('water-cups').value = '';
            document.getElementById('steps').value = '';
        }
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

        const weightInput = document.getElementById('weight');
        const weightValue = weightInput.value.trim();
        const waterInput = document.getElementById('water-cups');
        const waterValue = waterInput.value.trim();
        const stepsInput = document.getElementById('steps');
        const stepsValue = stepsInput.value.trim();
        const deviceScoreInput = document.getElementById('device-score');
        const deviceScoreValue = deviceScoreInput?.value.trim();
        const wakeTimeVal = document.getElementById('wake-time').value;
        const data = {
            record_date: wakeTimeVal.slice(0, 10),  // derived from wake_time date
            record_type: recordType?.value || 'night',
            sleep_time: document.getElementById('sleep-time').value,
            wake_time: wakeTimeVal,
            classification: this.form.querySelector('input[name="classification"]:checked')?.value || '',
            sleep_quality: quality?.value || '',
            sleep_problems: quality?.value === 'good' ? [] : sleepProblems,
            dream_journal: document.getElementById('dream-journal').value.trim()
        };

        // Device score (handicap bracelet) — available for all record types
        if (deviceScoreValue) data.device_score = parseInt(deviceScoreValue, 10);

        // Health metrics only for night sleep records
        if (recordType?.value === 'night') {
            if (weightValue) data.weight = parseFloat(weightValue);
            if (waterValue) data.water_cups = parseFloat(waterValue);
            if (stepsValue) data.steps = parseInt(stepsValue, 10);
        }

        return data;
    }

    _validate(data) {
        const errors = [];
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