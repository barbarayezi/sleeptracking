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
              color: '#2563eb', colorRgba: 'rgba(37,99,235,',
              explain: 'Whoop/手环睡眠质量评分，0–100，越高越好' },
            { key: 'recovery_score', label: '恢复分', sub: 'Whoop Recovery', unit: '', min: 0, max: 100,
              higher: true, goodAt: 70, badAt: 40,
              color: '#16a34a', colorRgba: 'rgba(22,163,74,',
              explain: '身体恢复程度，综合 HRV、静息心率、休息状态；>70 良好，<40 偏低' },
            { key: 'meal_health_score', label: '饮食健康分', sub: '日均餐食评分', unit: '/10', min: 0, max: 10,
              higher: true, goodAt: 7, badAt: 4,
              color: '#d97706', colorRgba: 'rgba(217,119,6,',
              explain: '每日饮食健康评分（0–10），基于营养均衡与食物质量' },
        ];

        // ── Tier 2: Physiological Metrics（高区分度数据色板，白底可读） ──
        const physioMetrics = [
            { key: 'strain', label: 'Strain', sub: '训练负荷', unit: '', min: 0, max: 21,
              higher: null,
              color: '#6366f1', colorRgba: 'rgba(99,102,241,',
              explain: '当日训练/压力负荷。<10 休息日，10–14 中等，>14 高负荷' },
            { key: 'hrv', label: 'HRV', sub: '心率变异性', unit: 'ms', min: null, max: null,
              higher: true,
              color: '#0891b2', colorRgba: 'rgba(8,145,178,',
              explain: '心率变异性(ms)，越高代表自主神经恢复越好、压力越低' },
            { key: 'resting_heart_rate', label: '静息心率', sub: 'RHR', unit: 'bpm', min: null, max: null,
              higher: false, goodAt: 60, badAt: 75,
              color: '#f97316', colorRgba: 'rgba(249,115,22,',
              explain: '静息心率(bpm)，越低通常代表心肺功能越好' },
            { key: 'spo2_percentage', label: '血氧', sub: 'SpO₂', unit: '%', min: 90, max: 100,
              higher: true, goodAt: 96, badAt: 92,
              color: '#2563eb', colorRgba: 'rgba(37,99,235,',
              explain: '血氧饱和度。正常 ≥96%，<92% 需注意' },
            { key: 'skin_temp_celsius', label: '皮温', sub: '皮肤温度', unit: '°C', min: null, max: null,
              higher: null,
              color: '#ec4899', colorRgba: 'rgba(236,72,153,',
              explain: '相对自身基线的皮肤温度波动；升高常伴随炎症或经期' },
            { key: 'steps', label: '步数', sub: '活动量', unit: '', min: 0, max: null,
              higher: true, goodAt: 8000, badAt: 3000,
              color: '#7c3aed', colorRgba: 'rgba(124,58,237,',
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
                <div class="ho2-legend" id="ho2-legend-${m.key}">
                    <span class="ho2-legend__item"><span class="ho2-legend__swatch" style="background:${m.color}"></span>原始数据</span>
                    <span class="ho2-legend__item"><span class="ho2-legend__swatch" style="background:${m.colorRgba}0.7)"></span>7日均值</span>
                    <span class="ho2-legend__item"><span class="ho2-legend__swatch ho2-legend__swatch--band" style="background:${m.colorRgba}0.13)"></span>±1 SD</span>
                    <span class="ho2-legend__item"><span class="ho2-legend__swatch" style="background:${m.colorRgba}0.20); border-top:1px dashed #475569"></span>95% CI均值</span>
                    <span class="ho2-legend__item"><span class="ho2-legend__swatch ho2-legend__swatch--dash"></span>线性 OLS (R²)</span>
                    <span class="ho2-legend__item"><span class="ho2-legend__swatch ho2-legend__swatch--red-ring"></span>当前值</span>
                    <span class="ho2-legend__item"><span class="ho2-legend__swatch ho2-legend__swatch--warn">⚠</span>Z&gt;2 异常值</span>
                    <span class="ho2-legend__item"><span class="ho2-legend__swatch ho2-legend__swatch--gap"></span>缺失值</span>
                    <span class="ho2-legend__item"><span class="ho2-legend__swatch ho2-legend__swatch--box" style="color:${m.color}"></span>P25–P75</span>
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

    /* ── Tier 1: Core Score Card (research-grade, Nature/NEJM style) ─
     * Two-panel layout:
     *   (1) Time series: raw line + jitter dots + 7d SMA + ±1SD band +
     *       mean reference line + 95% CI band + linear trend (OLS) + R² label +
     *       reference zones (good/bad) + period shading + missing-day gap
     *       markers + Z>2 outlier (⚠) markers
     *   (2) Distribution: box-and-whisker (P25–P75 box, 1.5×IQR whiskers,
     *       median line, mean (+) marker, P25/50/75 labels) +
     *       current-value red ring spanning both panels +
     *       metadata: μ±σ, Md[IQR], CI95, n, missing, OLS β & R², Z-score, percentile
     */
    _drawCoreMetric(m, days) {
        const canvas = document.getElementById('ho2-canvas-' + m.key);
        const scoreEl = document.getElementById('ho2-score-' + m.key);
        const trendEl = document.getElementById('ho2-trend-' + m.key);
        const statsEl = document.getElementById('ho2-stats-' + m.key);
        if (!canvas) return;

        // Map ALL days (including missing) so gap markers land at correct x.
        const fullPts = days.map((d, i) => ({
            i, y: d[m.key], date: d.date,
            period: !!d.is_period,
            missing: d[m.key] == null,
        }));
        const pts = fullPts.filter(p => !p.missing);
        const last = pts.length > 0 ? pts[pts.length - 1] : null;
        const vals = pts.map(p => p.y);
        const Ntotal = days.length;
        const N = vals.length;
        const Nmiss = Ntotal - N;

        // ── Score & trend pill (unchanged UX) ──
        if (scoreEl) {
            scoreEl.textContent = last
                ? (m.key === 'meal_health_score' ? last.y.toFixed(1) : Math.round(last.y))
                : '—';
        }
        if (trendEl && N >= 5) {
            const recent = vals.slice(-7);
            const earlier = vals.slice(-14, -7);
            if (earlier.length >= 3) {
                const rAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
                const eAvg = earlier.reduce((a, b) => a + b, 0) / earlier.length;
                const diff = rAvg - eAvg;
                const pct = eAvg !== 0 ? (diff / eAvg * 100) : 0;
                if (diff > 0.5) {
                    trendEl.innerHTML = `<span class="ho2-trend ho2-trend--up">↑ ${pct.toFixed(0)}%</span>`;
                    trendEl.style.color = m.higher !== false ? '#16a34a' : '#dc2626';
                } else if (diff < -0.5) {
                    trendEl.innerHTML = `<span class="ho2-trend ho2-trend--down">↓ ${Math.abs(pct).toFixed(0)}%</span>`;
                    trendEl.style.color = m.higher === false ? '#16a34a' : '#dc2626';
                } else {
                    trendEl.innerHTML = `<span class="ho2-trend ho2-trend--flat">→ 持平</span>`;
                    trendEl.style.color = '#94a3b8';
                }
            } else {
                trendEl.textContent = '';
            }
        }

        // ── Canvas sizing: 2 panels stacked (TALLER for research-grade) ──
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.parentElement.getBoundingClientRect();
        const cssW = Math.max(280, Math.round(rect.width));
        const MAIN_PX = 260;             // main time-series panel height（↑ 科研级加高）
        const GAP = 10;
        const BOX_PX = N >= 3 ? 92 : 24; // box plot panel
        const PAD_BOT = 18;              // bottom padding for axis text
        const cssH = MAIN_PX + GAP + BOX_PX + PAD_BOT;
        canvas.width = cssW * dpr;
        canvas.height = cssH * dpr;
        canvas.style.width = cssW + 'px';
        canvas.style.height = cssH + 'px';
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        if (N < 1) {
            ctx.fillStyle = '#64748b';
            ctx.font = '13px -apple-system, "PingFang SC", sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('暂无数据', cssW / 2, cssH / 2);
            if (statsEl) statsEl.innerHTML = '<span class="ho2-stat">n = 0 / ' + Ntotal + ' 天</span>';
            return;
        }

        // ── Statistical measures ──
        const mean = vals.reduce((a, b) => a + b, 0) / N;
        const sd = N > 1
            ? Math.sqrt(vals.map(v => (v - mean) ** 2).reduce((a, b) => a + b, 0) / N)
            : 0;
        const sorted = [...vals].sort((a, b) => a - b);
        const qAt = (p) => sorted[Math.max(0, Math.min(N - 1, Math.floor((N - 1) * p)))];
        const mn = sorted[0];
        const mx = sorted[N - 1];
        const p25 = qAt(0.25);
        const p50 = qAt(0.50);
        const p75 = qAt(0.75);
        const iqr = p75 - p25;
        const whiskerLo = Math.max(mn, p25 - 1.5 * iqr);
        const whiskerHi = Math.min(mx, p75 + 1.5 * iqr);
        const outliers = pts.filter(p => p.y < p25 - 1.5 * iqr || p.y > p75 + 1.5 * iqr);
        const zFor = (v) => sd > 0 ? (v - mean) / sd : 0;

        // OLS linear regression on day-index → value
        let slope = 0, intercept = 0, r2 = 0;
        if (N >= 3) {
            const xMean = pts.reduce((a, p) => a + p.i, 0) / N;
            let ssXY = 0, ssXX = 0, ssYY = 0;
            for (const p of pts) {
                ssXY += (p.i - xMean) * (p.y - mean);
                ssXX += (p.i - xMean) ** 2;
                ssYY += (p.y - mean) ** 2;
            }
            slope = ssXX > 0 ? ssXY / ssXX : 0;
            intercept = mean - slope * xMean;
            r2 = ssYY > 0 ? (ssXY * ssXY) / (ssXX * ssYY) : 0;
        }

        // 95% CI of the mean
        const seMean = sd / Math.sqrt(Math.max(N, 1));
        const ciLo = mean - 1.96 * seMean;
        const ciHi = mean + 1.96 * seMean;

        // Position of latest value in distribution
        let percentile = null, zLast = null;
        if (last) {
            const below = vals.filter(v => v < last.y).length;
            percentile = N > 0 ? (below / N) * 100 : null;
            zLast = zFor(last.y);
        }

        // ── Y-axis range: anchor to DATA only (small pad) + soft clamp to m.min/m.max.
        //     Fixes prior "0–100 metrics got a −10…+110 axis just because
        //     m.min/m.max were wide" bug. ──
        let dataLo = Math.min(mn, ciLo, whiskerLo);
        let dataHi = Math.max(mx, ciHi, whiskerHi);
        if (dataHi - dataLo < 1e-6) { dataHi = dataLo + 1; }
        const range = dataHi - dataLo;
        let lo = dataLo - range * 0.10 - 1;
        let hi = dataHi + range * 0.10 + 1;
        // Soft clamp to m.min/m.max only when data lies OUTSIDE that bound.
        if (m.min != null) lo = Math.max(m.min, Math.min(lo, dataLo));
        if (m.max != null) hi = Math.min(m.max, Math.max(hi, dataHi));
        if (hi - lo < 1e-6) { hi = lo + 1; }

        // ── Layout (CSS pixels within canvas) ──
        const ml = m.key === 'meal_health_score' ? 36 : 44;  // left margin (y labels)
        const mr = 16;
        const chartW = cssW - ml - mr;
        const mainTop = 10;
        const mainBot = MAIN_PX - 26;       // leave room for x-axis date labels
        const mainChartH = mainBot - mainTop;
        const boxTop = MAIN_PX + GAP;
        const boxBot = MAIN_PX + GAP + BOX_PX - 6;
        const boxChartH = boxBot - boxTop;

        const xOf = (i) => (Ntotal <= 1
            ? ml + chartW / 2
            : ml + (i / (Ntotal - 1)) * chartW);
        const yOfMain = (v) => mainBot - ((v - lo) / (hi - lo)) * mainChartH;
        const yOfBox  = (v) => boxBot  - ((v - lo) / (hi - lo)) * boxChartH;

        ctx.clearRect(0, 0, cssW, cssH);

        /* ════════════════════════════════════════════════════════════
         *  PANEL 1 — TIME SERIES
         * ════════════════════════════════════════════════════════════ */

        // Research-grade threshold zones (full coverage, not just lines)
        // higher=true: 红 low / 黄 mid / 绿 high
        // higher=false: 绿 low / 黄 mid / 红 high
        if (m.goodAt != null && m.badAt != null) {
            const gA = Math.max(m.goodAt, m.min != null ? m.min : -Infinity);
            const bA = Math.min(m.badAt, m.max != null ? m.max : Infinity);
            if (m.higher !== false) {
                // higher-is-better:  low band (red), mid (amber), high band (green)
                if (bA > lo && bA < hi) {
                    ctx.fillStyle = 'rgba(220,38,38,0.06)';
                    ctx.fillRect(ml, m.max != null ? yOfMain(Math.min(m.max, hi)) : mainTop, chartW, mainBot - (m.max != null ? yOfMain(Math.min(m.max, hi)) : mainTop));
                    ctx.fillStyle = 'rgba(220,38,38,0.06)';
                    ctx.fillRect(ml, Math.min(yOfMain(bA), mainBot), chartW, mainBot - Math.min(yOfMain(bA), mainBot));
                }
                if (gA > lo && gA < hi) {
                    ctx.fillStyle = 'rgba(22,163,74,0.06)';
                    ctx.fillRect(ml, mainTop, chartW, yOfMain(gA) - mainTop);
                }
                if (m.badAt < m.goodAt) {
                    // mid band amber
                    const top = yOfMain(m.goodAt);
                    const bot = yOfMain(m.badAt);
                    if (top > mainTop && bot < mainBot) {
                        ctx.fillStyle = 'rgba(217,119,6,0.06)';
                        ctx.fillRect(ml, top, chartW, bot - top);
                    }
                }
            } else {
                // lower-is-better: low (green), mid (amber), high (red)
                if (gA > lo && gA < hi) {
                    ctx.fillStyle = 'rgba(22,163,74,0.06)';
                    ctx.fillRect(ml, mainTop, chartW, yOfMain(gA) - mainTop);
                }
                if (bA > lo && bA < hi) {
                    ctx.fillStyle = 'rgba(217,119,6,0.06)';
                    ctx.fillRect(ml, Math.min(yOfMain(gA), mainBot), chartW, yOfMain(bA) - Math.min(yOfMain(gA), mainBot));
                }
                if (m.max != null) {
                    ctx.fillStyle = 'rgba(220,38,38,0.06)';
                    ctx.fillRect(ml, yOfMain(m.max), chartW, mainBot - yOfMain(m.max));
                }
            }
        }

        // Reference threshold lines + labels
        if (m.goodAt != null && m.goodAt >= lo && m.goodAt <= hi) {
            const gy = yOfMain(m.goodAt);
            ctx.strokeStyle = '#16a34a';
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(ml, gy);
            ctx.lineTo(ml + chartW, gy);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = '#16a34a';
            ctx.font = 'bold 9px -apple-system, "PingFang SC", sans-serif';
            ctx.textAlign = 'right';
            const lbl = (m.higher === false ? '↓ 良 ≤' : '↑ 优 ≥') + this._fmt(m.goodAt);
            ctx.fillText(lbl, ml + chartW - 3, gy - 3);
        }
        if (m.badAt != null && m.badAt >= lo && m.badAt <= hi) {
            const by = yOfMain(m.badAt);
            ctx.strokeStyle = '#dc2626';
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(ml, by);
            ctx.lineTo(ml + chartW, by);
            ctx.stroke();
            ctx.setLineDash([]);
            // Avoid double-label if both lines are very close
            const bothLines = m.goodAt != null && Math.abs(yOfMain(m.goodAt) - by) < 12;
            if (!bothLines) {
                ctx.fillStyle = '#dc2626';
                ctx.font = 'bold 9px -apple-system, "PingFang SC", sans-serif';
                ctx.textAlign = 'right';
                const lbl = (m.higher === false ? '↑ 警 >' : '↓ 警 <') + this._fmt(m.badAt);
                ctx.fillText(lbl, ml + chartW - 3, by + 10);
            }
        }

        // Period shading
        for (const p of fullPts) {
            if (p.period) {
                const x0 = xOf(Math.max(0, p.i - 0.5));
                const x1 = xOf(Math.min(Ntotal - 1, p.i + 0.5));
                ctx.fillStyle = 'rgba(220,38,38,0.08)';
                ctx.fillRect(x0, mainTop, x1 - x0, mainChartH);
            }
        }

        // 7-day rolling mean ±1SD band
        const sma = [], sdBand = [];
        for (let i = 0; i < pts.length; i++) {
            const start = Math.max(0, i - 6);
            const win = vals.slice(start, i + 1);
            const mu = win.reduce((a, b) => a + b, 0) / win.length;
            sma.push({ x: pts[i].i, y: mu });
            if (win.length >= 3) {
                const sdw = Math.sqrt(win.map(v => (v - mu) ** 2).reduce((a, b) => a + b, 0) / win.length);
                sdBand.push({ x: pts[i].i, lo: mu - sdw, hi: mu + sdw });
            } else {
                sdBand.push(null);
            }
        }
        if (sdBand.some(b => b)) {
            ctx.beginPath();
            let started = false;
            for (let i = 0; i < sdBand.length; i++) {
                const b = sdBand[i]; if (!b) continue;
                const px = xOf(b.x);
                if (!started) { ctx.moveTo(px, yOfMain(b.hi)); started = true; }
                else ctx.lineTo(px, yOfMain(b.hi));
            }
            for (let i = sdBand.length - 1; i >= 0; i--) {
                const b = sdBand[i]; if (!b) continue;
                ctx.lineTo(xOf(b.x), yOfMain(b.lo));
            }
            ctx.closePath();
            ctx.fillStyle = m.colorRgba + '0.14)';
            ctx.fill();
        }

        // 95% CI band of the MEAN (subtle horizontal stripe)
        if (N >= 2 && ciHi - ciLo > 1e-6) {
            const ciTL = yOfMain(Math.max(ciHi, lo));
            const ciBR = yOfMain(Math.min(ciLo, hi));
            ctx.fillStyle = m.colorRgba + '0.05)';
            ctx.fillRect(ml, ciTL, chartW, ciBR - ciTL);
        }
        // Mean reference line (μ)
        if (mean >= lo && mean <= hi) {
            const my = yOfMain(mean);
            ctx.strokeStyle = m.colorRgba + '0.55)';
            ctx.lineWidth = 1;
            ctx.setLineDash([2, 3]);
            ctx.beginPath();
            ctx.moveTo(ml, my);
            ctx.lineTo(ml + chartW, my);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = m.colorRgba + '0.85)';
            ctx.font = '9px -apple-system, sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText('μ ' + this._fmt(mean), ml + 4, my - 2);
        }

        // 7-day SMA line
        if (sma.length >= 2) {
            ctx.strokeStyle = m.colorRgba + '0.70)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            sma.forEach((p, idx) => {
                const px = xOf(p.x), py = yOfMain(p.y);
                if (idx === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            });
            ctx.stroke();
        }

        // ── Linear trend line (OLS) + R² label ──
        if (N >= 3) {
            const xMin = 0;
            const xMax = Ntotal - 1;
            const t0 = yOfMain(intercept + slope * xMin);
            const t1 = yOfMain(intercept + slope * xMax);
            ctx.strokeStyle = 'rgba(100,116,139,0.95)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([5, 3]);
            ctx.beginPath();
            ctx.moveTo(xOf(xMin), t0);
            ctx.lineTo(xOf(xMax), t1);
            ctx.stroke();
            ctx.setLineDash([]);

            // Label box — anchored to the BOTTOM of the panel (so it can never
            // collide with the 30d MA label which is anchored to the top).
            const txt = `线性 OLS · R²=${r2.toFixed(2)} · β=${this._fmt(slope * 7)}/周`;
            ctx.font = '9px -apple-system, "PingFang SC", sans-serif';
            ctx.textAlign = 'right';
            const tw = ctx.measureText(txt).width;
            const labelW = tw + 8;
            const desiredRight = ml + chartW - 4;
            const right = Math.max(ml + labelW, desiredRight);
            const left  = right - labelW;
            // 65% down the panel (or 6px above mainBot — whichever is bigger)
            const by = Math.max(mainTop + mainChartH * 0.65, mainBot - 6);
            ctx.fillStyle = 'rgba(255,255,255,0.92)';
            ctx.strokeStyle = 'rgba(100,116,139,0.55)';
            ctx.lineWidth = 0.5;
            ctx.fillRect(left, by - 9, labelW, 13);
            ctx.strokeRect(left, by - 9, labelW, 13);
            ctx.fillStyle = '#475569';
            ctx.fillText(txt, right - 4, by);
        }

        // ── Missing-day gap markers (short tick at top edge only) ──
        if (Nmiss > 0) {
            ctx.strokeStyle = 'rgba(148,163,184,0.45)';
            ctx.lineWidth = 1;
            ctx.setLineDash([2, 2]);
            for (const p of fullPts) {
                if (p.missing) {
                    const x = xOf(p.i);
                    ctx.beginPath();
                    ctx.moveTo(x, mainTop + 2);
                    ctx.lineTo(x, mainTop + mainChartH * 0.10);
                    ctx.stroke();
                }
            }
            ctx.setLineDash([]);
        }

        // Raw data line + points
        ctx.strokeStyle = m.color;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        pts.forEach((p, idx) => {
            const px = xOf(p.i), py = yOfMain(p.y);
            if (idx === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        });
        ctx.stroke();

        // Points (last 14 highlighted, outliers get ⚠ marker)
        const hlFrom = Math.max(0, pts.length - 14);
        for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            const px = xOf(p.i), py = yOfMain(p.y);
            const isOutlier = Math.abs(zFor(p.y)) > 2;
            ctx.fillStyle = i >= hlFrom ? m.color : m.colorRgba + '0.40)';
            ctx.beginPath();
            ctx.arc(px, py, i >= hlFrom ? 3 : 1.8, 0, Math.PI * 2);
            ctx.fill();
            if (i === pts.length - 1) {
                // Current point ring will be redrawn later (after both panels)
            }
            if (isOutlier) {
                ctx.fillStyle = '#d97706';
                ctx.font = 'bold 8px -apple-system, sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText('⚠', px, py - 6);
            }
        }

        // Y-axis grid + tick labels (main panel)
        ctx.strokeStyle = 'rgba(148,163,184,0.18)';
        ctx.lineWidth = 1;
        const yTicks = 4;
        for (let i = 0; i <= yTicks; i++) {
            const val = lo + (hi - lo) * (i / yTicks);
            const y = yOfMain(val);
            ctx.beginPath();
            ctx.moveTo(ml, y);
            ctx.lineTo(ml + chartW, y);
            ctx.stroke();
            ctx.fillStyle = '#64748b';
            ctx.font = '9px -apple-system, sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(this._fmtAxis(val, m.key), ml - 4, y + 3);
        }

        // X-axis date labels (weekly stride)
        ctx.fillStyle = '#64748b';
        ctx.font = '9px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        const xLabelStep = Math.max(1, Math.floor(Ntotal / 8));
        for (let i = 0; i < Ntotal; i += xLabelStep) {
            const d = days[i];
            if (d) {
                const label = d.date.slice(5).replace('-', '/');
                ctx.fillText(label, xOf(i), mainBot + 12);
            }
        }

        /* ════════════════════════════════════════════════════════════
         *  PANEL 2 — BOX-AND-WHISKER + JITTER
         * ════════════════════════════════════════════════════════════ */
        // Jitter dots: every valid day plotted at its day-x with tiny
        // deterministic ±3 px horizontal jitter so dense clusters are visible.
        if (N >= 2) {
            for (const p of pts) {
                const seed = Math.sin(p.i * 12.9898) * 43758.5453;
                const jit = ((seed - Math.floor(seed)) - 0.5) * 6;
                const px = xOf(p.i) + jit;
                const py = yOfMain(p.y);
                const isOutlier = Math.abs(zFor(p.y)) > 2;
                ctx.fillStyle = isOutlier ? m.colorRgba + '0.95)' : m.colorRgba + '0.45)';
                ctx.beginPath();
                ctx.arc(px, py, isOutlier ? 2 : 1.4, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        if (N >= 3) {
            const boxCx = ml + chartW / 2;
            const boxW = Math.min(82, Math.max(34, chartW * 0.30));
            const boxX0 = boxCx - boxW / 2;
            const boxX1 = boxCx + boxW / 2;

            // IQR box
            ctx.fillStyle = m.colorRgba + '0.22)';
            ctx.strokeStyle = m.color;
            ctx.lineWidth = 1.3;
            const yTop75 = yOfBox(p75);
            const yBot25 = yOfBox(p25);
            ctx.fillRect(boxX0, yTop75, boxW, yBot25 - yTop75);
            ctx.strokeRect(boxX0, yTop75, boxW, yBot25 - yTop75);

            // Median line
            const yMd = yOfBox(p50);
            ctx.strokeStyle = m.color;
            ctx.lineWidth = 2.2;
            ctx.beginPath();
            ctx.moveTo(boxX0, yMd);
            ctx.lineTo(boxX1, yMd);
            ctx.stroke();

            // Whiskers (1.5×IQR)
            ctx.strokeStyle = m.colorRgba + '0.85)';
            ctx.lineWidth = 1;
            const wx = boxCx;
            ctx.beginPath();
            // Lower
            ctx.moveTo(wx, yBot25);
            ctx.lineTo(wx, yOfBox(whiskerLo));
            ctx.moveTo(boxX0 + boxW * 0.30, yOfBox(whiskerLo));
            ctx.lineTo(boxX1 - boxW * 0.30, yOfBox(whiskerLo));
            // Upper
            ctx.moveTo(wx, yTop75);
            ctx.lineTo(wx, yOfBox(whiskerHi));
            ctx.moveTo(boxX0 + boxW * 0.30, yOfBox(whiskerHi));
            ctx.lineTo(boxX1 - boxW * 0.30, yOfBox(whiskerHi));
            ctx.stroke();

            // Mean cross marker (+)
            ctx.strokeStyle = '#475569';
            ctx.lineWidth = 1.2;
            const meanY = yOfBox(mean);
            ctx.beginPath();
            ctx.moveTo(boxCx - 4, meanY); ctx.lineTo(boxCx + 4, meanY);
            ctx.moveTo(boxCx, meanY - 4); ctx.lineTo(boxCx, meanY + 4);
            ctx.stroke();
            ctx.fillStyle = '#475569';
            ctx.font = '9px -apple-system, sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText('μ', boxX1 + 12, meanY + 3);

            // P25 / P50 / P75 labels at right edge of box
            ctx.font = '9px -apple-system, sans-serif';
            ctx.textAlign = 'left';
            ctx.fillStyle = m.colorRgba + '0.80)';
            ctx.fillText('P25 ' + this._fmt(p25), boxX1 + 4, yBot25 + 3);
            ctx.fillText('P75 ' + this._fmt(p75), boxX1 + 4, yTop75 + 3);
            ctx.fillStyle = m.color;
            ctx.fillText('Md ' + this._fmt(p50), boxX1 + 4, yMd + 3);

            // Box-plot column heading
            ctx.fillStyle = '#94a3b8';
            ctx.font = '8px -apple-system, "PingFang SC", sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('分布（P25–P75， 须=1.5×IQR， +=均值）', boxCx, MAIN_PX + GAP + BOX_PX - 1);
        } else {
            // Too few points — short placeholder
            ctx.fillStyle = '#94a3b8';
            ctx.font = '10px -apple-system, "PingFang SC", sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('需 ≥3 天有效数据才能绘制盒须分布', ml + chartW / 2, MAIN_PX + GAP + 16);
        }

        // ── Current-value red marker spans both panels ──
        if (last) {
            const currentX = xOf(last.i);
            ctx.strokeStyle = 'rgba(239,68,68,0.85)';
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(currentX, mainTop);
            ctx.lineTo(currentX, MAIN_PX + GAP + BOX_PX);
            ctx.stroke();
            ctx.setLineDash([]);
            // Red ring on main panel point
            ctx.strokeStyle = '#ef4444';
            ctx.lineWidth = 2.2;
            ctx.beginPath();
            ctx.arc(currentX, yOfMain(last.y), 7, 0, Math.PI * 2);
            ctx.stroke();
            // Same red mark inside the box (for visual cross-panel reference)
            if (N >= 3) {
                const boxCx = ml + chartW / 2;
                const boxX0 = boxCx - Math.min(82, Math.max(34, chartW * 0.30)) / 2;
                const boxX1 = boxCx + Math.min(82, Math.max(34, chartW * 0.30)) / 2;
                const insideBox = currentX >= boxX0 && currentX <= boxX1;
                if (!insideBox) {
                    // current day is outside the box-plot column → draw a small red tick
                    ctx.strokeStyle = '#ef4444';
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.moveTo(boxX1 + 8, yOfBox(last.y));
                    ctx.lineTo(boxX1 + 18, yOfBox(last.y));
                    ctx.stroke();
                }
            }
        }

        // ── Stats row: research-grade metadata ──
        if (statsEl) {
            let html = '';
            html += `<span class="ho2-stat"><b>μ=${this._fmt(mean)}</b></span>`;
            html += `<span class="ho2-stat">σ=${this._fmt(sd)}</span>`;
            html += `<span class="ho2-stat">Md=${this._fmt(p50)}</span>`;
            html += `<span class="ho2-stat">IQR=[${this._fmt(p25)}, ${this._fmt(p75)}]</span>`;
            html += `<span class="ho2-stat">范围 [${this._fmt(mn)}, ${this._fmt(mx)}]</span>`;
            if (N >= 2) {
                html += `<span class="ho2-stat">95%CI [${this._fmt(ciLo)}, ${this._fmt(ciHi)}]</span>`;
            }
            if (N >= 3) {
                const up = slope > 0;
                const color = Math.abs(slope) < 1e-6
                    ? '#94a3b8'
                    : (m.higher === false ? (up ? '#dc2626' : '#16a34a') : (up ? '#16a34a' : '#dc2626'));
                const arrow = Math.abs(slope) < 1e-6 ? '→' : (up ? '↑' : '↓');
                html += `<span class="ho2-stat" style="color:${color}">${arrow} 趋势 ${this._fmt(Math.abs(slope * 7))}/周 · R²=${r2.toFixed(2)}</span>`;
            } else {
                html += `<span class="ho2-stat" style="opacity:0.6">趋势 · 需 ≥3 天有效数据</span>`;
            }
            if (outliers.length > 0) {
                html += `<span class="ho2-stat" style="color:#f59e0b">⚠ ${outliers.length} 个异常值</span>`;
            }
            if (Nmiss > 0) {
                html += `<span class="ho2-stat" style="color:#94a3b8">${Nmiss} 天无数据</span>`;
            }
            html += `<span class="ho2-stat ho2-stat--dim">n=${N}/${Ntotal}</span>`;
            if (percentile != null && zLast != null) {
                const lastFmt = m.key === 'meal_health_score'
                    ? last.y.toFixed(1) : Math.round(last.y).toString();
                const pctColor = zLast >= 0
                    ? (m.higher === false ? '#dc2626' : '#16a34a')
                    : (m.higher === false ? '#16a34a' : '#dc2626');
                html += `<span class="ho2-stat" style="color:${pctColor};font-weight:700">当前 ${lastFmt} · 击败 ${percentile.toFixed(0)}% 历史 · Z=${zLast.toFixed(2)}</span>`;
            }
            statsEl.innerHTML = html;
        }

        // Single follow-up moving average (7d is already drawn earlier; only add
        // a 30d trend so the panel doesn't drown in lines).
        const drawMA = (k, color, dash, label, dyOffset = 0) => {
            if (N < k) return null;
            const out = [];
            for (let i = 0; i < pts.length; i++) {
                const start = Math.max(0, i - k + 1);
                const win = vals.slice(start, i + 1);
                const mu = win.reduce((a, b) => a + b, 0) / win.length;
                out.push({ x: pts[i].i, y: mu });
            }
            if (out.length < 2) return null;
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            ctx.setLineDash(dash);
            ctx.beginPath();
            out.forEach((p, idx) => {
                const px = xOf(p.x), py = yOfMain(p.y);
                if (idx === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            });
            ctx.stroke();
            ctx.setLineDash([]);
            // Endpoint label, stacked vertically to dodge the OLS label box
            const last_ = out[out.length - 1];
            const lx = xOf(last_.x), ly = yOfMain(last_.y);
            ctx.font = 'bold 9px -apple-system, "PingFang SC", sans-serif';
            ctx.textAlign = 'left';
            const tag = label + ' ' + this._fmt(last_.y);
            const tw = ctx.measureText(tag).width;
            const tx = Math.min(ml + chartW - tw - 4, lx + 6);
            const ty = Math.max(mainTop + 6, Math.min(mainBot - 24, ly + dyOffset));
            ctx.fillStyle = 'rgba(255,255,255,0.94)';
            const pad = 3;
            ctx.fillRect(tx - pad, ty - 8, tw + pad * 2, 12);
            ctx.strokeStyle = color;
            ctx.lineWidth = 0.6;
            ctx.strokeRect(tx - pad, ty - 8, tw + pad * 2, 12);
            ctx.fillStyle = color;
            ctx.fillText(tag, tx, ty + 2);
            return out;
        };
        // Stack: 30d MA label above the OLS line label (12px gap) so neither
        // box can ever overlap the other.
        const ma30 = drawMA(30, 'rgba(15, 23, 42, 0.55)', [6, 4], '30d MA', -14);

        // Build lookup for hover tooltip (find nearest valid data point by x)
        const hoverLookup = pts.map(p => ({
            i: p.i, x: xOf(p.i), y: p.y, date: p.date,
            period: !!p.period, missing: false,
        }));

        // ── Hover tooltip (research-grade: shows raw value + MA + Z-score + zone) ──
        const tooltip = document.createElement('div');
        tooltip.className = 'ho2-tooltip';
        const body = canvas.parentElement;
        body.style.position = 'relative';
        body.appendChild(tooltip);
        const prevTip = body.querySelector('.ho2-tooltip');
        if (prevTip && prevTip !== tooltip) prevTip.remove();

        canvas.addEventListener('mousemove', (ev) => {
            const rect = canvas.getBoundingClientRect();
            const mx = ev.clientX - rect.left;
            const my = ev.clientY - rect.top;
            // Only react if mouse is within main panel area
            if (my < mainTop || my > mainBot) { tooltip.style.opacity = '0'; return; }
            // Find nearest point by x
            let nearest = null, bestDx = Infinity;
            for (const p of hoverLookup) {
                const dx = Math.abs(p.x - mx);
                if (dx < bestDx) { bestDx = dx; nearest = p; }
            }
            if (!nearest || bestDx > 28) { tooltip.style.opacity = '0'; return; }
            const v = nearest.y;
            const z = zFor(v);
            const zTxt = (z >= 0 ? '+' : '') + z.toFixed(2);
            const tag = nearest.period ? ' · 经期' : '';
            const fmt = (x) => m.key === 'meal_health_score' ? x.toFixed(2) : Math.round(x).toString();
            const lvl = m.goodAt != null && v >= m.goodAt ? `<span style="color:#86efac">优</span>`
                       : m.badAt != null && v < m.badAt  ? `<span style="color:#fca5a5">差</span>`
                       : `<span style="color:#fde68a">中</span>`;
            let maRows = '';
            const calcMA = (arr) => arr ? (arr.find(mp => mp.x === nearest.i) || null) : null;
            const seg = (k) => {
                const start = Math.max(0, pts.findIndex(p => p.i === nearest.i) - k + 1);
                const win = vals.slice(start, pts.findIndex(p => p.i === nearest.i) + 1);
                if (win.length < 1) return null;
                return fmt(win.reduce((a, b) => a + b, 0) / win.length);
            };
            const dStr = String(nearest.date || '');
            maRows += `<div class="ho2-tip-row"><span class="ho2-tip-label">日期</span><span>${dStr}</span></div>`;
            maRows += `<div class="ho2-tip-row"><span class="ho2-tip-label">区间</span><span>${pts.findIndex(p => p.i === nearest.i) + 1}/${N} ${tag}</span></div>`;
            maRows += `<div class="ho2-tip-row"><span class="ho2-tip-label">${m.label}</span><strong>${fmt(v)} ${m.unit || ''}</strong> ${lvl}</div>`;
            maRows += `<div class="ho2-tip-row"><span class="ho2-tip-label">Z-score</span><span>${zTxt}</span></div>`;
            maRows += `<div class="ho2-tip-row"><span class="ho2-tip-label">MA 7d</span><span>${seg(7) ?? '—'}</span></div>`;
            if (ma30) maRows += `<div class="ho2-tip-row"><span class="ho2-tip-label">MA 30d</span><span>${calcMA(ma30) ? fmt(calcMA(ma30).y) : '—'}</span></div>`;
            // (14d MA removed for legibility; 7d is on the panel as solid line)
            if (Math.abs(z) > 2) maRows += `<div class="ho2-tip-outlier">⚠ Z&gt;2 异常</div>`;
            tooltip.innerHTML = maRows;
            // Position: prefer right of cursor; flip if overflows
            const tipW = tooltip.offsetWidth || 180;
            const tipH = tooltip.offsetHeight || 100;
            let tx = mx + 14, ty = my - tipH - 8;
            if (tx + tipW > rect.width) tx = mx - tipW - 14;
            if (ty < 0) ty = my + 14;
            tooltip.style.left = tx + 'px';
            tooltip.style.top = ty + 'px';
            tooltip.style.opacity = '1';
        });
        canvas.addEventListener('mouseleave', () => { tooltip.style.opacity = '0'; });
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
                ctx.fillStyle = 'rgba(220,38,38,0.08)';
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
        const toneColor = { good: '#22c55e', neutral: '#64748b', bad: '#d97706' };

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
