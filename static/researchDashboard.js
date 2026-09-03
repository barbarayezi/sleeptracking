/**
 * researchDashboard.js — 科研级数据链路看板
 *
 * 设计目标：把全站健康数据按「原始数据 → 特征指标 → 综合评分 → 结论建议」
 * 的计算逻辑系统化展示，让用户一眼理解数据与结论之间的因果链。
 *
 * 功能：
 *   1. 数据流图（SVG）：展示 Layer 0~3 的输入-处理-输出关系
 *   2. 指标关联矩阵：皮尔逊相关系数热图 + 显著性标注
 *   3. 科研级指标卡：当前值 / Z-score / 7d 趋势 / 百分位
 *   4. 与 HealthOverview 数据共享（/api/health-overview）
 */

class ResearchDashboard {
    constructor(opts = {}) {
        this.el = document.getElementById('research-dashboard');
        this.range = opts.range || 30;
        this.onDateChange = opts.onDateChange || null;
        this._data = null;
    }

    async load() {
        if (!this.el) return;
        const to = this._todayStr();
        const from = this._addDays(to, -(this.range - 1));
        try {
            const resp = await fetch(`/api/health-overview?from=${from}&to=${to}`);
            if (!resp.ok) throw new Error('load failed');
            const data = await resp.json();
            this._data = data;
            this.render(data);
        } catch (err) {
            console.error('Research dashboard load failed:', err);
            this.el.innerHTML = '<p class="report-placeholder">科研看板数据加载失败。</p>';
        }
    }

    refresh() { return this.load(); }

    setRange(days) {
        this.range = days;
        this.load();
    }

    /* ── Render ─────────────────────────────────────── */

    render(data) {
        const days = (data && data.days) || [];
        if (days.length === 0) {
            this.el.innerHTML = '<p class="report-placeholder">暂无足够数据。同步 Whoop / HealthKit 并记录饮食后，这里会按计算逻辑展示数据链路。</p>';
            return;
        }

        let html = '';

        // ════ 顶部：数据流计算链路图 ════
        html += this._renderFlowDiagram(days);

        // ════ 中部：指标关联矩阵 ════
        html += this._renderCorrelationMatrix(days);

        // ════ 底部：科研级指标卡 ════
        html += this._renderMetricCards(days);

        this.el.innerHTML = html;

        // 绑定卡片点击 → 日期跳转
        this._wireCardClicks();
    }

    /* ── Layer 0~3 数据流图（响应式 SVG） ───────────── */

    _renderFlowDiagram(days) {
        const last = days[days.length - 1] || {};
        const metrics = [
            { key: 'sleep_hours', label: '睡眠时长', layer: 1, source: 'sleep_records', unit: 'h' },
            { key: 'sleep_efficiency', label: '睡眠效率', layer: 1, source: 'sleep_records', unit: '%' },
            { key: 'hrv', label: 'HRV', layer: 1, source: 'whoop', unit: 'ms' },
            { key: 'resting_heart_rate', label: '静息心率', layer: 1, source: 'whoop', unit: 'bpm' },
            { key: 'strain', label: 'Strain', layer: 1, source: 'whoop', unit: '' },
            { key: 'steps', label: '步数', layer: 1, source: 'healthkit', unit: '' },
            { key: 'meal_health_score', label: '饮食健康', layer: 1, source: 'meal_records', unit: '/10' },
            { key: 'device_score', label: '睡眠分', layer: 2, source: 'composite', unit: '' },
            { key: 'recovery_score', label: '恢复分', layer: 2, source: 'composite', unit: '' },
            { key: 'diet_health', label: '饮食健康分', layer: 2, source: 'composite', unit: '/10' },
            { key: 'insights', label: '关联洞察', layer: 3, source: 'conclusion', unit: '' },
            { key: 'advice', label: '每日建议', layer: 3, source: 'conclusion', unit: '' },
        ];

        // Use current/latest values where available
        const valueOf = (key) => {
            if (key === 'sleep_hours') {
                // Approximate from sleep duration if not present
                const ds = days.filter(d => d.device_score != null);
                if (!ds.length) return null;
                return null; // placeholder, not directly in API
            }
            return last[key] != null ? last[key] : null;
        };

        // Nodes positioned by layer
        const layerYs = { 0: 56, 1: 150, 2: 244, 3: 338 };
        const layerNodes = { 0: [], 1: [], 2: [], 3: [] };

        // Layer 0 sources
        const sources = [
            { id: 'sleep_records', label: '睡眠记录', sub: '入睡/醒来/质量', layer: 0 },
            { id: 'whoop', label: 'Whoop', sub: '恢复/Strain/HR', layer: 0 },
            { id: 'healthkit', label: 'HealthKit', sub: '步数/血氧/皮温', layer: 0 },
            { id: 'meal_records', label: '饮食/经期', sub: '手动记录', layer: 0 },
        ];

        // Calculate x positions evenly per layer
        const distribute = (items, y) => {
            const n = items.length;
            const gap = 680 / (n + 1);
            return items.map((it, i) => ({ ...it, x: gap * (i + 1), y }));
        };

        layerNodes[0] = distribute(sources, layerYs[0]);
        layerNodes[1] = distribute([
            { id: 'sleep_hours', label: '睡眠时长', sub: '睡眠记录', layer: 1 },
            { id: 'sleep_efficiency', label: '睡眠效率', sub: '睡眠记录', layer: 1 },
            { id: 'hrv', label: 'HRV', sub: 'Whoop', layer: 1 },
            { id: 'resting_heart_rate', label: '静息心率', sub: 'Whoop', layer: 1 },
            { id: 'strain', label: 'Strain', sub: 'Whoop', layer: 1 },
            { id: 'steps', label: '步数', sub: 'HealthKit', layer: 1 },
            { id: 'meal_health_score', label: '饮食健康', sub: '饮食记录', layer: 1 },
        ], layerYs[1]);
        layerNodes[2] = distribute([
            { id: 'device_score', label: '睡眠分', sub: '时长+效率+质量', layer: 2 },
            { id: 'recovery_score', label: '恢复分', sub: 'HRV+RHR+睡眠', layer: 2 },
            { id: 'diet_health', label: '饮食健康分', sub: '营养+主观', layer: 2 },
        ], layerYs[2]);
        layerNodes[3] = distribute([
            { id: 'insights', label: '关联洞察', sub: '统计相关', layer: 3 },
            { id: 'advice', label: '每日建议', sub: '基于评分', layer: 3 },
        ], layerYs[3]);

        // Edges: source -> target
        const edges = [
            { from: 'sleep_records', to: 'sleep_hours' },
            { from: 'sleep_records', to: 'sleep_efficiency' },
            { from: 'sleep_records', to: 'device_score' },
            { from: 'whoop', to: 'hrv' },
            { from: 'whoop', to: 'resting_heart_rate' },
            { from: 'whoop', to: 'strain' },
            { from: 'whoop', to: 'recovery_score' },
            { from: 'healthkit', to: 'steps' },
            { from: 'meal_records', to: 'meal_health_score' },
            { from: 'meal_records', to: 'diet_health' },
            { from: 'sleep_hours', to: 'device_score' },
            { from: 'sleep_efficiency', to: 'device_score' },
            { from: 'hrv', to: 'recovery_score' },
            { from: 'resting_heart_rate', to: 'recovery_score' },
            { from: 'sleep_efficiency', to: 'recovery_score' },
            { from: 'device_score', to: 'insights' },
            { from: 'recovery_score', to: 'insights' },
            { from: 'diet_health', to: 'insights' },
            { from: 'device_score', to: 'advice' },
            { from: 'recovery_score', to: 'advice' },
            { from: 'strain', to: 'advice' },
        ];

        const nodeMap = {};
        for (const layer of Object.values(layerNodes)) {
            for (const n of layer) nodeMap[n.id] = n;
        }

        const nodeWidth = 108;
        const nodeHeight = 44;

        const colorForLayer = (l) => {
            if (l === 0) return { fill: '#fff7ed', stroke: '#fdba74', text: '#9a3412' };
            if (l === 1) return { fill: '#f0fdf4', stroke: '#86efac', text: '#166534' };
            if (l === 2) return { fill: '#f0f9ff', stroke: '#7dd3fc', text: '#0369a1' };
            return { fill: '#fefce8', stroke: '#fde047', text: '#854d0e' };
        };

        let svg = `<div class="rd-flow-wrap">
            <h3 class="rd-section-title">数据流与计算链路</h3>
            <p class="rd-section-hint">原始数据 → 特征指标 → 综合评分 → 结论建议。箭头方向代表计算依赖。</p>
            <svg viewBox="0 0 680 390" class="rd-flow-svg" role="img" aria-label="数据流与计算链路">
                <defs>
                    <marker id="rd-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                        <path d="M2 1L8 5L2 9" fill="none" stroke="#94a3b8" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
                    </marker>
                </defs>`;

        // Draw edges first (behind nodes)
        for (const e of edges) {
            const s = nodeMap[e.from], t = nodeMap[e.to];
            if (!s || !t) continue;
            const sx = s.x, sy = s.y + nodeHeight / 2;
            const tx = t.x, ty = t.y - nodeHeight / 2;
            // Bezier curve
            const cp1y = sy + (ty - sy) * 0.5;
            const cp2y = ty - (ty - sy) * 0.5;
            svg += `<path d="M${sx} ${sy} C${sx} ${cp1y}, ${tx} ${cp2y}, ${tx} ${ty}" fill="none" stroke="#cbd5e1" stroke-width="1" marker-end="url(#rd-arrow)" opacity="0.7"/>`;
        }

        // Draw nodes
        for (const layer of Object.values(layerNodes)) {
            for (const n of layer) {
                const c = colorForLayer(n.layer);
                const x = n.x - nodeWidth / 2;
                const y = n.y - nodeHeight / 2;
                svg += `<g class="rd-flow-node" data-node="${n.id}">
                    <rect x="${x}" y="${y}" width="${nodeWidth}" height="${nodeHeight}" rx="8" fill="${c.fill}" stroke="${c.stroke}" stroke-width="0.8"/>
                    <text x="${n.x}" y="${n.y - 3}" text-anchor="middle" dominant-baseline="central" font-size="12" font-weight="500" fill="${c.text}">${this._escape(n.label)}</text>
                    <text x="${n.x}" y="${n.y + 12}" text-anchor="middle" dominant-baseline="central" font-size="10" fill="#64748b">${this._escape(n.sub)}</text>
                </g>`;
            }
        }

        svg += `</svg></div>`;
        return svg;
    }

    /* ── 指标关联矩阵（皮尔逊相关系数热图） ─────────── */

    _renderCorrelationMatrix(days) {
        const keys = ['device_score', 'recovery_score', 'meal_health_score', 'hrv', 'resting_heart_rate', 'strain', 'steps'];
        const labels = {
            device_score: '睡眠分',
            recovery_score: '恢复分',
            meal_health_score: '饮食健康分',
            hrv: 'HRV',
            resting_heart_rate: 'RHR',
            strain: 'Strain',
            steps: '步数',
        };

        // Extract aligned vectors by date (drop days missing either value)
        const vectors = {};
        for (const k of keys) {
            vectors[k] = days.map(d => ({ date: d.date, v: d[k] })).filter(p => p.v != null);
        }

        const pearson = (ka, kb) => {
            const mapA = new Map(vectors[ka].map(p => [p.date, p.v]));
            const pairs = [];
            for (const { date, v } of vectors[kb]) {
                if (mapA.has(date)) pairs.push([mapA.get(date), v]);
            }
            const n = pairs.length;
            if (n < 5) return null;
            const aa = pairs.map(p => p[0]), bb = pairs.map(p => p[1]);
            const ma = aa.reduce((s, v) => s + v, 0) / n;
            const mb = bb.reduce((s, v) => s + v, 0) / n;
            let num = 0, da = 0, db = 0;
            for (let i = 0; i < n; i++) {
                const xa = aa[i] - ma, xb = bb[i] - mb;
                num += xa * xb;
                da += xa * xa;
                db += xb * xb;
            }
            if (da === 0 || db === 0) return null;
            return num / Math.sqrt(da * db);
        };

        let html = '<div class="rd-matrix-wrap">';
        html += '<h3 class="rd-section-title">指标关联矩阵</h3>';
        html += '<p class="rd-section-hint">皮尔逊相关系数 r：+1 强正相关，-1 强负相关，0 无线性关联。仅展示有成对数据 ≥5 天的格子。</p>';
        html += '<div class="rd-matrix-table">';
        html += '<table class="rd-matrix">';
        // Header
        html += '<thead><tr><th></th>';
        for (const k of keys) html += `<th>${labels[k]}</th>`;
        html += '</tr></thead><tbody>';
        // Rows
        for (const k1 of keys) {
            html += `<tr><th>${labels[k1]}</th>`;
            for (const k2 of keys) {
                if (k1 === k2) {
                    html += '<td class="rd-cell rd-cell--diag">1.00</td>';
                    continue;
                }
                const r = pearson(k1, k2);
                if (r == null) {
                    html += '<td class="rd-cell rd-cell--na">—</td>';
                    continue;
                }
                const color = this._corrColor(r);
                const sig = Math.abs(r) > 0.5 ? ' *' : '';
                html += `<td class="rd-cell" style="background:${color.bg};color:${color.fg}">${r.toFixed(2)}${sig}</td>`;
            }
            html += '</tr>';
        }
        html += '</tbody></table></div>';
        html += '<p class="rd-matrix-note">* |r| &gt; 0.5 视为强相关（仅提示假设，需结合样本量与因果判断）。</p>';
        html += '</div>';
        return html;
    }

    _corrColor(r) {
        // Positive: green scale; Negative: red scale
        const a = Math.min(Math.abs(r), 1);
        if (r >= 0) {
            return { bg: `rgba(22,163,74,${0.08 + a * 0.22})`, fg: r > 0.5 ? '#14532d' : '#166534' };
        }
        return { bg: `rgba(220,38,38,${0.08 + a * 0.22})`, fg: r < -0.5 ? '#7f1d1d' : '#991b1b' };
    }

    /* ── 科研级指标卡（当前值 + Z + 趋势 + 百分位） ─── */

    _renderMetricCards(days) {
        const metrics = [
            { key: 'device_score', label: '睡眠分', unit: '', higher: true, goodAt: 80, badAt: 50 },
            { key: 'recovery_score', label: '恢复分', unit: '', higher: true, goodAt: 70, badAt: 40 },
            { key: 'meal_health_score', label: '饮食健康分', unit: '/10', higher: true, goodAt: 7, badAt: 4 },
            { key: 'hrv', label: 'HRV', unit: 'ms', higher: true },
            { key: 'resting_heart_rate', label: '静息心率', unit: 'bpm', higher: false, goodAt: 60, badAt: 75 },
            { key: 'strain', label: 'Strain', unit: '', higher: null },
            { key: 'steps', label: '步数', unit: '', higher: true, goodAt: 8000, badAt: 3000 },
        ];

        const last = days[days.length - 1] || {};
        let html = '<div class="rd-cards-wrap">';
        html += '<h3 class="rd-section-title">关键指标快照</h3>';
        html += '<p class="rd-section-hint">基于最近 ' + days.length + ' 天数据。点击卡片可跳转到该日期。</p>';
        html += '<div class="rd-cards-grid">';

        for (const m of metrics) {
            const series = days.map(d => d[m.key]).filter(v => v != null);
            const current = last[m.key];
            const hasData = series.length > 0;
            const mean = hasData ? series.reduce((a, b) => a + b, 0) / series.length : null;
            const sd = hasData ? Math.sqrt(series.map(v => (v - mean) ** 2).reduce((a, b) => a + b, 0) / series.length) : null;
            const z = (current != null && sd > 0) ? (current - mean) / sd : null;
            const below = hasData ? series.filter(v => current != null && v < current).length : 0;
            const pct = hasData ? (below / series.length) * 100 : null;

            // 7-day trend
            let trendHtml = '';
            if (series.length >= 8) {
                const recent = series.slice(-7);
                const earlier = series.slice(-14, -7);
                const rAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
                const eAvg = earlier.reduce((a, b) => a + b, 0) / earlier.length;
                const diff = rAvg - eAvg;
                const pctDiff = eAvg !== 0 ? (diff / eAvg * 100) : 0;
                const isGood = m.higher === false ? diff < 0 : diff > 0;
                const color = isGood ? '#16a34a' : '#dc2626';
                const arrow = diff > 0 ? '↑' : diff < 0 ? '↓' : '→';
                trendHtml = `<span class="rd-trend" style="color:${color}">${arrow} ${Math.abs(pctDiff).toFixed(0)}% 周环比</span>`;
            }

            // Status badge
            let badge = '';
            if (current != null) {
                if (m.goodAt != null && current >= m.goodAt) badge = '<span class="rd-badge rd-badge--good">优</span>';
                else if (m.badAt != null && current < m.badAt) badge = '<span class="rd-badge rd-badge--bad">偏低</span>';
                else badge = '<span class="rd-badge rd-badge--mid">中</span>';
            }

            const valStr = current != null ? (m.key === 'meal_health_score' ? current.toFixed(1) : Math.round(current)) : '—';
            const zStr = z != null ? `Z=${z.toFixed(2)}` : '';
            const pctStr = pct != null ? `击败 ${pct.toFixed(0)}%` : '';
            const sparkSvg = this._sparkline(days, m.key);

            html += `<div class="rd-card" data-metric="${m.key}" data-date="${last.date || ''}">
                <div class="rd-card__head">
                    <span class="rd-card__label">${m.label}</span>
                    ${badge}
                </div>
                <div class="rd-card__value">${valStr}<span class="rd-card__unit">${m.unit}</span></div>
                <div class="rd-card__meta">
                    ${trendHtml}
                    <span class="rd-card__z">${zStr}</span>
                    <span class="rd-card__pct">${pctStr}</span>
                </div>
                ${sparkSvg}
            </div>`;
        }

        html += '</div></div>';
        return html;
    }

    _sparkline(days, key) {
        const pts = days.map((d, i) => ({ i, v: d[key] })).filter(p => p.v != null);
        if (pts.length < 2) return '<div class="rd-card__spark"></div>';
        const vals = pts.map(p => p.v);
        const lo = Math.min(...vals), hi = Math.max(...vals);
        const pad = (hi - lo) * 0.1 || 1;
        const minY = lo - pad, maxY = hi + pad;
        const W = 160, H = 36;
        const xOf = (i) => (days.length <= 1) ? W / 2 : (i / (days.length - 1)) * W;
        const yOf = (v) => H - ((v - minY) / (maxY - minY)) * H;
        let path = `M${xOf(pts[0].i)} ${yOf(pts[0].v)}`;
        for (let k = 1; k < pts.length; k++) path += ` L${xOf(pts[k].i)} ${yOf(pts[k].v)}`;
        const color = key === 'resting_heart_rate' ? '#f97316' : '#2563eb';
        return `<svg class="rd-card__spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
            <path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            <circle cx="${xOf(pts[pts.length - 1].i)}" cy="${yOf(pts[pts.length - 1].v)}" r="2.5" fill="${color}"/>
        </svg>`;
    }

    _wireCardClicks() {
        if (!this.onDateChange) return;
        this.el.querySelectorAll('.rd-card').forEach(card => {
            card.style.cursor = 'pointer';
            card.addEventListener('click', () => {
                const date = card.dataset.date;
                if (date) this.onDateChange(date);
            });
        });
    }

    /* ── Helpers ────────────────────────────────────── */

    _todayStr() {
        const d = new Date();
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    _addDays(dateStr, days) {
        const d = new Date(dateStr + 'T12:00:00');
        d.setDate(d.getDate() + days);
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    _escape(s) {
        return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }
}
