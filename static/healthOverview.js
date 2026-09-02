/**
 * healthOverview.js — Cross-source "健康总览" dashboard.
 * Joins Whoop (recovery/strain/HRV/SpO2/skin temp), Apple Health (steps),
 * sleep and period data into one comparable view with sparkline trends.
 * Exposes: HealthOverview class
 */

class HealthOverview {
    constructor() {
        this.el = document.getElementById('health-overview');
        this.titleEl = document.getElementById('health-overview-title');
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

        // Re-paint sparklines on resize so canvas keeps matching the layout
        // (otherwise dpr or container width changes leave stale geometry).
        if (!this._resizeWired && typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver(() => {
                if (this._lastDays) this.render({ days: this._lastDays });
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
            this.render(data);
        } catch (err) {
            console.error('Health overview load failed:', err);
            this.el.innerHTML = '<p class="report-placeholder">总览数据加载失败。</p>';
        }
    }

    refresh() {
        // Non-blocking reload with the current range
        this.load();
    }

    render(data) {
        const days = (data && data.days) || [];
        if (days.length === 0) {
            this.el.innerHTML = '<p class="report-placeholder">暂无健康数据。连接 Whoop 同步后即可看到恢复分、Strain 等指标；配置苹果健康步数后会显示步数趋势。</p>';
            return;
        }

        const metrics = [
            { key: 'recovery_score', label: '恢复分', unit: '', color: '#4ade80', min: 0, max: 100,
              higher: true, goodAt: 70, badAt: 40,
              explain: '越高越好。Whoop 经验:>70 恢复良好,40–70 中等,<40 偏低。' },
            { key: 'strain', label: 'Strain 负荷', unit: '', color: '#818cf8', min: 0, max: 21,
              higher: null,
              explain: '训练/压力负荷,非越高越好。<10 休息日,10–14 中等,>14 高负荷。' },
            { key: 'hrv', label: 'HRV', unit: 'ms', color: '#2dd4bf', min: null, max: null,
              higher: true,
              explain: '心率变异性,越高代表身体恢复越好、压力越低。' },
            { key: 'resting_heart_rate', label: '静息心率', unit: 'bpm', color: '#fb923c', min: null, max: null,
              higher: false, goodAt: 60, badAt: 70,
              explain: '越低越好,是心肺功能的好标志。' },
            { key: 'spo2_percentage', label: '血氧', unit: '%', color: '#38bdf8', min: 90, max: 100,
              higher: true, goodAt: 95, badAt: 90,
              explain: '正常≥95%,<90% 需注意。' },
            { key: 'skin_temp_celsius', label: '皮肤温度', unit: '°C', color: '#f472b6', min: null, max: null,
              higher: null,
              explain: '看相对你自身基线的波动;升高常伴随炎症或经期。' },
            { key: 'steps', label: '步数', unit: '', color: '#60a5fa', min: 0, max: null,
              higher: true, goodAt: 8000, badAt: 4000,
              explain: '日常活动量,8k–12k 即可,并非越多越好。' }
        ];

        let html = '<div class="ho-grid">';
        for (const m of metrics) {
            html += `<div class="ho-card" data-metric="${m.key}">
                <div class="ho-card__head">
                    <span class="ho-card__label" title="${m.explain || ''}">${m.label}</span>
                    <span class="ho-card__val" id="ho-val-${m.key}">—</span>
                    <span class="ho-badge" id="ho-badge-${m.key}"></span>
                </div>
                <canvas class="ho-spark" id="ho-spark-${m.key}"></canvas>
                <div class="ho-card__meta" id="ho-meta-${m.key}"></div>
            </div>`;
        }
        html += '</div>';

        // Insights
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
            html += '<p class="report-placeholder" style="margin-top:12px;">记录更多数据后，这里会自动给出「经期/Strain/步数」与睡眠质量的关联洞察。</p>';
        }

        this.el.innerHTML = html;

        // Cache for ResizeObserver re-paint.
        this._lastDays = days;

        // Draw each sparkline + stats
        for (const m of metrics) {
            this._drawMetric(m, days);
        }
    }

    _drawMetric(m, days) {
        const canvas = document.getElementById('ho-spark-' + m.key);
        const valEl = document.getElementById('ho-val-' + m.key);
        const metaEl = document.getElementById('ho-meta-' + m.key);
        if (!canvas) return;

        const pts = days.map((d, i) => ({ x: i, y: d[m.key], period: !!d.is_period }))
                        .filter((p) => p.y != null);
        const last = days.filter((d) => d[m.key] != null).pop();
        const vals = pts.map(p => p.y);

        const badgeEl = document.getElementById('ho-badge-' + m.key);
        if (valEl) {
            valEl.textContent = last ? this._fmt(last[m.key]) + (m.unit ? ' ' + m.unit : '') : '—';
        }
        if (badgeEl) {
            if (last && pts.length > 0) {
                const interp = this._interpret(m, last[m.key], vals);
                badgeEl.textContent = interp.text;
                badgeEl.style.color = interp.color;
                badgeEl.style.borderColor = interp.color;
            } else {
                badgeEl.textContent = '';
            }
        }

        const dpr = window.devicePixelRatio || 1;
        // Use the canvas's own rendered width — CSS `.ho-spark { width: 100% }`
        // already constrains it to the .ho-card content-box, so reading it back
        // here guarantees the drawing coordinates exactly match the visible
        // pixels (avoids the sparkline-bleeds-past-card bug).
        const rect = canvas.getBoundingClientRect();
        const cssW = Math.max(40, Math.round(rect.width));
        const cssH = 56;
        canvas.width = cssW * dpr;
        canvas.height = cssH * dpr;
        canvas.style.height = cssH + 'px';
        // Keep CSS width:100% authoritative (do not overwrite with an inline
        // pixel width — that's what caused the overflow previously).
        canvas.style.width = '100%';
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);

        if (pts.length === 0) {
            ctx.fillStyle = '#64748b';
            ctx.font = '12px -apple-system, "PingFang SC", sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('暂无数据', cssW / 2, cssH / 2);
            if (metaEl) metaEl.textContent = '';
            return;
        }

        // Y range
        let lo = m.min != null ? m.min : Math.min(...pts.map(p => p.y));
        let hi = m.max != null ? m.max : Math.max(...pts.map(p => p.y));
        if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
        const pad = (hi - lo) * 0.15;
        lo -= pad; hi += pad;

        const n = days.length;
        const xOf = (i) => (n <= 1 ? cssW / 2 : (i / (n - 1)) * (cssW - 8) + 4);
        const yOf = (v) => cssH - 6 - ((v - lo) / (hi - lo)) * (cssH - 14);

        // Period shading bands
        for (const p of days.map((d, i) => ({ i, period: !!d.is_period }))) {
            if (p.period) {
                const x = xOf(p.i);
                ctx.fillStyle = 'rgba(244,114,182,0.12)';
                ctx.fillRect(x - (cssW / Math.max(n, 1)) / 2, 0, cssW / Math.max(n, 1), cssH);
            }
        }

        // Line
        ctx.strokeStyle = m.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        pts.forEach((p, idx) => {
            const x = xOf(p.x), y = yOf(p.y);
            if (idx === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.stroke();

        // Dots
        ctx.fillStyle = m.color;
        for (const p of pts) {
            ctx.beginPath();
            ctx.arc(xOf(p.x), yOf(p.y), 2.2, 0, Math.PI * 2);
            ctx.fill();
        }

        // Meta: avg + range
        const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
        if (metaEl) {
            metaEl.textContent = `均值 ${this._fmt(avg)}${m.unit ? m.unit : ''} · 区间 ${this._fmt(Math.min(...vals))}–${this._fmt(Math.max(...vals))}`;
        }
    }

    _fmt(v) {
        if (v == null) return '—';
        if (Math.abs(v) >= 10000) return (v / 1000).toFixed(1) + 'k';
        if (!Number.isInteger(v)) return v.toFixed(1);
        return String(v);
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
        // Informational (strain / skin temp): no inherent good/bad
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
