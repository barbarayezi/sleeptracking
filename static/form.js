/**
 * form.js — Sleep record form handling, conditional logic, validation, and submission.
 * Exposes: FormManager class
 */

class FormManager {
    constructor() {
        this.form = document.getElementById('sleep-form');
        this.btnSave = document.getElementById('btn-save');
        this.btnDelete = document.getElementById('btn-delete');
        this.msgEl = document.getElementById('form-message');
        this.problemsGroup = document.getElementById('sleep-problems-group');

        this._selectedDate = this._todayStr();
        this._existingRecord = null;

        this._initEvents();
    }

    /* ── Public API ───────────────────────── */

    /** Load the record for a given date (YYYY-MM-DD) into the form. */
    async loadDate(dateStr) {
        this._selectedDate = dateStr;
        this._resetForm();
        document.getElementById('record-date').value = dateStr;

        try {
            const resp = await fetch(`/api/records/${dateStr}`);
            if (resp.ok) {
                const record = await resp.json();
                this._existingRecord = record;
                this._populateForm(record);
                this.btnDelete.classList.remove('hidden');
            } else {
                this._existingRecord = null;
                this.btnDelete.classList.add('hidden');
                this._setDefaultTimes();
            }
        } catch (err) {
            this._showMessage('加载失败: ' + err.message, 'error');
        }
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
    }

    /* ── Conditional Logic ────────────────── */

    _handleQualityChange() {
        const selected = this.form.querySelector('input[name="sleep_quality"]:checked');
        if (!selected) return;

        if (selected.value === 'good') {
            this.problemsGroup.style.display = 'none';
            // Clear all problem checkboxes
            this.form.querySelectorAll('input[name="sleep_problems"]')
                .forEach(cb => { cb.checked = false; });
        } else {
            this.problemsGroup.style.display = 'block';
        }
    }

    /* ── Form Population / Reset ──────────── */

    _resetForm() {
        this.form.reset();
        this.problemsGroup.style.display = 'none';
        this._showMessage('', '');
    }

    _setDefaultTimes() {
        // Default: sleep at 23:00, wake at 07:00
        const d = this._selectedDate;
        document.getElementById('sleep-time').value = `${d}T23:00`;
        // Wake time defaults to next day
        const nextDay = this._addDays(d, 1);
        document.getElementById('wake-time').value = `${nextDay}T07:00`;
    }

    _populateForm(record) {
        document.getElementById('record-date').value = record.record_date;

        // Format datetimes for datetime-local input
        document.getElementById('sleep-time').value = this._formatForInput(record.sleep_time);
        document.getElementById('wake-time').value = this._formatForInput(record.wake_time);

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
            const isUpdate = !!this._existingRecord;
            const url = isUpdate ? `/api/records/${data.record_date}` : '/api/records';
            const method = isUpdate ? 'PUT' : 'POST';

            const resp = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });

            if (resp.ok) {
                const saved = await resp.json();
                this._showMessage('✅ 保存成功！', 'success');

                // Notify app to refresh timeline
                if (typeof App !== 'undefined' && App.onRecordSaved) {
                    App.onRecordSaved(saved);
                }

                if (isUpdate) {
                    // Update: keep form populated with updated data
                    this._existingRecord = saved;
                    this.btnDelete.classList.remove('hidden');
                } else {
                    // New record: reset form to blank for next entry
                    this._existingRecord = null;
                    this.btnDelete.classList.add('hidden');
                    this._resetForm();
                    document.getElementById('record-date').value = this._selectedDate;
                    this._setDefaultTimes();
                }
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

    async _deleteRecord() {
        if (!this._existingRecord) return;
        if (!confirm(`确定要删除 ${this._selectedDate} 的睡眠记录吗？`)) return;

        try {
            const resp = await fetch(`/api/records/${this._selectedDate}`, { method: 'DELETE' });
            if (resp.ok || resp.status === 204) {
                this._existingRecord = null;
                this._resetForm();
                document.getElementById('record-date').value = this._selectedDate;
                this._setDefaultTimes();
                this.btnDelete.classList.add('hidden');
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

        return {
            record_date: document.getElementById('record-date').value,
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

        // Validate sleep < wake chronologically
        if (data.sleep_time && data.wake_time) {
            const sleep = new Date(data.sleep_time);
            const wake = new Date(data.wake_time);
            if (wake <= sleep) {
                // Wake is on the next day — that's fine
                // But if wake is more than 24h after sleep, that's suspicious
                const diffMs = wake.getTime() - sleep.getTime() + (24 * 60 * 60 * 1000);
                if (diffMs > 24 * 60 * 60 * 1000) {
                    errors.push('醒来时间与入睡时间相差过大。');
                }
            } else if (wake.getTime() - sleep.getTime() > 24 * 60 * 60 * 1000) {
                errors.push('睡眠时长不能超过24小时。');
            }
        }

        // If quality is average/poor, at least one problem must be checked
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

    /* ── Date Utilities ───────────────────── */

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
        // Convert various datetime formats to "YYYY-MM-DDTHH:MM"
        if (!dtStr) return '';
        // Replace space with T, strip seconds
        let s = dtStr.replace(' ', 'T');
        if (s.length > 16) s = s.substring(0, 16);
        return s;
    }
}