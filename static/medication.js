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
    // 网络异常 / 旧后端时的兜底类别，保证表单依旧可用
    static FALLBACK_CATEGORIES = [
        { id: 0, category_key: 'supplement',     label: '保健类',   emoji: '🍃', color: '#16a34a', sort_order: 0, is_system: 1 },
        { id: 1, category_key: 'antidepressant', label: '抗抑郁药', emoji: '💊', color: '#2563eb', sort_order: 1, is_system: 1 },
        { id: 2, category_key: 'cold',           label: '感冒药',   emoji: '🤧', color: '#0891b2', sort_order: 2, is_system: 1 },
        { id: 3, category_key: 'analgesic',      label: '止痛退烧', emoji: '🤕', color: '#d97706', sort_order: 3, is_system: 1 },
        { id: 4, category_key: 'digestive',      label: '肠胃药',   emoji: '🌿', color: '#4d7c0f', sort_order: 4, is_system: 1 },
        { id: 5, category_key: 'allergy',        label: '抗过敏',   emoji: '🌸', color: '#be185d', sort_order: 5, is_system: 1 },
        { id: 6, category_key: 'sleep_aid',      label: '助眠药',   emoji: '😴', color: '#6d28d9', sort_order: 6, is_system: 1 },
        { id: 7, category_key: 'other',          label: '其他',     emoji: '📦', color: '#64748b', sort_order: 7, is_system: 1 },
    ];

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

        // 类别由后端 /api/medication-categories 提供（可自助新增），首次渲染前加载。
        this._categories = [];
        this._categoriesLoaded = null;   // in-flight promise，避免并发重复拉取
        this.btnAddCat = document.getElementById('btn-add-med-category');
        this.catAddRow = document.getElementById('medication-category-add');
        this.catAddLabel = document.getElementById('medication-category-new-label');
        this.catAddEmoji = document.getElementById('medication-category-new-emoji');
        this.btnCatSave = document.getElementById('btn-med-category-save');
        this.btnCatCancel = document.getElementById('btn-med-category-cancel');

        this._initEvents();
    }

    /* ── Public API ───────────────────────── */

    /** Load all medication records for a given date (YYYY-MM-DD). */
    async loadDate(dateStr) {
        this._selectedDate = dateStr;
        this._editingMedicationId = null;

        // 类别必须在表单默认值与列表渲染之前就绪（标签 / 配色依赖它）。
        await this._ensureCategories();

        this._resetForm();
        this._updateFormMode();

        // 并行拉取列表 + 日汇总，并接入 ApiCache：
        // 切换日期/Tab 时命中缓存即可秒开，改动后由 _save/_delete 调用 invalidateAll() 失效。
        const fetcher = window.ApiCache
            ? (url) => window.ApiCache.fetch(url, { ttlMs: 30000 })
            : (url) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))));

        try {
            const [records, summary] = await Promise.all([
                fetcher(`/api/medications?date=${dateStr}`),
                fetcher(`/api/medications/summary?date=${encodeURIComponent(dateStr)}`),
            ]);
            this._medicationsForDate = records || [];
            this._renderList();
            this._renderDaySummary((summary && summary.summary) || {});
        } catch (err) {
            this._medicationsForDate = [];
            this._renderList();
            this._renderDaySummary({});
            this._showMessage('加载失败: ' + err.message, 'error');
        }
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

        // 自定义类别：展开/收起新增行
        if (this.btnAddCat) {
            this.btnAddCat.addEventListener('click', () => this._toggleCategoryAdder(true));
        }
        if (this.btnCatCancel) {
            this.btnCatCancel.addEventListener('click', () => this._toggleCategoryAdder(false));
        }
        if (this.btnCatSave) {
            this.btnCatSave.addEventListener('click', () => this._createCategory());
        }
        if (this.catAddLabel) {
            this.catAddLabel.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this._createCategory();
                }
            });
        }
    }

    /* ── Category handling ────────────────── */

    /** Load categories once (cached); concurrent callers share one request. */
    _ensureCategories(force = false) {
        if (this._categories.length && !force) return Promise.resolve(this._categories);
        if (this._categoriesLoaded && !force) return this._categoriesLoaded;

        const url = '/api/medication-categories';
        const task = (async () => {
            try {
                const fetcher = window.ApiCache
                    ? (u) => window.ApiCache.fetch(u, { ttlMs: 300000, force })
                    : (u) => fetch(u).then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))));
                const data = await fetcher(url);
                if (Array.isArray(data) && data.length) {
                    this._categories = data;
                }
            } catch (err) {
                // 网络异常时退化为内置兜底，保证表单仍可用
                if (!this._categories.length) this._categories = MedicationManager.FALLBACK_CATEGORIES;
            }
            this._renderCategorySelect();
            this._categoriesLoaded = null;
            return this._categories;
        })();

        this._categoriesLoaded = task;
        return task;
    }

    /** Fill the 类别 dropdown from this._categories. */
    _renderCategorySelect() {
        const sel = document.getElementById('medication-category');
        if (!sel || !this._categories.length) return;
        const previous = sel.value;
        sel.innerHTML = this._categories.map(c =>
            `<option value="${c.category_key}">${c.emoji} ${this._escapeHtml(c.label)}</option>`
        ).join('');
        if (previous && this._categories.some(c => c.category_key === previous)) {
            sel.value = previous;
        } else {
            sel.value = this._defaultCategoryKey();
        }
    }

    /** Default category for a fresh form: 保健类 if present, else the first one. */
    _defaultCategoryKey() {
        const sup = this._categories.find(c => c.category_key === 'supplement');
        return (sup || this._categories[0] || {}).category_key || 'supplement';
    }

    _catByKey(key) {
        return this._categories.find(c => c.category_key === key);
    }

    _catLabel(key) {
        const c = this._catByKey(key);
        return c ? `${c.emoji} ${c.label}` : (key || '其他');
    }

    _catColor(key) {
        const c = this._catByKey(key);
        return c ? c.color : '#64748b';
    }

    /** Render one summary chip. Colour comes from the category row so custom
     *  categories get their own chip style without touching CSS. */
    _chipHtml(count, cat) {
        const emoji = cat.emoji || '📦';
        const label = cat.label || '其他';
        const color = cat.color || '#64748b';
        return `<span class="med-summary-chip" style="background:${color}1a; color:${color}">` +
               `${emoji} ${this._escapeHtml(label)} ${count}</span>`;
    }

    _toggleCategoryAdder(show) {
        if (!this.catAddRow) return;
        this.catAddRow.classList.toggle('hidden', !show);
        if (show && this.catAddLabel) {
            this.catAddLabel.value = '';
            this.catAddLabel.focus();
        }
    }

    /** POST a user-defined category, then refresh the dropdown and select it. */
    async _createCategory() {
        const label = (this.catAddLabel?.value || '').trim();
        if (!label) {
            this._showMessage('请先填写类别名称，例如「感冒药」。', 'error');
            this.catAddLabel?.focus();
            return;
        }
        const emoji = this.catAddEmoji?.value || '📦';
        if (this.btnCatSave) {
            this.btnCatSave.disabled = true;
            this.btnCatSave.textContent = '添加中…';
        }
        try {
            const resp = await fetch('/api/medication-categories', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ label, emoji }),
            });
            const data = await resp.json();
            if (!resp.ok) {
                this._showMessage('❌ ' + (data.error || '新增类别失败'), 'error');
                return;
            }
            if (window.ApiCache) {
                window.ApiCache.invalidatePrefix('/api/medication-categories');
            }
            await this._ensureCategories(true);
            this._toggleCategoryAdder(false);
            const sel = document.getElementById('medication-category');
            if (sel && data && data.category_key) sel.value = data.category_key;
            this._showMessage(`✅ 已新增类别「${data.emoji} ${data.label}」，可直接选择使用`, 'success');
        } catch (err) {
            this._showMessage('❌ 网络错误: ' + err.message, 'error');
        } finally {
            if (this.btnCatSave) {
                this.btnCatSave.disabled = false;
                this.btnCatSave.textContent = '添加';
            }
        }
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
        const labels = new Map();
        // 请求期间禁用全部快速按钮，避免用户连点造成多个 POST 并发、所有按钮都卡在"记录中…"
        this._quickfillButtons.forEach((b) => {
            labels.set(b, b.textContent);
            b.disabled = true;
            if (b === btn) b.textContent = '⏳ 记录中…';
        });

        try {
            const fetchWithTimeout = (window.App && window.App._fetchWithTimeout)
                ? (url, opts, ms) => window.App._fetchWithTimeout(url, opts, ms)
                : (url, opts) => fetch(url, opts);
            const resp = await fetchWithTimeout('/api/medications', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            }, 8000);
            const data = await resp.json();
            if (!resp.ok) {
                this._showMessage('❌ ' + (data.error || '记录失败'), 'error');
                return;
            }
            this._medicationsForDate.push(data);
            this._renderList();
            // 新记录写入后立刻让药物相关缓存失效，保证汇总和列表是最新值
            if (window.ApiCache) {
                window.ApiCache.invalidatePrefix('/api/medications');
            }
            await this._loadDaySummary();
            const slotTxt = {morning:'早',noon:'午',evening:'晚',night:'睡前'}[slot] || '早';
            this._showMessage('✅ 已记录 ' + payload.medication_name + '（' + slotTxt + '）', 'success');
        } catch (err) {
            this._showMessage('❌ ' + (err.name === 'AbortError' ? '请求超时，请稍后重试' : '网络错误: ' + err.message), 'error');
        } finally {
            this._quickfillButtons.forEach((b) => {
                b.disabled = false;
                b.textContent = labels.get(b);
            });
        }
    }

    /* ── Daily Summary (top chips) ────────── */

    async _loadDaySummary() {
        if (!this.daySummaryEl) return;
        const fetcher = window.ApiCache
            ? (url) => window.ApiCache.fetch(url, { ttlMs: 30000 })
            : (url) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))));
        try {
            const data = await fetcher(`/api/medications/summary?date=${encodeURIComponent(this._selectedDate)}`);
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

        // 优先用后端返回的动态分桶；旧后端没有该字段时退回固定三桶。
        let chips = [];
        const byCategory = summary.by_category || null;
        if (byCategory) {
            chips = this._categories
                .filter(c => (byCategory[c.category_key] || 0) > 0)
                .map(c => this._chipHtml(byCategory[c.category_key], c));
            // 未登记进类别表的历史取值也要显示，避免记录"凭空消失"
            Object.keys(byCategory).forEach((key) => {
                if (this._catByKey(key)) return;
                chips.push(this._chipHtml(byCategory[key],
                    { emoji: '📦', label: key, color: '#64748b' }));
            });
        } else {
            const buckets = [
                [summary.supplement_taken,     'supplement'],
                [summary.antidepressant_taken, 'antidepressant'],
                [summary.other_taken,          'other'],
            ];
            chips = buckets
                .filter(([n]) => (n || 0) > 0)
                .map(([n, key]) => this._chipHtml(n, this._catByKey(key) ||
                    { emoji: '📦', label: '其他', color: '#64748b' }));
        }
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
        // 标签与配色统一取自 this._categories（唯一真源，支持用户自定义类别）

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
                const catLabel = this._catLabel(m.category);
                const catColor = this._catColor(m.category);
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
        if (catSelect) catSelect.value = this._defaultCategoryKey();
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
        if (catSelect) {
            const key = med.category || 'supplement';
            catSelect.value = this._catByKey(key) ? key : this._defaultCategoryKey();
        }
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
                if (window.ApiCache) window.ApiCache.invalidatePrefix('/api/medications');
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
                if (window.ApiCache) window.ApiCache.invalidatePrefix('/api/medications');
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
