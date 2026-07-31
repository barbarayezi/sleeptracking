/**
 * meal.js — Meal (diet) record form handling, list rendering, and submission.
 * Supports multiple meal records per date (breakfast, lunch, dinner, snack).
 * Exposes: MealManager class
 */

class MealManager {
    constructor() {
        this.form = document.getElementById('meal-form');
        this.btnSave = document.getElementById('btn-meal-save');
        this.btnDelete = document.getElementById('btn-meal-delete');
        this.btnCancel = document.getElementById('btn-meal-cancel');
        this.msgEl = document.getElementById('meal-form-message');
        this.listEl = document.getElementById('meals-list');

        this._selectedDate = this._todayStr();
        this._mealsForDate = [];     // All meals for current date
        this._editingMealId = null;  // ID being edited, null = new record

        this._initEvents();
    }

    /* ── Public API ───────────────────────── */

    /** Load all meal records for a given date (YYYY-MM-DD). */
    async loadDate(dateStr) {
        this._selectedDate = dateStr;
        this._editingMealId = null;
        this._resetForm();
        this._setDefaultTime();
        this._updateFormMode();

        try {
            const resp = await fetch(`/api/meals?date=${dateStr}`);
            if (resp.ok) {
                this._mealsForDate = await resp.json();
            } else {
                this._mealsForDate = [];
            }
        } catch (err) {
            this._mealsForDate = [];
            this._showMessage('加载失败: ' + err.message, 'error');
        }

        this._renderMealList();
    }

    /* ── Event Wiring ─────────────────────── */

    _initEvents() {
        // Form submit
        this.form.addEventListener('submit', (e) => {
            e.preventDefault();
            this._saveMeal();
        });

        // Delete button
        this.btnDelete.addEventListener('click', () => this._deleteMeal());

        // Cancel edit button
        this.btnCancel.addEventListener('click', () => this._cancelEdit());

        // Auto-set default time when meal type changes
        const typeRadios = this.form.querySelectorAll('input[name="meal_type"]');
        typeRadios.forEach(radio => {
            radio.addEventListener('change', () => this._setDefaultTime());
        });
    }

    /* ── Meal List Rendering ──────────────── */

    _renderMealList() {
        const emptyEl = document.getElementById('meals-empty');

        if (this._mealsForDate.length === 0) {
            // Show placeholder, hide empty message
            this.listEl.innerHTML = '';
            if (emptyEl) emptyEl.style.display = '';
            return;
        }

        // Hide empty message, show list
        if (emptyEl) emptyEl.style.display = 'none';

        const typeLabels = {
            breakfast: '🌅 早餐',
            lunch: '☀️ 午餐',
            dinner: '🌇 晚餐',
            snack: '🍪 加餐'
        };
        const quantLabels = { light: '偏少', normal: '正常', heavy: '偏多' };
        const ratingLabels = { good: '健康', average: '一般', poor: '不健康' };
        const ratingColors = { good: 'var(--green)', average: 'var(--yellow)', poor: 'var(--red)' };

        let html = '';
        for (const m of this._mealsForDate) {
            const isEditing = (this._editingMealId === m.id);
            const typeLabel = typeLabels[m.meal_type] || m.meal_type;
            const ratingLabel = ratingLabels[m.health_rating] || m.health_rating;
            const ratingColor = ratingColors[m.health_rating] || '#94a3b8';

            html += `<div class="record-card meal-card${isEditing ? ' record-card--editing' : ''}">`;
            html += '<div class="record-card__body">';
            html += `<span class="record-type-badge meal-type-badge meal-type--${m.meal_type}">${typeLabel}</span>`;
            html += `<span class="record-card__time">${m.meal_time}</span>`;
            if (m.meal_name) {
                html += `<span class="meal-card__name">${this._escapeHtml(m.meal_name)}</span>`;
            }
            html += `<span class="meal-card__quantity">${quantLabels[m.meal_quantity] || m.meal_quantity}</span>`;
            html += `<span class="record-card__quality" style="color:${ratingColor}">● ${ratingLabel}</span>`;
            if (m.allergy_reaction) {
                html += `<span class="meal-card__allergy" title="过敏反应">⚠️ ${this._escapeHtml(m.allergy_reaction)}</span>`;
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
        this.listEl.innerHTML = html;

        // Wire edit buttons
        this.listEl.querySelectorAll('.btn-record-edit').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = parseInt(e.currentTarget.dataset.id);
                this._editMeal(id);
            });
        });

        // Wire delete buttons
        this.listEl.querySelectorAll('.btn-record-delete').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = parseInt(e.currentTarget.dataset.id);
                this._deleteMeal(id);
            });
        });
    }

    /* ── Edit / Cancel ─────────────────────── */

    _editMeal(mealId) {
        const meal = this._mealsForDate.find(m => m.id === mealId);
        if (!meal) return;

        this._editingMealId = mealId;
        this._populateForm(meal);
        this._updateFormMode();
        this._renderMealList();
    }

    _cancelEdit() {
        this._editingMealId = null;
        this._resetForm();
        this._setDefaultTime();
        this._updateFormMode();
        this._renderMealList();
    }

    _updateFormMode() {
        const isEditing = (this._editingMealId !== null);
        this.btnSave.textContent = isEditing ? '💾 更新饮食' : '💾 保存饮食';
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
        // Reset meal_type to default
        const breakfastRadio = this.form.querySelector('input[name="meal_type"][value="breakfast"]');
        if (breakfastRadio) breakfastRadio.checked = true;
        // Reset quantity to normal
        const normalRadio = this.form.querySelector('input[name="meal_quantity"][value="normal"]');
        if (normalRadio) normalRadio.checked = true;
        // Reset health rating to average
        const avgRadio = this.form.querySelector('input[name="meal_health_rating"][value="average"]');
        if (avgRadio) avgRadio.checked = true;
        // Clear text inputs
        document.getElementById('meal-name').value = '';
        document.getElementById('meal-content').value = '';
        document.getElementById('meal-notes').value = '';
        document.getElementById('meal-allergy').value = '';
    }

    _setDefaultTime() {
        const selected = this.form.querySelector('input[name="meal_type"]:checked');
        if (!selected) return;

        const defaults = {
            breakfast: '08:00',
            lunch: '12:00',
            dinner: '18:30',
            snack: '15:00'
        };
        document.getElementById('meal-time').value = defaults[selected.value] || '12:00';
    }

    _populateForm(meal) {
        // Meal type
        const typeRadio = this.form.querySelector(`input[name="meal_type"][value="${meal.meal_type || 'breakfast'}"]`);
        if (typeRadio) typeRadio.checked = true;

        // Meal time
        document.getElementById('meal-time').value = meal.meal_time || '';

        // Meal name
        document.getElementById('meal-name').value = meal.meal_name || '';

        // Meal content
        document.getElementById('meal-content').value = meal.meal_content || '';

        // Meal quantity
        const qtyRadio = this.form.querySelector(`input[name="meal_quantity"][value="${meal.meal_quantity || 'normal'}"]`);
        if (qtyRadio) qtyRadio.checked = true;

        // Health rating
        const ratingRadio = this.form.querySelector(`input[name="meal_health_rating"][value="${meal.health_rating || 'average'}"]`);
        if (ratingRadio) ratingRadio.checked = true;

        // Notes
        document.getElementById('meal-notes').value = meal.notes || '';

        // Allergy reaction
        document.getElementById('meal-allergy').value = meal.allergy_reaction || '';
    }

    /* ── Save / Delete ────────────────────── */

    async _saveMeal() {
        const data = this._collectFormData();
        const errors = this._validate(data);
        if (errors.length > 0) {
            this._showMessage(errors[0], 'error');
            return;
        }

        this.btnSave.disabled = true;
        this.btnSave.textContent = '保存中...';

        try {
            const isUpdate = (this._editingMealId !== null);
            const url = isUpdate ? `/api/meals/${this._editingMealId}` : '/api/meals';
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
                    // Update in-place in the meals list
                    const idx = this._mealsForDate.findIndex(m => m.id === saved.id);
                    if (idx >= 0) this._mealsForDate[idx] = saved;
                } else {
                    this._mealsForDate.push(saved);
                }

                // Reset form for next entry
                this._editingMealId = null;
                this._resetForm();
                this._setDefaultTime();
                this._updateFormMode();
                this._renderMealList();
            } else {
                const err = await resp.json();
                this._showMessage('❌ ' + (err.error || '保存失败'), 'error');
            }
        } catch (err) {
            this._showMessage('❌ 网络错误: ' + err.message, 'error');
        } finally {
            this.btnSave.disabled = false;
            this.btnSave.textContent = '💾 保存饮食';
        }
    }

    async _deleteMeal(mealId) {
        if (!mealId) return;
        if (!confirm('确定要删除这条饮食记录吗？')) return;

        try {
            const resp = await fetch(`/api/meals/${mealId}`, { method: 'DELETE' });
            if (resp.ok || resp.status === 204) {
                this._mealsForDate = this._mealsForDate.filter(m => m.id !== mealId);

                // If we were editing this meal, reset form
                if (this._editingMealId === mealId) {
                    this._editingMealId = null;
                    this._resetForm();
                    this._setDefaultTime();
                    this._updateFormMode();
                }

                this._renderMealList();
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

    _collectFormData() {
        const mealType = this.form.querySelector('input[name="meal_type"]:checked');
        const mealQty = this.form.querySelector('input[name="meal_quantity"]:checked');
        const healthRating = this.form.querySelector('input[name="meal_health_rating"]:checked');

        return {
            meal_date: this._selectedDate,
            meal_type: mealType?.value || 'breakfast',
            meal_time: document.getElementById('meal-time').value,
            meal_name: document.getElementById('meal-name').value.trim(),
            meal_content: document.getElementById('meal-content').value.trim(),
            meal_quantity: mealQty?.value || 'normal',
            health_rating: healthRating?.value || 'average',
            notes: document.getElementById('meal-notes').value.trim(),
            allergy_reaction: document.getElementById('meal-allergy').value.trim()
        };
    }

    _validate(data) {
        const errors = [];
        if (!data.meal_time) errors.push('请选择用餐时间。');
        return errors;
    }

    _showMessage(text, type) {
        this.msgEl.textContent = text;
        this.msgEl.className = 'form-message ' + type;
    }

    /* ── Date & HTML Utilities ────────────── */

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