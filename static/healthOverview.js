/**
 * healthOverview.js — Research-grade "健康总览" dashboard v2.
 *
 * Design principles (inspired by Nature/NEJM figure style):
 *   - Core score trio: 睡眠分 / 恢复分 / 饮食健康分 — prominent top row
 *   - Physiological metrics: Strain / HRV / RHR / SpO2 / SkinTemp / Steps
 *   - Each chart: raw data + 7d SMA + ±1SD band + reference zones + stats
 *   - Statistical summary: mean±SD, median, range, trend arrow, n
 *   - Period shading preserved throughout
 *
 * Exposes: HealthOverview class
 */

class HealthOverview {
    constructor() {
        this.el = document.getElementById('health-overview');
        this.range = 30;
        this._initRangeButtons();
    }

    _initRangeButtons() {
        const wrap = document.getElementById('health-range');
        if (!wrap) return;
        wrap.querySelectorAll('button').forEach((btn) => {
            btn.addEventListener('click', () => {
                wrap.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
                btn.classList.add('active');
                this.range = parseInt(btn.dataset.days, 10) || 30;
                this.load();
            });
        });
        if (!this._resizeWired && typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver(() => {
                if (this._lastData) this.render(this._lastData);
            });
            const host = document.getElementById('health-overview');
            if (host) ro.observe(host);
            this._resizeWired = true;
            this._resizeObserver = ro;
        }
    }

    async load() {
        if (!this.el) return;
        const to = this._todayStr();
        const from = this._addDays(to, -(this.range - 1));
        try {
            const resp = await fetch(`/api/health-overview?from=${from}&to=${to}`);
            if (!resp.ok) {
                this.el.innerHTML = '<p class="report-placeholder">总览数据加载失败。</p>';
                return;
            }
            const data = await resp.json();
            this._lastData = data;
            this.render(data);
        } catch (err) {
            console.error('Health overview load failed:', err);
            this.el.innerHTML = '<p class="report-placeholder">总览数据加载失败。</p>';
        }
    }

    refresh() { this.load(); }

    /* ── Render ─────────────────────────────────────── */

    render(data) {
        const days = (data && data.days) || [];
        if (days.length === 0) {
            this.el.innerHTML = '<p class="report-placeholder">暂无健康数据。连接 Whoop 同步后即可看到恢复分、Strain 等指标；配置苹果健康步数后会显示步数趋势。</p>';
            return;
        }

        // ── Tier 1: Core Score Trio (睡眠分 / 恢复分 / 饮食健康分) ──
        const coreMetrics = [
            { key: 'device_score', label: '睡眠分', sub: '手环评分', unit: '', min: 0, max: 100,
              higher: true, goodAt: 80, badAt: 50,
              color: '#60a5fa', colorRgba: 'rgba(96,165,250,',
              explain: 'Whoop/手环睡眠质量评分，0–100，越高越好' },
            { key: 'recovery_score', label: '恢复分', sub: 'Whoop Recovery', unit: '', min: 0, max: 100,
              higher: true, goodAt: 70, badAt: 40,
              color: '#4ade80', colorRgba: 'rgba(74,222,128,',
              explain: '身体恢复程度，综合 HRV、静息心率、休息状态；>70 良好，<40 偏低' },
            { key: 'meal_health_score', label: '饮食健康分', sub: '日均餐食评分', unit: '/10', min: 0, max: 10,
              higher: true, goodAt: 7, badAt: 4,
              color: '#f59e0b', colorRgba: 'rgba(245,158,11,',
              explain: '每日饮食健康评分（0–10），基于营养均衡与食物质量' },
        ];

        // ── Tier 2: Physiological Metrics ──
        const physioMetrics = [
            { key: 'strain', label: 'Strain', sub: '训练负荷', unit: '', min: 0, max: 21,
              higher: null,
              color: '#818cf8', colorRgba: 'rgba(129,140,248,',
              explain: '当日训练/压力负荷。<10 休息日，10–14 中等，>14 高负荷' },
            { key: 'hrv', label: 'HRV', sub: '心率变异性', unit: 'ms', min: null, max: null,
              higher: true,
              color: '#2dd4bf', colorRgba: 'rgba(45,212,191,',
              explain: '心率变异性(ms)，越高代表自主神经恢复越好、压力越低' },
            { key: 'resting_heart_rate', label: '静息心率', sub: 'RHR', unit: 'bpm', min: null, max: null,
              higher: false, goodAt: 60, badAt: 75,
              color: '#fb923c', colorRgba: 'rgba(251,146,60,',
              explain: '静息心率(bpm)，越低通常代表心肺功能越好' },
            { key: 'spo2_percentage', label: '血氧', sub: 'SpO₂', unit: '%', min: 90, max: 100,
              higher: true, goodAt: 96, badAt: 92,
              color: '#38bdf8', colorRgba: 'rgba(56,189,248,',
              explain: '血氧饱和度。正常 ≥96%，<92% 需注意' },
            { key: 'skin_temp_celsius', label: '皮温', sub: '皮肤温度', unit: '°C', min: null, max: null,
              higher: null,
              color: '#f472b6', colorRgba: 'rgba(244,114,182,',
              explain: '相对自身基线的皮肤温度波动；升高常伴随炎症或经期' },
            { key: 'steps', label: '步数', sub: '活动量', unit: '', min: 0, max: null,
              higher: true, goodAt: 8000, badAt: 3000,
              color: '#a78bfa', colorRgba: 'rgba(167,139,250,',
              explain: '日行步数。8k–12k 为推荐区间' },
        ];

        let html = '';

        // ════ TIER 1: CORE SCORE TRIO ════
        html += '<div class="ho2-core-row">';
        for (const m of coreMetrics) {
            html += `<div class="ho2-core-card" data-metric="${m.key}">
                <div class="ho2-core__head">
                    <div>
                        <div class="ho2-core__label">${m.label}</div>
                        <div class="ho2-core__sub">${m.sub}</div>
                    </div>
                    <div class="ho2-core__score-wrap">
                        <span class="ho2-core__score" id="ho2-score-${m.key}">—</span>
                        <span class="ho2-core__unit">${m.unit}</span>
                        <span class="ho2-core__trend" id="ho2-trend-${m.key}"></span>
                    </div>
                </div>
                <div class="ho2-core__body">
                    <canvas class="ho2-core-canvas" id="ho2-canvas-${m.key}"></canvas>
                </div>
                <div class="ho2-core__stats" id="ho2-stats-${m.key}"></div>
            </div>`;
        }
        html += '</div>';

        // ════ TIER 2: PHYSIOLOGICAL METRICS ════
        html += '<div class="ho2-section-title"><span>生理指标时序</span></div>';
        html += '<div class="ho2-grid">';
        for (const m of physioMetrics) {
            html += `<div class="ho2-card" data-metric="${m.key}">
                <div class="ho2-card__head">
                    <div>
                        <span class="ho2-card__label" title="${m.explain}">${m.label}</span>
                        <span class="ho2-card__sub">${m.sub}</span>
                    </div>
                    <span class="ho2-card__val" id="ho-val-${m.key}">—</span>
                    <span class="ho-badge" id="ho-badge-${m.key}"></span>
                </div>
                <canvas class="ho2-spark" id="ho-spark-${m.key}"></canvas>
                <div class="ho2-card__meta" id="ho-meta-${m.key}"></div>
            </div>`;
        }
        html += '</div>';

        // ════ INSIGHTS ════
        const insights = (data && data.insights) || [];
        if (insights.length > 0) {
            html += '<div class="ho-insights"><h3>💡 关联洞察</h3><ul>';
            for (const ins of insights) {
                let main = ins, caveat = '';
                const idx = ins.indexOf('（注：');
                if (idx >= 0) { main = ins.slice(0, idx); caveat = ins.slice(idx); }
                html += `<li>${this._escape(main)}${caveat ? `<span class="ho-caveat">${this._escape(caveat)}</span>` : ''}</li>`;
            }
            html += '</ul></div>';
        } else {
            html += '<p class="report-placeholder" style="margin-top:12px;">记录更多数据后，这里会自动给出关联洞察。</p>';
        }

        this.el.innerHTML = html;

        // Draw all charts
        for (const m of coreMetrics) this._drawCoreMetric(m, days);
        for (const m of physioMetrics) this._drawPhysioMetric(m, days);
    }

    /* ── Tier 1: Core Score Card (large, full stats) ─── */

    _drawCoreMetric(m, days) {
        const canvas = document.getElementById('ho2-canvas-' + m.key);
        const scoreEl = document.getElementById('ho2-score-' + m.key);
        const trendEl = document.getElementById('ho2-trend-' + m.key);
        const statsEl = document.getElementById('ho2-stats-' + m.key);
        if (!canvas) return;

        // Extract valid data points
        const pts = days.map((d, i) => ({ x: i, y: d[m.key], date: d.date, period: !!d.is_period }))
                        .filter(p => p.y != null);
        const last = pts.length > 0 ? pts[pts.length - 1] : null;
        const vals = pts.map(p => p.y);

        // Score display
        if (scoreEl) {
            scoreEl.textContent = last ? (m.key === 'meal_health_score' ? last[m.key].toFixed(1) : Math.round(last[m.key])) : '—';
        }

        // Trend arrow
        if (trendEl && vals.length >= 5) {
            const recent = vals.slice(-7);
            const earlier = vals.slice(-14, -7);
            if (earlier.length >= 3) {
                const rAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
                const eAvg = earlier.reduce((a, b) => a + b, 0) / earlier.length;
                const diff = rAvg - eAvg;
                const pct = eAvg !== 0 ? (diff / eAvg * 100) : 0;
                if (diff > 0.5) {
                    trendEl.innerHTML = `<span class="ho2-trend ho2-trend--up">↑ ${pct.toFixed(0)}%</span>`;
                    trendEl.style.color = m.higher !== false ? '#4ade80' : '#f87171';
                } else if (diff < -0.5) {
                    trendEl.innerHTML = `<span class="ho2-trend ho2-trend--down">↓ ${Math.abs(pct).toFixed(0)}%</span>`;
                    trendEl.style.color = m.higher === false ? '#4ade80' : '#f87171';
                } else {
                    trendEl.innerHTML = `<span class="ho2-trend ho2-trend--flat">→ 持平</span>`;
                    trendEl.style.color = '#94a3b8';
                }
            } else {
                trendEl.textContent = '';
            }
        }

        // Canvas setup
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.parentElement.getBoundingClientRect();
        const cssW = Math.max(200, Math.round(rect.width));
        const cssH = 160;
        canvas.width = cssW * dpr;
        canvas.height = cssH * dpr;
        canvas.style.width = cssW + 'px';
        canvas.style.height = cssH + 'px';
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        if (pts.length < 2) {
            ctx.fillStyle = '#64748b';
            ctx.font = '13px -apple-system, "PingFang SC", sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(pts.length === 1 ? '仅 1 天数据，趋势需更多记录' : '暂无数据', cssW / 2, cssH / 2);
            if (statsEl) statsEl.innerHTML = '<span class="ho2-stat">n = ' + pts.length + '</span>';
            return;
        }

        // Y range
        let lo = m.min != null ? m.min : Math.min(...vals);
        let hi = m.max != null ? m.max : Math.max(...vals);
        if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
        const pad = (hi - lo) * 0.12;
        lo -= pad; hi += pad;

        const n = days.length;
        const margin = { left: m.key === 'meal_health_score' ? 28 : 36, right: 8, top: 10, bottom: 22 };
        const chartW = cssW - margin.left - margin.right;
        const chartH = cssH - margin.top - margin.bottom;

        const xOf = (i) => (n <= 1 ? margin.left + chartW / 2 : margin.left + (i / (n - 1)) * chartW);
        const yOf = (v) => margin.top + chartH - ((v - lo) / (hi - lo)) * chartH;

        // Clear
        ctx.clearRect(0, 0, cssW, cssH);

        // Reference zones (good/bad thresholds)
        if (m.goodAt != null && m.goodAt >= lo && m.goodAt <= hi) {
            const gy = yOf(m.goodAt);
            ctx.fillStyle = m.colorRgba + '0.07)';
            ctx.fillRect(margin.left, margin.top, chartW, gy - margin.top);
            ctx.strokeStyle = m.colorRgba + '0.2)';
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(margin.left, gy);
            ctx.lineTo(margin.left + chartW, gy);
            ctx.stroke();
            ctx.setLineDash([]);
            // Label
            ctx.fillStyle = m.colorRgba + '0.45)';
            ctx.font = '9px -apple-system, sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(m.higher === false ? '偏高分界' : '优选区', margin.left + chartW - 2, gy - 3);
        }
        if (m.badAt != null && m.badAt >= lo && m.badAt <= hi) {
            const by = yOf(m.badAt);
            ctx.fillStyle = 'rgba(248,113,113,0.05)';
            ctx.fillRect(margin.left, by, chartW, margin.top + chartH - by);
            ctx.strokeStyle = 'rgba(248,113,113,0.15)';
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(margin.left, by);
            ctx.lineTo(margin.left + chartW, by);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // Period shading
        for (const p of days.map((d, i) => ({ i, period: !!d.is_period }))) {
            if (p.period) {
                const x0 = xOf(Math.max(0, p.i - 0.5));
                const x1 = xOf(Math.min(n - 1, p.i + 0.5));
                ctx.fillStyle = 'rgba(244,114,182,0.08)';
                ctx.fillRect(x0, margin.top, x1 - x0, chartH);
            }
        }

        // Compute 7-day SMA and SD
        const windowSize = 7;
        const sma = [], sdBand = [];
        for (let i = 0; i < pts.length; i++) {
            const start = Math.max(0, i - windowSize + 1);
            const win = vals.slice(start, i + 1);
            const mean = win.reduce((a, b) => a + b, 0) / win.length;
            sma.push({ x: pts[i].x, y: mean });
            if (win.length >= 3) {
                const sqDiffs = win.map(v => (v - mean) ** 2);
                const sd = Math.sqrt(sqDiffs.reduce((a, b) => a + b, 0) / win.length);
                sdBand.push({ x: pts[i].x, mean, sd, lo: mean - sd, hi: mean + sd });
            } else {
                sdBand.push(null);
            }
        }

        // ±1 SD band
        if (sdBand.some(b => b)) {
            ctx.beginPath();
            let started = false;
            for (let i = 0; i < sdBand.length; i++) {
                const b = sdBand[i];
                if (!b) continue;
                const px = xOf(b.x);
                if (!started) { ctx.moveTo(px, yOf(b.hi)); started = true; }
                else ctx.lineTo(px, yOf(b.hi));
            }
            for (let i = sdBand.length - 1; i >= 0; i--) {
                const b = sdBand[i];
                if (!b) continue;
                ctx.lineTo(xOf(b.x), yOf(b.lo));
            }
            ctx.closePath();
            ctx.fillStyle = m.colorRgba + '0.12)';
            ctx.fill();
        }

        // SMA line
        if (sma.length >= 2) {
            ctx.strokeStyle = m.colorRgba + '0.6)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            sma.forEach((p, idx) => {
                const px = xOf(p.x), py = yOf(p.y);
                if (idx === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            });
            ctx.stroke();
        }

        // Raw data line
        ctx.strokeStyle = m.color;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        pts.forEach((p, idx) => {
            const px = xOf(p.x), py = yOf(p.y);
            if (idx === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        });
        ctx.stroke();

        // Data points (last 14 days highlighted, older dimmed)
        const highlightFrom = Math.max(0, pts.length - 14);
        for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            const px = xOf(p.x), py = yOf(p.y);
            ctx.fillStyle = i >= highlightFrom ? m.color : m.colorRgba + '0.35)';
            ctx.beginPath();
            ctx.arc(px, py, i >= highlightFrom ? 3 : 1.8, 0, Math.PI * 2);
            ctx.fill();
            // Last point: larger ring
            if (i === pts.length - 1) {
                ctx.strokeStyle = m.color;
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.arc(px, py, 6, 0, Math.PI * 2);
                ctx.stroke();
            }
        }

        // Grid lines & axes
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.lineWidth = 1;
        const yTicks = 5;
        for (let i = 0; i <= yTicks; i++) {
            const val = lo + (hi - lo) * (i / yTicks);
            const y = yOf(val);
            ctx.beginPath();
            ctx.moveTo(margin.left, y);
            ctx.lineTo(margin.left + chartW, y);
            ctx.stroke();
            // Y label
            ctx.fillStyle = '#64748b';
            ctx.font = '9px -apple-system, sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(this._fmtAxis(val, m.key), margin.left - 4, y + 3);
        }

        // X-axis date labels (weekly)
        ctx.fillStyle = '#64748b';
        ctx.font = '9px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        const xLabelStep = Math.max(1, Math.floor(n / 8));
        for (let i = 0; i < n; i += xLabelStep) {
            const d = days[i];
            if (d) {
                const label = d.date.slice(5).replace('-', '/'); // MM/DD
                ctx.fillText(label, xOf(i), cssH - 4);
            }
        }

        // Stats panel
        if (statsEl && vals.length > 0) {
            const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
            const sorted = [...vals].sort((a, b) => a - b);
            const median = sorted[Math.floor(sorted.length / 2)];
            const sd = Math.sqrt(vals.map(v => (v - mean) ** 2).reduce((a, b) => a + b, 0) / vals.length);
            const mn = Math.min(...vals);
            const mx = Math.max(...vals);

            // Linear regression for trend
            let slope = 0;
            if (vals.length >= 3) {
                const xMean = (vals.length - 1) / 2;
                let ssXY = 0, ssXX = 0;
                for (let i = 0; i < vals.length; i++) {
                    ssXY += (i - xMean) * (vals[i] - mean);
                    ssXX += (i - xMean) ** 2;
                }
                slope = ssXX > 0 ? ssXY / ssXX : 0;
            }
            const trendPerDay = slope;
            const trendPerWeek = slope * 7;

            let trendHtml = '';
            if (Math.abs(trendPerWeek) > 0.05) {
                const up = trendPerWeek > 0;
                const arrow = up ? '↑' : '↓';
                const color = (m.higher === false ? !up : up) ? '#4ade80' : '#f87171';
                trendHtml = `<span class="ho2-stat" style="color:${color}">${arrow} 趋势 ${this._fmt(Math.abs(trendPerWeek))}/周</span>`;
            } else {
                trendHtml = `<span class="ho2-stat">→ 趋势平稳</span>`;
            }

            statsEl.innerHTML =
                `<span class="ho2-stat">μ=${this._fmt(mean)}</span>` +
                `<span class="ho2-stat">σ=${this._fmt(sd)}</span>` +
                `<span class="ho2-stat">Md=${this._fmt(median)}</span>` +
                `<span class="ho2-stat">[${this._fmt(mn)},${this._fmt(mx)}]</span>` +
                trendHtml +
                `<span class="ho2-stat ho2-stat--dim">n=${vals.length}</span>`;
        }
    }

    /* ── Tier 2: Physiological Metric (compact) ────────*/

    _drawPhysioMetric(m, days) {
        const canvas = document.getElementById('ho-spark-' + m.key);
        const valEl = document.getElementById('ho-val-' + m.key);
        const metaEl = document.getElementById('ho-meta-' + m.key);
        const badgeEl = document.getElementById('ho-badge-' + m.key);
        if (!canvas) return;

        const pts = days.map((d, i) => ({ x: i, y: d[m.key], period: !!d.is_period }))
                        .filter(p => p.y != null);
        const last = days.filter(d => d[m.key] != null).pop();
        const vals = pts.map(p => p.y);

        // Value + badge
        if (valEl) {
            valEl.textContent = last ? this._fmt(last[m.key]) + (m.unit ? ' ' + m.unit : '') : '—';
        }
        if (badgeEl && last && pts.length > 0) {
            const interp = this._interpret(m, last[m.key], vals);
            badgeEl.textContent = interp.text;
            badgeEl.style.color = interp.color;
            badgeEl.style.borderColor = interp.color;
        }

        // Canvas
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        const cssW = Math.max(40, Math.round(rect.width));
        const cssH = 70;
        canvas.width = cssW * dpr;
        canvas.height = cssH * dpr;
        canvas.style.height = cssH + 'px';
        canvas.style.width = '100%';
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);

        if (pts.length === 0) {
            ctx.fillStyle = '#64748b';
            ctx.font = '11px -apple-system, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('暂无数据', cssW / 2, cssH / 2);
            if (metaEl) metaEl.textContent = '';
            return;
        }

        // Y range
        let lo = m.min != null ? m.min : Math.min(...vals);
        let hi = m.max != null ? m.max : Math.max(...vals);
        if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
        const pad = (hi - lo) * 0.15;
        lo -= pad; hi += pad;

        const n = days.length;
        const ml = 6, mr = 4, mt = 6, mb = 6;
        const cW = cssW - ml - mr;
        const cH = cssH - mt - mb;
        const xOf = (i) => (n <= 1 ? ml + cW / 2 : ml + (i / (n - 1)) * cW);
        const yOf = (v) => mt + cH - ((v - lo) / (hi - lo)) * cH;

        // Period shading
        for (const p of days.map((d, i) => ({ i, period: !!d.is_period }))) {
            if (p.period) {
                ctx.fillStyle = 'rgba(244,114,182,0.10)';
                const cw = cW / Math.max(n, 1);
                ctx.fillRect(xOf(p.i) - cw / 2, 0, cw, cssH);
            }
        }

        // 7d SMA
        if (pts.length >= 7) {
            const smaWin = 7;
            const smaPts = [];
            for (let i = 0; i < pts.length; i++) {
                const s = Math.max(0, i - smaWin + 1);
                const w = vals.slice(s, i + 1);
                smaPts.push({ x: pts[i].x, y: w.reduce((a, b) => a + b, 0) / w.length });
            }
            ctx.strokeStyle = m.colorRgba + '0.50)';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            smaPts.forEach((p, idx) => {
                const px = xOf(p.x), py = yOf(p.y);
                if (idx === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            });
            ctx.stroke();
        }

        // Raw line
        ctx.strokeStyle = m.color;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        pts.forEach((p, idx) => {
            const px = xOf(p.x), py = yOf(p.y);
            if (idx === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        });
        ctx.stroke();

        // Dots (last 7 highlighted)
        const hlFrom = Math.max(0, pts.length - 7);
        for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            ctx.fillStyle = i >= hlFrom ? m.color : m.colorRgba + '0.35)';
            ctx.beginPath();
            ctx.arc(xOf(p.x), yOf(p.y), i >= hlFrom ? 2.5 : 1.5, 0, Math.PI * 2);
            ctx.fill();
        }

        // Meta: avg ± sd
        if (metaEl && vals.length > 0) {
            const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
            const sd = Math.sqrt(vals.map(v => (v - mean) ** 2).reduce((a, b) => a + b, 0) / vals.length);
            metaEl.textContent = `均值 ${this._fmt(mean)}${m.unit ? m.unit : ''} · SD ${this._fmt(sd)} · 范围 ${this._fmt(Math.min(...vals))}–${this._fmt(Math.max(...vals))}`;
        }
    }

    /* ── Helpers ───────────────────────────────────────*/

    _fmt(v) {
        if (v == null) return '—';
        if (Math.abs(v) >= 10000) return (v / 1000).toFixed(1) + 'k';
        if (!Number.isInteger(v)) return v.toFixed(1);
        return String(v);
    }

    _fmtAxis(v, key) {
        if (key === 'meal_health_score') return v.toFixed(0);
        if (key === 'strain') return v.toFixed(0);
        if (key === 'steps') return v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v.toFixed(0);
        return this._fmt(v);
    }

    _interpret(m, value, vals) {
        const s = [...vals].sort((a, b) => a - b);
        const q = (p) => s[Math.max(0, Math.min(s.length - 1, Math.floor(s.length * p)))] || 0;
        const p25 = q(0.25), p75 = q(0.75);
        const enough = s.length >= 5;
        const toneColor = { good: '#22c55e', neutral: '#64748b', bad: '#f59e0b' };

        if (m.higher === true) {
            const hi = enough ? p75 : (m.goodAt != null ? m.goodAt : Infinity);
            const lo = enough ? p25 : (m.badAt != null ? m.badAt : -Infinity);
            if (value >= hi) return { text: '优', color: toneColor.good };
            if (value <= lo) return { text: '偏低', color: toneColor.bad };
            return { text: '中', color: toneColor.neutral };
        }
        if (m.higher === false) {
            const lo = enough ? p25 : (m.goodAt != null ? m.goodAt : -Infinity);
            const hi = enough ? p75 : (m.badAt != null ? m.badAt : Infinity);
            if (value <= lo) return { text: '优', color: toneColor.good };
            if (value >= hi) return { text: '偏高', color: toneColor.bad };
            return { text: '中', color: toneColor.neutral };
        }
        if (value >= p75) return { text: '偏高', color: toneColor.neutral };
        if (value <= p25) return { text: '偏低', color: toneColor.neutral };
        return { text: '正常', color: toneColor.neutral };
    }

    _escape(s) {
        return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }

    _todayStr() {
        const d = new Date();
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    _addDays(dateStr, days) {
        const d = new Date(dateStr + 'T12:00:00');
        d.setDate(d.getDate() + days);
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
}
