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

        // ── Image recognition (two-channel: before / after meal) ──
        this.imageInputBefore = document.getElementById('meal-image-before-input');
        this.imageInputAfter = document.getElementById('meal-image-after-input');
        this.imageGridEl = document.getElementById('meal-image-grid');
        this.imageHintEl = document.getElementById('meal-image-hint');
        // Each entry: { file, dataUrl, role: 'before' | 'after' }
        this._imageFiles = [];

        // NOTE: the cross-day AI brief used to live here too, but it duplicated
        // the dedicated "AI 分析" section (same backend, same data, same prompt).
        // It's been removed — see /api/daily-brief and /api/daily-brief/chat in
        // static/agent.js for the canonical implementation.

        // ── 用餐地点 / 制作方式 radio options (v15) ──
        this.locationGroupEl = document.getElementById('meal-location-group');
        this.methodGroupEl = document.getElementById('meal-method-group');
        this._mealOptions = { location: [], method: [] };

        this._selectedDate = this._todayStr();
        this._mealsForDate = [];     // All meals for current date
        this._editingMealId = null;  // ID being edited, null = new record

        this._initEvents();
        this._loadMealOptions();
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

        // AI image recognition — two channels: before-meal and after-meal photos.
        // Using <label for> + visually-hidden inputs so mobile browsers honour
        // the `multiple` attribute reliably.
        if (this.imageInputBefore) {
            this.imageInputBefore.addEventListener('change', (e) => this._onImagesSelected(e, 'before'));
        }
        if (this.imageInputAfter) {
            this.imageInputAfter.addEventListener('change', (e) => this._onImagesSelected(e, 'after'));
        }

        // Paste-to-upload: pasting an image anywhere on the page drops it into
        // the "before" channel (user can re-tag to 餐后 on the thumbnail).
        document.addEventListener('paste', (e) => this._onPaste(e));

        // Auto-set default time when meal type changes
        const typeRadios = this.form.querySelectorAll('input[name="meal_type"]');
        typeRadios.forEach(radio => {
            radio.addEventListener('change', () => this._setDefaultTime());
        });
    }

    /* ── 用餐地点 / 制作方式 options (v15) ─────────── */

    /** Fetch the option lists and render both radio groups. */
    async _loadMealOptions() {
        try {
            const resp = await fetch('/api/meal-options');
            if (!resp.ok) return;
            const data = await resp.json();
            // API returns [{id, value}...]; tolerate legacy plain-string shape.
            const norm = (arr) => (Array.isArray(arr) ? arr : []).map(o =>
                (typeof o === 'string') ? { id: null, value: o } : o);
            this._mealOptions = {
                location: norm(data.location),
                method: norm(data.method),
            };
            this._renderMealOptions();
        } catch (err) {
            // Options are decorative — a failure leaves the groups empty but
            // never breaks the rest of the form.
            console.warn('[meal] options load failed', err);
        }
    }

    /** Render both radio groups from this._mealOptions, preserving selections. */
    _renderMealOptions() {
        const prevLoc = this._checkedValue('dining_location');
        const prevMeth = this._checkedValue('cooking_method');
        this._renderRadioGroup(this.locationGroupEl, 'dining_location', this._mealOptions.location, prevLoc, '地点');
        this._renderRadioGroup(this.methodGroupEl, 'cooking_method', this._mealOptions.method, prevMeth, '方式');
    }

    /**
     * Render one radio group + its "＋ 添加" control. Each option pill gets a
     * "×" delete button so the user can remove options from the page.
     * typeLabel is used in the prompt/confirm dialogs.
     */
    _renderRadioGroup(container, name, values, selected, typeLabel) {
        if (!container) return;
        const valueList = values.map(o => o.value);
        let html = values.map(o => `
            <label class="radio-label meal-option-pill">
                <input type="radio" name="${name}" value="${this._escapeHtml(o.value)}"${o.value === selected ? ' checked' : ''}>
                <span class="radio-custom"></span>
                ${this._escapeHtml(o.value)}
                ${o.id !== null && o.id !== undefined
                    ? `<button type="button" class="meal-option-del" data-id="${o.id}" data-value="${this._escapeHtml(o.value)}" title="删除「${this._escapeHtml(o.value)}」">×</button>`
                    : ''}
            </label>`).join('');
        // Legacy records may hold a value no longer in the option list —
        // keep it selectable so editing doesn't silently drop it.
        if (selected && !valueList.includes(selected)) {
            html += `
            <label class="radio-label">
                <input type="radio" name="${name}" value="${this._escapeHtml(selected)}" checked>
                <span class="radio-custom"></span>
                ${this._escapeHtml(selected)}
            </label>`;
        }
        html += `<button type="button" class="meal-option-add" data-type="${name}" title="添加自定义${typeLabel}">＋ 添加</button>`;
        container.innerHTML = html;

        container.querySelector('.meal-option-add').addEventListener('click', () => {
            this._promptAddOption(name === 'dining_location' ? 'location' : 'method', typeLabel);
        });
        container.querySelectorAll('.meal-option-del').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this._deleteOption(parseInt(e.currentTarget.dataset.id, 10), e.currentTarget.dataset.value);
            });
        });
    }

    /** Delete an option by id (after confirm) and re-render. */
    async _deleteOption(optionId, value) {
        if (!optionId) return;
        if (!confirm(`删除选项「${value}」？\n已保存的历史记录不受影响。`)) return;
        try {
            const resp = await fetch(`/api/meal-options/${optionId}`, { method: 'DELETE' });
            if (resp.ok || resp.status === 204) {
                await this._loadMealOptions();
                this._showMessage(`已删除选项「${value}」`, 'success');
            } else {
                const err = await resp.json().catch(() => ({}));
                this._showMessage('❌ ' + (err.error || '删除失败'), 'error');
            }
        } catch (err) {
            this._showMessage('❌ 网络错误: ' + err.message, 'error');
        }
    }

    /** Ask the user for a custom option and persist it via the API. */
    async _promptAddOption(optionType, typeLabel) {
        const value = (prompt(`添加自定义${typeLabel}（如：${optionType === 'location' ? '奶奶家' : '微波炉'}）`) || '').trim();
        if (!value) return;
        if (value.length > 50) {
            this._showMessage('❌ 选项最长 50 个字符', 'error');
            return;
        }
        try {
            const resp = await fetch('/api/meal-options', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ option_type: optionType, option_value: value }),
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                this._showMessage('❌ ' + (err.error || '添加失败'), 'error');
                return;
            }
            await this._loadMealOptions();
            // Auto-select the freshly added option
            const name = optionType === 'location' ? 'dining_location' : 'cooking_method';
            const radio = this.form.querySelector(`input[name="${name}"][value="${value.replace(/"/g, '&quot;')}"]`);
            if (radio) radio.checked = true;
        } catch (err) {
            this._showMessage('❌ 网络错误: ' + err.message, 'error');
        }
    }

    /** Currently checked value of a radio group, or '' when none. */
    _checkedValue(name) {
        const r = this.form.querySelector(`input[name="${name}"]:checked`);
        return r ? r.value : '';
    }

    /** Check a radio by value; no-op when the value isn't rendered. */
    _checkRadio(name, value) {
        if (!value) return;
        const r = this.form.querySelector(`input[name="${name}"][value="${value.replace(/"/g, '&quot;')}"]`);
        if (r) r.checked = true;
    }

    /**
     * Compose the legacy meal_name string from the two radio groups.
     * Kept so the AI estimate + nutrition prompts keep working unchanged.
     */
    _deriveMealName() {
        return [this._checkedValue('dining_location'), this._checkedValue('cooking_method')]
            .filter(Boolean).join(' · ');
    }

    /* ── AI Nutrition Estimation ─────────── */

    /**
     * Ask the backend to estimate nutrition from the meal's text description.
     * Fills the inputs but does NOT save — the user reviews/edits first.
     *
     * If the user has already selected a meal photo, route the request through
     * the vision path instead of asking for text.
     */
    async _analyzeMeal() {
        const name = this._deriveMealName();
        const content = (document.getElementById('meal-content').value || '').trim();

        // Vision path takes priority when a photo is present.
        if (this._imageFiles.length) {
            this._showAiMessage('检测到已上传照片，将使用照片进行 AI 分析…', '');
            this.btnAi.disabled = true;
            try {
                await this._analyzeMealImages();
            } finally {
                this.btnAi.disabled = false;
            }
            return;
        }

        if (!name && !content) {
            this._showAiMessage('请先选择「用餐地点/制作方式」或填写「详细内容」，AI 需要知道吃了什么；或上传餐食照片直接识别。', 'error');
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

    /** Handle multi-file selection for a given channel (before / after). */
    async _onImagesSelected(e, role) {
        const files = Array.from((e.target.files || []));
        e.target.value = '';  // allow re-selecting to append more
        await this._stageFiles(files, role);
    }

    /** Paste-to-upload: read images from the clipboard into the before channel. */
    _onPaste(e) {
        const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
        const imageItems = items.filter(it => it.kind === 'file' && it.type.startsWith('image/'));
        if (!imageItems.length) return;  // no image on clipboard — let the paste go to wherever

        const files = imageItems.map((it, idx) => {
            const f = it.getAsFile();
            if (!f) return null;
            // Clipboard files have generic names like "image.png"; give each a
            // stable, human-readable name so multipart + preview behave.
            const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
            const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
            return new File([f], `粘贴-${stamp}-${idx + 1}.${ext}`, { type: f.type });
        }).filter(Boolean);
        if (!files.length) return;

        e.preventDefault();  // stop the image also landing in a focused input
        this._stageFiles(files, 'before');
        this._showAiMessage(`📋 已从剪贴板粘贴 ${files.length} 张照片（计入「餐前」，可在缩略图上改）。`, 'success');
    }

    /**
     * Stage image files into the preview grid (shared by file-picker + paste).
     * Validates type/size, generates previews (HEIC via server), re-renders.
     */
    async _stageFiles(files, role) {
        if (!files.length) return;

        const bad = files.filter(f => !f.type.startsWith('image/') && !/\.heic|\.heif/i.test(f.name));
        if (bad.length) {
            this._showAiMessage('请选择图片文件。', 'error');
            return;
        }
        const oversized = files.filter(f => f.size > 10 * 1024 * 1024);
        if (oversized.length) {
            this._showAiMessage('图片过大（上限 10MB）。', 'error');
            return;
        }

        // Stage each new file with the channel's role; for HEIC/HEIF we ask
        // the server to convert to JPEG so non-Safari browsers can preview.
        let pending = files.length;
        const finalize = () => { if (pending === 0) this._renderImageGrid(); };
        for (const file of files) {
            const item = { file, role, dataUrl: '' };
            this._imageFiles.push(item);
            try {
                const dataUrl = await this._previewDataUrl(file);
                item.dataUrl = dataUrl;
            } catch (err) {
                console.warn('[meal] preview failed', err);
                item.dataUrl = '';
            }
            pending -= 1;
            finalize();
        }
        this._renderImageGrid();
    }

    /**
     * Build a browser-displayable data URL for an image file.
     *
     * - HEIC/HEIF: ask the server (which has pillow-heif) to convert to JPEG,
     *   then return its data URL. This is the only way to preview HEIC in
     *   Chrome/Edge/Firefox, which can't decode HEIC natively.
     * - Any other format: just FileReader.readAsDataURL the raw bytes.
     */
    async _previewDataUrl(file) {
        const head = await file.slice(0, 16).arrayBuffer();
        const view = new Uint8Array(head);
        const isHeic = view.length >= 16
            && view[4] === 0x66 && view[5] === 0x74 && view[6] === 0x79 && view[7] === 0x70
            && ['heic', 'heix', 'mif1', 'msf1'].includes(
                String.fromCharCode(view[8], view[9], view[10], view[11]).toLowerCase()
            );
        if (isHeic) {
            const fd = new FormData();
            fd.append('image', file, file.name);
            const resp = await fetch('/api/meals/convert-image', { method: 'POST', body: fd });
            const data = await resp.json();
            if (!resp.ok || !data.data_url) {
                throw new Error(data.error || 'HEIC 预览转换失败');
            }
            return data.data_url;
        }
        // Default: read raw file as data URL (works for JPEG, PNG, WebP, GIF).
        return await new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = (ev) => resolve(ev.target.result);
            r.onerror = () => reject(new Error('读取图片失败'));
            r.readAsDataURL(file);
        });
    }

    /** Render the staged photos as a grid with before/after toggle + remove. */
    _renderImageGrid() {
        if (!this.imageGridEl) return;
        if (!this._imageFiles.length) {
            this.imageGridEl.classList.add('hidden');
            this.imageGridEl.innerHTML = '';
            if (this.imageHintEl) this.imageHintEl.classList.add('hidden');
            return;
        }
        this.imageGridEl.classList.remove('hidden');
        if (this.imageHintEl) this.imageHintEl.classList.remove('hidden');

        this.imageGridEl.innerHTML = this._imageFiles.map((item, idx) => `
            <div class="meal-img-cell" data-idx="${idx}">
                <img class="meal-img-thumb" src="${item.dataUrl}" alt="餐食照片">
                <div class="meal-img-role">
                    <button type="button" class="role-btn ${item.role === 'before' ? 'active' : ''}" data-idx="${idx}" data-role="before">餐前</button>
                    <button type="button" class="role-btn ${item.role === 'after' ? 'active' : ''}" data-idx="${idx}" data-role="after">餐后</button>
                </div>
                <button type="button" class="meal-img-remove" data-idx="${idx}" title="移除">×</button>
            </div>`).join('');

        this.imageGridEl.querySelectorAll('.role-btn').forEach(btn => {
            btn.addEventListener('click', (ev) => {
                const idx = parseInt(ev.currentTarget.dataset.idx, 10);
                const role = ev.currentTarget.dataset.role;
                if (this._imageFiles[idx]) {
                    this._imageFiles[idx].role = role;
                    this._renderImageGrid();
                }
            });
        });
        this.imageGridEl.querySelectorAll('.meal-img-remove').forEach(btn => {
            btn.addEventListener('click', (ev) => {
                const idx = parseInt(ev.currentTarget.dataset.idx, 10);
                this._imageFiles.splice(idx, 1);
                this._renderImageGrid();
            });
        });
    }

    /**
     * Ask the backend to estimate nutrition from staged before/after photos.
     * Reuses the same fill-in logic as the text path (_applyAiResult).
     */
    async _analyzeMealImages() {
        const before = this._imageFiles.filter(i => i.role === 'before').map(i => i.file);
        const after = this._imageFiles.filter(i => i.role === 'after').map(i => i.file);
        if (!before.length && !after.length) return;

        const typeRadio = this.form.querySelector('input[name="meal_type"]:checked');
        const qtyRadio = this.form.querySelector('input[name="meal_quantity"]:checked');
        const name = this._deriveMealName();

        const mode = after.length ? '前后对比' : '仅餐前';
        this._showAiMessage(`正在分析餐食照片（${mode}），约需 15–30 秒…`, '');

        try {
            const fd = new FormData();
            before.forEach(f => fd.append('before', f));
            after.forEach(f => fd.append('after', f));
            fd.append('meal_name', name);
            fd.append('meal_type', typeRadio ? typeRadio.value : '');
            fd.append('meal_quantity', qtyRadio ? qtyRadio.value : 'normal');

            const resp = await fetch('/api/meals/analyze-images', { method: 'POST', body: fd });
            const data = await resp.json();

            if (!resp.ok) {
                this._showAiMessage('❌ ' + (data.error || '照片分析失败'), 'error');
                return;
            }
            this._applyAiResult(data);
            this._showAiMessage('✅ 已根据图片填入，可手动修改后再保存。', 'success');
        } catch (err) {
            this._showAiMessage('❌ 网络错误：' + err.message, 'error');
        }
    }

    /** Remove all staged images and hide the grid. */
    _clearImagePreview() {
        this._imageFiles = [];
        if (this.imageInputBefore) this.imageInputBefore.value = '';
        if (this.imageInputAfter) this.imageInputAfter.value = '';
        this._renderImageGrid();
    }

    /**
     * Open the photo lightbox for a single stored meal image. The viewer is
     * a single shared DOM node (#meal-photo-lightbox) — its content is rebuilt
     * each call. ESC / backdrop click closes; arrow keys / swipe not in scope.
     */
    _openPhotoLightbox(mealId, imgId, role, dim) {
        let lb = document.getElementById('meal-photo-lightbox');
        if (!lb) {
            lb = document.createElement('div');
            lb.id = 'meal-photo-lightbox';
            lb.className = 'meal-lightbox hidden';
            lb.setAttribute('role', 'dialog');
            lb.innerHTML = `
                <div class="meal-lightbox__backdrop"></div>
                <div class="meal-lightbox__panel">
                    <button type="button" class="meal-lightbox__close" aria-label="关闭">×</button>
                    <img class="meal-lightbox__img" alt="餐食照片">
                    <div class="meal-lightbox__caption"></div>
                </div>
            `;
            document.body.appendChild(lb);
            const close = () => lb.classList.add('hidden');
            lb.querySelector('.meal-lightbox__backdrop').addEventListener('click', close);
            lb.querySelector('.meal-lightbox__close').addEventListener('click', close);
            document.addEventListener('keydown', (ev) => {
                if (ev.key === 'Escape' && !lb.classList.contains('hidden')) close();
            });
        }
        const imgEl = lb.querySelector('.meal-lightbox__img');
        const capEl = lb.querySelector('.meal-lightbox__caption');
        const src = `/api/meals/${mealId}/images/${imgId}?format=jpeg`;
        imgEl.src = src;
        capEl.textContent = `餐食照片 · ${role || ''}${dim ? ' · ' + dim : ''}`;
        lb.classList.remove('hidden');
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

        // Vision path also gives us a natural-language description of the meal.
        // Fill it in only when the detail box is empty, so we never overwrite
        // something the user already typed.
        if (data.meal_content) {
            const contentEl = document.getElementById('meal-content');
            if (contentEl && !(contentEl.value || '').trim()) {
                contentEl.value = data.meal_content;
            }
        }

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
            if (m.dining_location) {
                html += `<span class="meal-card__tag" title="用餐地点">📍 ${this._escapeHtml(m.dining_location)}</span>`;
            }
            if (m.cooking_method) {
                html += `<span class="meal-card__tag" title="制作方式">🍳 ${this._escapeHtml(m.cooking_method)}</span>`;
            }
            if (m.meal_name && !m.dining_location && !m.cooking_method) {
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

            // Photo strip (v13): show persistent thumbnails; click to enlarge.
            if (Array.isArray(m.images) && m.images.length) {
                html += '<div class="meal-card__photos">';
                for (const im of m.images) {
                    const w = im.width || '';
                    const h = im.height || '';
                    const dim = (w && h) ? `${w}×${h}` : '';
                    const role = im.role === 'after' ? '餐后' : '餐前';
                    // Always request ?format=jpeg so non-Safari browsers can
                    // render HEIC uploads via the server-side conversion path.
                    html += `<button type="button" class="meal-card__photo" `
                         + `data-meal="${m.id}" data-img="${im.id}" `
                         + `data-role="${role}" data-dim="${dim}" `
                         + `title="餐食照片 · ${role}${dim ? ' · ' + dim : ''}">`
                         + `<img src="/api/meals/${m.id}/images/${im.id}?format=jpeg" `
                         + `loading="lazy" alt="餐食照片">`
                         + `<span class="meal-card__photo-role">${role}</span>`
                         + `</button>`;
                }
                html += '</div>';
            }

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

        // Wire photo thumbnails → lightbox viewer
        this.listEl.querySelectorAll('.meal-card__photo').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const mealId = e.currentTarget.dataset.meal;
                const imgId = e.currentTarget.dataset.img;
                const role = e.currentTarget.dataset.role || '';
                const dim = e.currentTarget.dataset.dim || '';
                this._openPhotoLightbox(mealId, imgId, role, dim);
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
        // Clear 用餐地点/制作方式 selections (v15 radio groups)
        this.form.querySelectorAll('input[name="dining_location"]:checked, input[name="cooking_method"]:checked')
            .forEach(r => { r.checked = false; });
        // Clear text inputs
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

        // 用餐地点 / 制作方式 (v15) — a stored value missing from the current
        // option list is re-rendered as a legacy option so it isn't dropped.
        if (meal.dining_location && !this._mealOptions.location.includes(meal.dining_location)) {
            this._renderRadioGroup(this.locationGroupEl, 'dining_location',
                this._mealOptions.location, meal.dining_location, '地点');
        } else {
            this._checkRadio('dining_location', meal.dining_location);
        }
        if (meal.cooking_method && !this._mealOptions.method.includes(meal.cooking_method)) {
            this._renderRadioGroup(this.methodGroupEl, 'cooking_method',
                this._mealOptions.method, meal.cooking_method, '方式');
        } else {
            this._checkRadio('cooking_method', meal.cooking_method);
        }

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

        const isUpdate = (this._editingMealId !== null);
        const url = isUpdate ? `/api/meals/${this._editingMealId}` : '/api/meals';
        const method = isUpdate ? 'PUT' : 'POST';

        const hasImages = this._imageFiles.length > 0;
        const fetchOpts = { method };
        try {
            if (hasImages) {
                // multipart: payload JSON + before/after image files.
                const fd = new FormData();
                fd.append('payload', JSON.stringify(data));
                for (const item of this._imageFiles) {
                    fd.append(item.role || 'before', item.file, item.file.name || 'photo.jpg');
                }
                fetchOpts.body = fd;
            } else {
                fetchOpts.headers = { 'Content-Type': 'application/json' };
                fetchOpts.body = JSON.stringify(data);
            }

            const resp = await fetch(url, fetchOpts);

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

        const location = this._checkedValue('dining_location');
        const method = this._checkedValue('cooking_method');

        return {
            meal_date: this._selectedDate,
            meal_type: mealType?.value || 'breakfast',
            meal_time: document.getElementById('meal-time').value,
            // meal_name is derived from the two radio groups so the AI
            // estimate / nutrition prompt pipelines keep working unchanged.
            meal_name: [location, method].filter(Boolean).join(' · '),
            dining_location: location,
            cooking_method: method,
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