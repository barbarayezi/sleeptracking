/**
 * timeline.js — Canvas 睡眠总览（重设计版）
 *
 * 上区：每晚睡眠结构堆叠柱（Whoop 分期：深睡 / REM / 浅睡 / 清醒）
 * 下区：入睡×醒来节律双线图（连点成线看作息稳定性）
 *
 * 设计原则：一图一问。餐食 / 经期 / 恢复分 / 步数已移出本图。
 * Exposes: Timeline class（公开接口与旧版一致，app.js 无需改动）
 */

class Timeline {
    constructor(canvasId, emptyId) {
        this.canvas = document.getElementById(canvasId);
        this.emptyEl = document.getElementById(emptyId);
        this.ctx = this.canvas.getContext('2d');
        this.records = [];
        this._grouped = {};
        this.daysToShow = 14;

        // ── Layout ──
        this.PAD_LEFT = 46;
        this.PAD_RIGHT = 10;
        this.TITLE_A_Y = 22;
        this.A_PLOT_TOP = 38;
        this.A_PLOT_H = 158;            // 上区绘图区高度
        this.A_MIN_HOURS = 8;           // 量程下限（数据小也不至于顶满）
        this.A_CAP_HOURS = 16;          // 量程上限（防极端错误数据撑爆布局）
        this.LEGEND_Y = 222;
        this.TITLE_B_Y = 246;
        this.B_PLOT_TOP = 258;
        this.B_PLOT_H = 128;            // 20:00 → 次日 12:00（16h 窗口）
        this.B_START_HOUR = 20;
        this.B_SPAN_MIN = 16 * 60;
        this.DATES_GAP = 16;

        // ── Colors ──
        this.stageColors = { deep: '#3C3489', rem: '#7F77DD', light: '#CECBF6', awake: '#FAC775' };
        this.qualityColors = { good: '#16a34a', average: '#d97706', poor: '#dc2626' };
        this.noQualityColor = '#94a3b8';
        this.napColor = '#cbd5e1';
        this.onsetColor = '#185FA5';
        this.wakeColor = '#D85A30';
        this.gridColor = '#e8e6df';
        this.axisTextColor = '#94a3b8';

        this._hitRegions = [];
        this._initInteraction();
    }

    /* ── Public API（保持与 app.js 的契约） ── */

    setDays(days) {
        this.daysToShow = days;
        this.render();
    }

    setRecords(records) {
        this.records = records || [];
        this._groupByDate();
        this.render();
    }

    // 重设计后这些维度不再绘制在本图上，保留空接口防止 app.js 调用报错
    setMeals() {}
    setPeriods() {}
    setCycleInfo() {}
    setDailyMetrics() {}
    setSteps() {}

    /* ── Data helpers ── */

    _groupByDate() {
        // 按"醒来日期"归组：23:00 → 次日 07:00 的睡眠属于醒来那天
        this._grouped = {};
        for (const r of this.records) {
            const displayDate = this._extractDate(r.wake_time) || r.record_date;
            if (!displayDate) continue;
            if (!this._grouped[displayDate]) this._grouped[displayDate] = [];
            this._grouped[displayDate].push(r);
        }
    }

    _extractDate(dtStr) {
        if (!dtStr) return null;
        const m = String(dtStr).match(/^(\d{4}-\d{2}-\d{2})/);
        return m ? m[1] : null;
    }

    _todayStr() {
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }

    _addDays(dateStr, days) {
        const d = new Date(dateStr + 'T12:00:00');
        d.setDate(d.getDate() + days);
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }

    _parseTime(dtStr) {
        const m = String(dtStr || '').match(/[T ](\d{2}):(\d{2})/);
        if (!m) return null;
        return { hour: parseInt(m[1]), minute: parseInt(m[2]) };
    }

    /** 在床时长（分钟），跨天自动 +1440。 */
    _durationMin(r) {
        const t1 = this._parseTime(r.sleep_time);
        const t2 = this._parseTime(r.wake_time);
        if (!t1 || !t2) return 0;
        let start = t1.hour * 60 + t1.minute;
        let end = t2.hour * 60 + t2.minute;
        if (end <= start) end += 1440;
        return end - start;
    }

    _hasStages(r) {
        return ((r.deep_sleep_minutes || 0) + (r.light_sleep_minutes || 0) + (r.rem_sleep_minutes || 0)) > 0;
    }

    /** 每天选一条主记录：优先有 Whoop 分期的夜睡，其次最长夜睡，都没有才用最长的午睡。 */
    _pickPrimary(dayRecords) {
        const nights = dayRecords.filter(r => r.record_type !== 'nap');
        if (nights.length) {
            const staged = nights.find(r => this._hasStages(r));
            if (staged) return staged;
            return nights.slice().sort((a, b) => this._durationMin(b) - this._durationMin(a))[0];
        }
        const naps = dayRecords.filter(r => r.record_type === 'nap');
        if (naps.length) return naps.slice().sort((a, b) => this._durationMin(b) - this._durationMin(a))[0];
        return null;
    }

    /* ── Render ── */

    render() {
        const today = this._todayStr();
        const dates = [];
        for (let i = this.daysToShow - 1; i >= 0; i--) dates.push(this._addDays(today, -i)); // 旧 → 新

        const hasAny = dates.some(d => (this._grouped[d] || []).length > 0);
        if (!hasAny) {
            this.emptyEl.classList.remove('hidden');
            this.canvas.classList.add('hidden');
            return;
        }
        this.emptyEl.classList.add('hidden');
        this.canvas.classList.remove('hidden');

        const W = this.canvas.parentElement.clientWidth;
        const datesY = this.B_PLOT_TOP + this.B_PLOT_H + this.DATES_GAP;
        const totalH = datesY + 8;

        this.canvas.width = W * window.devicePixelRatio;
        this.canvas.height = totalH * window.devicePixelRatio;
        this.canvas.style.width = W + 'px';
        this.canvas.style.height = totalH + 'px';
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

        const ctx = this.ctx;
        ctx.clearRect(0, 0, W, totalH);

        const plotW = W - this.PAD_LEFT - this.PAD_RIGHT;
        const n = dates.length;
        const pitch = plotW / n;
        const colW = Math.min(30, pitch * 0.62);
        const cx = (i) => this.PAD_LEFT + pitch * (i + 0.5);

        this._hitRegions = [];
        // 整列热区（上区柱 + 下区节律都覆盖），点击任意处跳转该日
        for (let i = 0; i < n; i++) {
            this._hitRegions.push({
                x: cx(i) - pitch / 2,
                y: this.A_PLOT_TOP - 8,
                w: pitch,
                h: (this.B_PLOT_TOP + this.B_PLOT_H) - this.A_PLOT_TOP + 16,
                date: dates[i]
            });
        }

        this._drawSectionA(ctx, dates, cx, pitch, colW, W);
        this._drawLegend(ctx);
        this._drawSectionB(ctx, dates, cx, W);
        this._drawDateLabels(ctx, dates, cx, pitch, datesY, today);
    }

    /* ── Section A：睡眠结构柱 ── */

    _drawSectionA(ctx, dates, cx, pitch, colW, W) {
        const top = this.A_PLOT_TOP;
        const plotH = this.A_PLOT_H;
        const base = top + plotH;

        // 自适应量程：取本窗口最大在床时长，向上取整到 2h 倍数；下限 8h、上限 16h。
        // 诚实显示完整柱，不截断——有 14h 那周量程就放 14h，正常柱略矮但对比关系不变。
        let dataMax = 0;
        for (const date of dates) {
            const p = this._pickPrimary(this._grouped[date] || []);
            if (p) dataMax = Math.max(dataMax, this._durationMin(p) / 60);
        }
        const maxH = Math.min(this.A_CAP_HOURS,
            Math.max(this.A_MIN_HOURS, Math.ceil(dataMax / 2) * 2));
        const pxH = plotH / maxH;

        ctx.textAlign = 'left';
        ctx.font = '500 13px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
        ctx.fillStyle = '#0f172a';
        ctx.fillText('每天睡多少 · 结构怎么样', this.PAD_LEFT, this.TITLE_A_Y);

        // 横网格线 + 小时刻度
        ctx.font = '11px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'right';
        for (let h = 0; h <= maxH; h += 2) {
            const y = base - h * pxH;
            ctx.strokeStyle = h === 0 ? '#B4B2A9' : this.gridColor;
            ctx.lineWidth = h === 0 ? 1 : 0.5;
            ctx.beginPath();
            ctx.moveTo(this.PAD_LEFT, y);
            ctx.lineTo(W - this.PAD_RIGHT, y);
            ctx.stroke();
            ctx.fillStyle = this.axisTextColor;
            ctx.fillText(h === 0 ? '0' : h + 'h', this.PAD_LEFT - 6, y + 4);
        }

        dates.forEach((date, i) => {
            const dayRecs = this._grouped[date] || [];
            const primary = this._pickPrimary(dayRecs);
            if (!primary) return;

            const x = cx(i) - colW / 2;
            const hours = this._durationMin(primary) / 60;
            const colH = hours * pxH;
            const colTop = base - colH;

            if (this._hasStages(primary)) {
                // Whoop 分期堆叠（底 → 顶：深睡 / REM / 浅睡 / 清醒）
                const stages = [
                    ['deep', primary.deep_sleep_minutes || 0],
                    ['rem', primary.rem_sleep_minutes || 0],
                    ['light', primary.light_sleep_minutes || 0],
                    ['awake', primary.awake_minutes || 0]
                ];
                const totalMin = stages.reduce((s, [, m]) => s + m, 0) || 1;
                let yCursor = base;
                for (const [key, mins] of stages) {
                    if (mins <= 0) continue;
                    const segH = (mins / totalMin) * colH;
                    yCursor -= segH;
                    ctx.fillStyle = this.stageColors[key];
                    ctx.fillRect(x, yCursor, colW, segH + 0.5); // +0.5 消段间缝隙
                }
            } else {
                // 无分期（手动记录）：整柱质量色；纯午睡日降透明度提示"这不是夜睡"
                ctx.fillStyle = this.qualityColors[primary.sleep_quality] || this.noQualityColor;
                ctx.globalAlpha = primary.record_type === 'nap' ? 0.4 : 0.92;
                ctx.fillRect(x, colTop, colW, colH);
                ctx.globalAlpha = 1.0;
            }

            // 质量点：柱够高放柱内顶部，太矮放柱顶左上
            const qc = this.qualityColors[primary.sleep_quality];
            if (qc) {
                ctx.beginPath();
                if (colH >= 30) ctx.arc(cx(i), colTop + 10, 3.5, 0, Math.PI * 2);
                else ctx.arc(x - 4, colTop + 4, 3, 0, Math.PI * 2);
                ctx.fillStyle = qc;
                ctx.fill();
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 1;
                ctx.stroke();
            }

            // 时长标签
            ctx.fillStyle = '#444441';
            ctx.font = '11px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(hours.toFixed(1), cx(i), colTop - 6);

            // 当天另有午睡：轴下灰点提示
            const hasNap = dayRecs.some(r => r.record_type === 'nap');
            if (hasNap && primary.record_type !== 'nap') {
                ctx.fillStyle = this.napColor;
                ctx.beginPath();
                ctx.arc(cx(i), base + 7, 2.5, 0, Math.PI * 2);
                ctx.fill();
            }
        });
    }

    /* ── Legend ── */

    _drawLegend(ctx) {
        const y = this.LEGEND_Y;
        let lx = this.PAD_LEFT;
        ctx.font = '11px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'left';

        const stageItems = [
            ['深睡', this.stageColors.deep],
            ['快速眼动期(REM)', this.stageColors.rem],
            ['浅睡', this.stageColors.light],
            ['清醒', this.stageColors.awake]
        ];
        for (const [label, color] of stageItems) {
            ctx.fillStyle = color;
            ctx.fillRect(lx, y - 9, 10, 10);
            ctx.fillStyle = '#64748b';
            ctx.fillText(label, lx + 14, y);
            lx += 14 + ctx.measureText(label).width + 16;
        }

        lx += 12;
        const qItems = [['优', this.qualityColors.good], ['中', this.qualityColors.average], ['差', this.qualityColors.poor]];
        for (const [label, color] of qItems) {
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(lx + 4, y - 4, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#64748b';
            ctx.fillText(label, lx + 12, y);
            lx += 12 + ctx.measureText(label).width + 14;
        }

        lx += 12;
        ctx.fillStyle = this.napColor;
        ctx.beginPath();
        ctx.arc(lx + 4, y - 4, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#64748b';
        ctx.fillText('午睡', lx + 11, y);
    }

    /* ── Section B：入睡×醒来节律线 ── */

    _drawSectionB(ctx, dates, cx, W) {
        const top = this.B_PLOT_TOP;
        const plotH = this.B_PLOT_H;
        const spanMin = this.B_SPAN_MIN;
        const t2y = (tMin) => top + (Math.max(0, Math.min(spanMin, tMin)) / spanMin) * plotH;
        // 时刻 → 距 20:00 的分钟数（20:00=0，跨零点自动 +1440）
        const toMin = (h, m) => {
            let t = (h - this.B_START_HOUR) * 60 + m;
            if (t < 0) t += 1440;
            return t;
        };

        ctx.textAlign = 'left';
        ctx.font = '500 13px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
        ctx.fillStyle = '#0f172a';
        ctx.fillText('作息稳不稳 · 入睡×醒来节律', this.PAD_LEFT, this.TITLE_B_Y);

        // 行内图例（右侧）
        ctx.font = '11px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
        const ty = this.TITLE_B_Y;
        ctx.strokeStyle = this.onsetColor;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(W - 148, ty - 4); ctx.lineTo(W - 128, ty - 4); ctx.stroke();
        ctx.fillStyle = '#64748b';
        ctx.fillText('入睡', W - 122, ty);
        ctx.strokeStyle = this.wakeColor;
        ctx.beginPath(); ctx.moveTo(W - 78, ty - 4); ctx.lineTo(W - 58, ty - 4); ctx.stroke();
        ctx.fillStyle = '#64748b';
        ctx.fillText('醒来', W - 52, ty);

        // 横网格线（每 2 小时）
        const labels = ['20', '22', '0', '2', '4', '6', '8', '10', '12'];
        ctx.textAlign = 'right';
        for (let k = 0; k <= 8; k++) {
            const y = top + (k * 120 / spanMin) * plotH;
            ctx.strokeStyle = this.gridColor;
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.moveTo(this.PAD_LEFT, y);
            ctx.lineTo(W - this.PAD_RIGHT, y);
            ctx.stroke();
            ctx.fillStyle = this.axisTextColor;
            ctx.fillText(labels[k], this.PAD_LEFT - 6, y + 4);
        }

        // 收集每天入睡/醒来的 y 坐标（纯午睡日不进入节律图）
        const pts = dates.map((date, i) => {
            const primary = this._pickPrimary(this._grouped[date] || []);
            if (!primary || primary.record_type === 'nap') return null;
            const s = this._parseTime(primary.sleep_time);
            const w = this._parseTime(primary.wake_time);
            if (!s || !w) return null;
            return { x: cx(i), on: t2y(toMin(s.hour, s.minute)), off: t2y(toMin(w.hour, w.minute)) };
        });

        // 睡眠窗口填充（相邻两天都有数据才连）
        ctx.fillStyle = 'rgba(99,102,241,0.08)';
        for (let i = 0; i < pts.length - 1; i++) {
            const a = pts[i], b = pts[i + 1];
            if (!a || !b) continue;
            ctx.beginPath();
            ctx.moveTo(a.x, a.on);
            ctx.lineTo(b.x, b.on);
            ctx.lineTo(b.x, b.off);
            ctx.lineTo(a.x, a.off);
            ctx.closePath();
            ctx.fill();
        }

        // 两条折线 + 数据点（断点处抬笔）
        const drawLine = (key, color) => {
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            let pen = false;
            for (const p of pts) {
                if (!p) { pen = false; continue; }
                if (!pen) { ctx.moveTo(p.x, p[key]); pen = true; }
                else ctx.lineTo(p.x, p[key]);
            }
            ctx.stroke();
            ctx.fillStyle = color;
            for (const p of pts) {
                if (!p) continue;
                ctx.beginPath();
                ctx.arc(p.x, p[key], 2.5, 0, Math.PI * 2);
                ctx.fill();
            }
        };
        drawLine('on', this.onsetColor);
        drawLine('off', this.wakeColor);
    }

    /* ── 日期轴 ── */

    _drawDateLabels(ctx, dates, cx, pitch, y, today) {
        ctx.font = '11px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        const skip = pitch < 34 ? 2 : 1; // 30 天视图隔一个标一个
        dates.forEach((date, i) => {
            if (i % skip !== 0 && date !== today) return;
            ctx.fillStyle = date === today ? '#0f172a' : '#64748b';
            ctx.fillText(date.slice(5), cx(i), y);
        });
    }

    /* ── Interaction ── */

    _initInteraction() {
        this.canvas.addEventListener('click', (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            for (const r of this._hitRegions) {
                if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
                    if (typeof App !== 'undefined' && App.onTimelineClick) {
                        App.onTimelineClick(r.date);
                    }
                    return;
                }
            }
        });

        this.canvas.addEventListener('mousemove', (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const hover = this._hitRegions.some(r => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
            this.canvas.style.cursor = hover ? 'pointer' : 'default';
        });
    }
}
