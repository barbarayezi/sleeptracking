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

        // ── Nutrition / AI (v11) ──
        this.btnAi = document.getElementById('btn-meal-ai');
        this.aiMsgEl = document.getElementById('meal-ai-msg');
        this.aiResultEl = document.getElementById('meal-ai-result');
        this.daySummaryEl = document.getElementById('meal-day-summary');
        this.nutriInputs = {
            kcal: document.getElementById('meal-kcal'),
            protein: document.getElementById('meal-protein'),
            fat: document.getElementById('meal-fat'),
            carbs: document.getElementById('meal-carbs'),
            score: document.getElementById('meal-score'),
        };
        this._aiItems = [];          // Item breakdown awaiting save
        this._aiAnalyzedAt = null;   // Timestamp of the accepted estimate

        // ── Image recognition (v11) ──
        this.btnAiImage = document.getElementById('btn-meal-ai-image');
        this.imageInput = document.getElementById('meal-image-input');
        this.imagePreviewEl = document.getElementById('meal-image-preview');
        this.imageThumb = document.getElementById('meal-image-thumb');
        this.btnImageClear = document.getElementById('btn-meal-image-clear');
        this._selectedImageFile = null;

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

        // AI nutrition estimation
        if (this.btnAi) {
            this.btnAi.addEventListener('click', () => this._analyzeMeal());
        }

        // AI image recognition — the button opens the native file picker
        if (this.btnAiImage) {
            this.btnAiImage.addEventListener('click', () => this.imageInput.click());
        }
        if (this.imageInput) {
            this.imageInput.addEventListener('change', (e) => this._onImageSelected(e));
        }
        if (this.btnImageClear) {
            this.btnImageClear.addEventListener('click', () => this._clearImagePreview());
        }

        // Auto-set default time when meal type changes
        const typeRadios = this.form.querySelectorAll('input[name="meal_type"]');
        typeRadios.forEach(radio => {
            radio.addEventListener('change', () => this._setDefaultTime());
        });
    }

    /* ── AI Nutrition Estimation ─────────── */

    /**
     * Ask the backend to estimate nutrition from the meal's text description.
     * Fills the inputs but does NOT save — the user reviews/edits first.
     */
    async _analyzeMeal() {
        const name = (document.getElementById('meal-name').value || '').trim();
        const content = (document.getElementById('meal-content').value || '').trim();

        if (!name && !content) {
            this._showAiMessage('请先填写「餐食名称」或「详细内容」，AI 需要知道吃了什么。', 'error');
            return;
        }

        const typeRadio = this.form.querySelector('input[name="meal_type"]:checked');
        const qtyRadio = this.form.querySelector('input[name="meal_quantity"]:checked');

        const originalLabel = this.btnAi.textContent;
        this.btnAi.disabled = true;
        this.btnAi.textContent = '🤖 估算中…';
        this._showAiMessage('正在分析，约需 5–15 秒…', '');

        try {
            const resp = await fetch('/api/meals/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    meal_name: name,
                    meal_content: content,
                    meal_type: typeRadio ? typeRadio.value : '',
                    meal_quantity: qtyRadio ? qtyRadio.value : 'normal',
                }),
            });

            const data = await resp.json();

            if (!resp.ok) {
                this._showAiMessage('❌ ' + (data.error || '估算失败'), 'error');
                return;
            }

            this._applyAiResult(data);
            this._showAiMessage('✅ 已填入，可手动修改后再保存。', 'success');
        } catch (err) {
            this._showAiMessage('❌ 网络错误：' + err.message, 'error');
        } finally {
            this.btnAi.disabled = false;
            this.btnAi.textContent = originalLabel;
        }
    }

    /** Handle file selection: preview locally, then call the image endpoint. */
    _onImageSelected(e) {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            this._showAiMessage('请选择图片文件。', 'error');
            return;
        }
        if (file.size > 10 * 1024 * 1024) {
            this._showAiMessage('图片过大（上限 10MB）。', 'error');
            return;
        }
        this._selectedImageFile = file;

        // Local preview thumbnail (no upload yet).
        if (this.imageThumb && this.imagePreviewEl) {
            const reader = new FileReader();
            reader.onload = (ev) => {
                this.imageThumb.src = ev.target.result;
                this.imagePreviewEl.classList.remove('hidden');
            };
            reader.readAsDataURL(file);
        }
        this._analyzeMealImage();
    }

    /**
     * Ask the backend to estimate nutrition from a meal photo.
     * Reuses the same fill-in logic as the text path (_applyAiResult).
     */
    async _analyzeMealImage() {
        const file = this._selectedImageFile;
        if (!file) return;

        const typeRadio = this.form.querySelector('input[name="meal_type"]:checked');
        const qtyRadio = this.form.querySelector('input[name="meal_quantity"]:checked');
        const name = (document.getElementById('meal-name').value || '').trim();

        const originalLabel = this.btnAiImage.textContent;
        this.btnAiImage.disabled = true;
        this.btnAiImage.textContent = '📷 分析中…';
        this._showAiMessage('正在分析餐食照片，约需 10–20 秒…', '');

        try {
            const fd = new FormData();
            fd.append('image', file);
            fd.append('meal_name', name);
            fd.append('meal_type', typeRadio ? typeRadio.value : '');
            fd.append('meal_quantity', qtyRadio ? qtyRadio.value : 'normal');

            const resp = await fetch('/api/meals/analyze-image', { method: 'POST', body: fd });
            const data = await resp.json();

            if (!resp.ok) {
                this._showAiMessage('❌ ' + (data.error || '照片分析失败'), 'error');
                return;
            }
            this._applyAiResult(data);
            this._showAiMessage('✅ 已根据图片填入，可手动修改后再保存。', 'success');
        } catch (err) {
            this._showAiMessage('❌ 网络错误：' + err.message, 'error');
        } finally {
            this.btnAiImage.disabled = false;
            this.btnAiImage.textContent = originalLabel;
        }
    }

    /** Remove the selected image and hide the preview. */
    _clearImagePreview() {
        this._selectedImageFile = null;
        if (this.imageInput) this.imageInput.value = '';
        if (this.imageThumb) this.imageThumb.src = '';
        if (this.imagePreviewEl) this.imagePreviewEl.classList.add('hidden');
    }

    /** Write an estimation into the form inputs + result panel. */
    _applyAiResult(data) {
        if (data.kcal !== null && data.kcal !== undefined) {
            this.nutriInputs.kcal.value = data.kcal;
        }
        if (data.protein_g != null) this.nutriInputs.protein.value = data.protein_g;
        if (data.fat_g != null) this.nutriInputs.fat.value = data.fat_g;
        if (data.carbs_g != null) this.nutriInputs.carbs.value = data.carbs_g;
        if (data.score != null) this.nutriInputs.score.value = data.score;

        // Keep the breakdown so it gets persisted on save.
        this._aiItems = Array.isArray(data.items) ? data.items : [];
        this._aiAnalyzedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');

        this._renderAiResult(data);
    }

    /** Render the pros/cons/suggestion panel and the per-item table. */
    _renderAiResult(data) {
        if (!this.aiResultEl) return;

        const setText = (id, text) => {
            const el = document.getElementById(id);
            if (el) el.textContent = text || '—';
        };
        setText('ai-pros-text', data.pros);
        setText('ai-cons-text', data.cons);
        setText('ai-sugg-text', data.suggestion);

        const items = Array.isArray(data.items) ? data.items : [];
        const wrap = document.getElementById('ai-items-wrap');
        const body = document.getElementById('ai-items-body');
        const count = document.getElementById('ai-items-count');

        if (count) count.textContent = items.length ? `(${items.length})` : '';
        if (wrap) wrap.style.display = items.length ? '' : 'none';

        if (body) {
            body.innerHTML = items.map(it => `
                <tr>
                    <td>${this._escapeHtml(it.name || '')}</td>
                    <td>${it.weight_g ?? '—'} g</td>
                    <td>${it.kcal ?? '—'}</td>
                    <td>${it.protein_g ?? '—'}</td>
                    <td>${it.fat_g ?? '—'}</td>
                    <td>${it.carbs_g ?? '—'}</td>
                </tr>`).join('');
        }

        this.aiResultEl.classList.remove('hidden');
    }

    /** Clear the AI panel back to its hidden state. */
    _clearAiResult() {
        this._aiItems = [];
        this._aiAnalyzedAt = null;
        if (this.aiResultEl) this.aiResultEl.classList.add('hidden');
        if (this.aiMsgEl) {
            this.aiMsgEl.textContent = '';
            this.aiMsgEl.className = 'form-message';
        }
    }

    _showAiMessage(text, type) {
        if (!this.aiMsgEl) return;
        this.aiMsgEl.textContent = text;
        this.aiMsgEl.className = 'form-message ' + type;
    }

    /** Read the nutrition inputs; empty string when the user left them blank. */
    _collectNutrition() {
        const num = (input) => {
            const v = input ? input.value.trim() : '';
            if (v === '') return null;
            const f = parseFloat(v);
            return Number.isFinite(f) ? f : null;
        };
        return {
            calorie_kcal: num(this.nutriInputs.kcal),
            protein_g: num(this.nutriInputs.protein),
            fat_g: num(this.nutriInputs.fat),
            carbs_g: num(this.nutriInputs.carbs),
            health_score: num(this.nutriInputs.score),
            items_json: this._aiItems.length ? this._aiItems : null,
            ai_pros: (document.getElementById('ai-pros-text')?.textContent || '').trim(),
            ai_cons: (document.getElementById('ai-cons-text')?.textContent || '').trim(),
            ai_suggestion: (document.getElementById('ai-sugg-text')?.textContent || '').trim(),
            ai_analyzed_at: this._aiAnalyzedAt,
        };
    }

    /** Load + render the daily nutrition totals for the selected date. */
    async _loadDaySummary() {
        if (!this.daySummaryEl) return;

        try {
            const resp = await fetch(`/api/meals/nutrition/summary?date=${this._selectedDate}`);
            if (!resp.ok) return;
            const payload = await resp.json();
            this._renderDaySummary(payload.summary);
        } catch (err) {
            // Summary is decorative — never let it break the meal list.
            this.daySummaryEl.classList.add('hidden');
        }
    }

    _renderDaySummary(s) {
        if (!this.daySummaryEl) return;

        if (!s || !s.meal_count) {
            this.daySummaryEl.classList.add('hidden');
            return;
        }

        // Macro split bar (protein / fat / carbs share of macro calories).
        const bar = (s.protein_pct || s.fat_pct || s.carbs_pct)
            ? `<div class="macro-bar" title="三大营养素供能占比">
                   <span class="macro-seg macro-seg--protein" style="flex:${s.protein_pct}"></span>
                   <span class="macro-seg macro-seg--fat" style="flex:${s.fat_pct}"></span>
                   <span class="macro-seg macro-seg--carbs" style="flex:${s.carbs_pct}"></span>
               </div>
               <div class="macro-legend">
                   <span><i class="macro-dot macro-dot--protein"></i>蛋白 ${s.protein_pct}%</span>
                   <span><i class="macro-dot macro-dot--fat"></i>脂肪 ${s.fat_pct}%</span>
                   <span><i class="macro-dot macro-dot--carbs"></i>碳水 ${s.carbs_pct}%</span>
               </div>`
            : '';

        const score = (s.avg_score !== null && s.avg_score !== undefined)
            ? `<div class="summary-stat"><span class="summary-stat__val">${s.avg_score}</span><span class="summary-stat__label">平均分</span></div>`
            : '';

        this.daySummaryEl.innerHTML = `
            <div class="summary-title">今日营养合计 <span class="summary-hint">${s.meal_count} 餐已记录</span></div>
            <div class="summary-stats">
                <div class="summary-stat"><span class="summary-stat__val">${Math.round(s.kcal)}</span><span class="summary-stat__label">kcal</span></div>
                <div class="summary-stat"><span class="summary-stat__val">${s.protein_g}</span><span class="summary-stat__label">蛋白 g</span></div>
                <div class="summary-stat"><span class="summary-stat__val">${s.fat_g}</span><span class="summary-stat__label">脂肪 g</span></div>
                <div class="summary-stat"><span class="summary-stat__val">${s.carbs_g}</span><span class="summary-stat__label">碳水 g</span></div>
                ${score}
            </div>
            ${bar}`;
        this.daySummaryEl.classList.remove('hidden');
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
            // Nutrition chips (v11) — only when numbers were recorded
            if (m.calorie_kcal !== null && m.calorie_kcal !== undefined) {
                html += `<span class="meal-card__kcal" title="热量">🔥 ${Math.round(m.calorie_kcal)} kcal</span>`;
            }
            if (m.health_score !== null && m.health_score !== undefined) {
                const sc = parseInt(m.health_score, 10);
                const cls = sc >= 8 ? 'good' : (sc >= 6 ? 'average' : 'poor');
                html += `<span class="meal-card__score meal-card__score--${cls}" title="AI 健康分">${sc}/10</span>`;
            }
            if (m.ai_suggestion) {
                html += `<span class="meal-card__ai" title="有 AI 建议">🤖</span>`;
            }
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

        // Clear nutrition inputs + AI panel
        this.nutriInputs.kcal.value = '';
        this.nutriInputs.protein.value = '';
        this.nutriInputs.fat.value = '';
        this.nutriInputs.carbs.value = '';
        this.nutriInputs.score.value = '';
        this._clearAiResult();
        // Drop any staged photo so a reset form starts clean
        if (this._clearImagePreview) this._clearImagePreview();
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

        // ── Nutrition / AI (v11) ──
        this.nutriInputs.kcal.value = meal.calorie_kcal ?? '';
        this.nutriInputs.protein.value = meal.protein_g ?? '';
        this.nutriInputs.fat.value = meal.fat_g ?? '';
        this.nutriInputs.carbs.value = meal.carbs_g ?? '';
        this.nutriInputs.score.value = meal.health_score ?? '';

        // Stored as a JSON string; fall back to [] if absent or corrupt so a
        // single bad row can't break editing.
        let items = [];
        if (meal.items_json) {
            try {
                items = JSON.parse(meal.items_json);
                if (!Array.isArray(items)) items = [];
            } catch (e) {
                items = [];
            }
        }
        this._aiItems = items;
        this._aiAnalyzedAt = meal.ai_analyzed_at || null;

        // Only surface the AI panel when there is something to show.
        const hasAnalysis = meal.ai_pros || meal.ai_cons || meal.ai_suggestion || items.length;
        if (hasAnalysis) {
            this._renderAiResult({
                pros: meal.ai_pros,
                cons: meal.ai_cons,
                suggestion: meal.ai_suggestion,
                items: items,
            });
            this._showAiMessage('', '');
        } else {
            this._clearAiResult();
        }
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
                if (typeof App !== 'undefined' && App._loadToday) App._loadToday();
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
                if (typeof App !== 'undefined' && App._loadToday) App._loadToday();
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
            allergy_reaction: document.getElementById('meal-allergy').value.trim(),
            ...this._collectNutrition()
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