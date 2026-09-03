/* hero.js — Hero 首页重构：昨晚睡眠 + 评分环 + 指标芯片 + 本周睡眠 + Whoop 总览
 * 纯前端，数据来自 /api/records、/api/whoop/daily、/api/healthkit/metrics。
 */
const HeroOverview = {
    _refs: {},

    async load() {
        this._cache();
        try {
            const [recResp, whoopResp, stepsResp] = await Promise.all([
                fetch('/api/records'),
                fetch('/api/whoop/daily'),
                fetch('/api/healthkit/metrics?type=steps')
            ]);
            const records = recResp.ok ? await recResp.json() : [];
            const whoop = whoopResp.ok ? await whoopResp.json() : [];
            const steps = stepsResp.ok ? await stepsResp.json() : [];
            this._render(records, whoop, steps);
        } catch (e) {
            console.error('hero load failed', e);
        }
    },

    refresh() { return this.load(); },

    _cache() {
        const $ = (id) => document.getElementById(id);
        this._refs = {
            label: $('hero-label'), duration: $('hero-duration'), sub: $('hero-sub'),
            pill: $('hero-pill'), pillText: $('hero-pill-text'),
            ring: $('hero-ring'), chips: $('metric-chips'),
            weekStrip: $('hero-week-strip'),
            whoopRows: $('hero-whoop-rows'), whoopDate: $('hero-whoop-date'),
            algo: $('algo-body')
        };
    },

    _fmtHM(iso) {
        if (!iso) return '';
        const m = String(iso).match(/T(\d{2}:\d{2})/);
        return m ? m[1] : '';
    },

    _durHours(sleep, wake) {
        if (!sleep || !wake) return null;
        const s = new Date(sleep), w = new Date(wake);
        if (isNaN(s) || isNaN(w)) return null;
        let h = (w - s) / 3600000;
        if (h < 0) h += 24;
        return h;
    },

    _durStr(hours) {
        if (hours == null) return '—';
        const h = Math.floor(hours);
        const m = Math.round((hours - h) * 60);
        return h + 'h ' + String(m).padStart(2, '0') + 'm';
    },

    _render(records, whoop, steps) {
        const sleeps = Array.isArray(records) ? records : [];
        const night = sleeps.find(r => r.record_type === 'night' || r.record_type === 'segment') || sleeps[0];
        const r = this._refs;
        const todayStr = this._todayStr();

        // ── Hero 卡片：昨晚睡眠
        if (night) {
            const hours = this._durHours(night.sleep_time, night.wake_time);
            r.label.textContent = (night.record_date === todayStr) ? '今晨睡眠' : '昨晚睡眠';
            r.duration.textContent = this._durStr(hours);
            const st = this._fmtHM(night.sleep_time), wt = this._fmtHM(night.wake_time);
            const typeName = { night: '夜间', nap: '午睡', segment: '分段' }[night.record_type] || '';
            r.sub.textContent = (st && wt ? st + ' → ' + wt : '—') + (typeName ? ' · ' + typeName + '睡眠' : '');
        } else {
            r.label.textContent = '昨晚睡眠';
            r.duration.textContent = '—';
            r.sub.textContent = '还没有记录，点上方「记录睡眠」';
        }

        // 恢复小标签：优先 Whoop 最新恢复值，回退到睡眠记录 recovery_score
        const whoopSorted = [...whoop].sort((a, b) => (a.record_date < b.record_date ? -1 : 1));
        const latestWhoop = whoopSorted.length ? whoopSorted[whoopSorted.length - 1] : null;
        const recovery = (latestWhoop && latestWhoop.recovery_score != null) ? latestWhoop.recovery_score
            : (night && night.recovery_score != null ? night.recovery_score : null);
        if (recovery != null) {
            const q = (night && night.sleep_quality) || (recovery >= 70 ? 'good' : recovery >= 40 ? 'average' : 'poor');
            const qText = { good: '良好', average: '一般', poor: '较差' }[q] || '';
            r.pill.hidden = false;
            r.pillText.textContent = '恢复 ' + Math.round(recovery) + (qText ? ' · ' + qText : '');
        } else {
            r.pill.hidden = true;
        }

        // 评分环：手环评分(device_score) → recovery_score → 无
        const score = (night && night.device_score != null) ? night.device_score
            : (night && night.recovery_score != null ? night.recovery_score : null);
        this._renderRing(r.ring, score);

        // ── 指标芯片条
        const deep = this._deepPct(night);
        const latestSteps = steps.length ? steps[steps.length - 1].value : null;
        const whoopRecovery = (latestWhoop && latestWhoop.recovery_score != null) ? latestWhoop.recovery_score : null;
        const chips = [
            { label: '睡眠评分', value: score == null ? '—' : Math.round(score), spark: this._series(sleeps, 'device_score'), color: 'score' },
            { label: '深睡占比', value: deep == null ? '—' : Math.round(deep) + '%', spark: this._deepSeries(sleeps), color: 'deep' },
            { label: 'Whoop 恢复', value: whoopRecovery == null ? '—' : Math.round(whoopRecovery), spark: this._series(whoop, 'recovery_score'), color: 'recovery' },
            { label: '步数', value: latestSteps == null ? '—' : this._fmtNum(latestSteps), spark: this._series(steps, 'value'), color: 'steps' }
        ];
        r.chips.innerHTML = chips.map(c => `
            <div class="metric-chip">
                <div class="metric-chip__label">${c.label}</div>
                <div class="metric-chip__value">${c.value}</div>
                ${this._sparkSvg(c.spark, c.color)}
            </div>`).join('');

        // ── 本周睡眠色块 + Whoop 总览 + 恢复分算法解读
        this._renderWeek(r.weekStrip, sleeps);
        this._renderWhoop(r, whoopSorted);
        this._renderAlgo(r.algo, sleeps, whoopSorted, night);
    },

    _deepPct(rec) {
        if (!rec) return null;
        const d = rec.deep_sleep_minutes, l = rec.light_sleep_minutes, rm = rec.rem_sleep_minutes;
        if (d != null && (l != null || rm != null)) {
            const total = (d || 0) + (l || 0) + (rm || 0);
            if (total > 0) return d / total * 100;
        }
        if (rec.sleep_efficiency != null) return rec.sleep_efficiency;
        return null;
    },

    _deepSeries(records) {
        return (records || []).filter(r => r.deep_sleep_minutes != null || r.sleep_efficiency != null)
            .map(r => this._deepPct(r)).filter(v => v != null);
    },

    _series(arr, field) {
        return (arr || []).map(o => o[field]).filter(v => v != null && !isNaN(v));
    },

    _fmtNum(n) { return Number(n).toLocaleString('en-US'); },

    _sparkSvg(series, color) {
        if (!series || series.length < 2) return '<div class="metric-chip__spark"></div>';
        const w = 100, h = 22, pad = 2;
        const min = Math.min(...series), max = Math.max(...series);
        const range = (max - min) || 1;
        const step = (w - pad * 2) / (series.length - 1);
        const pts = series.map((v, i) => {
            const x = pad + i * step;
            const y = pad + (h - pad * 2) * (1 - (v - min) / range);
            return x.toFixed(1) + ',' + y.toFixed(1);
        }).join(' ');
        return `<svg class="metric-chip__spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
            <polyline points="${pts}" fill="none" stroke="${this._stroke(color)}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;
    },

    _stroke(color) {
        return { score: '#F2A65A', deep: '#ED8A6B', recovery: '#8FD3A8', steps: '#C2B09A' }[color] || '#F2A65A';
    },

    _renderRing(el, score) {
        const size = 132, cx = 66, cy = 66, rad = 54, circ = 2 * Math.PI * rad;
        const pct = (score != null && !isNaN(score)) ? Math.max(0, Math.min(100, score)) / 100 : 0;
        const off = circ * (1 - pct);
        const col = this._ringColor(score);
        el.innerHTML = `
        <svg viewBox="0 0 ${size} ${size}" role="img" aria-label="睡眠评分 ${score == null ? '暂无' : Math.round(score)}">
            <circle cx="${cx}" cy="${cy}" r="${rad}" fill="none" stroke="rgba(247,238,221,0.12)" stroke-width="11"/>
            <circle cx="${cx}" cy="${cy}" r="${rad}" fill="none" stroke="${col}" stroke-width="11"
                stroke-linecap="round" stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"
                transform="rotate(-90 ${cx} ${cy})" style="transition:stroke-dashoffset .6s ease"/>
            <text x="${cx}" y="${cy - 2}" text-anchor="middle" fill="#F7EEDD" font-size="34" font-weight="700">${score == null ? '—' : Math.round(score)}</text>
            <text x="${cx}" y="${cy + 20}" text-anchor="middle" fill="#C2B09A" font-size="12">睡眠评分</text>
        </svg>`;
    },

    _ringColor(score) {
        if (score == null) return '#8E7E68';
        if (score >= 75) return '#ED8A6B';
        if (score >= 50) return '#E6B85C';
        return '#CC6152';
    },

    _renderWeek(el, sleeps) {
        const days = [];
        const today = new Date();
        for (let i = 6; i >= 0; i--) {
            const d = new Date(today);
            d.setDate(today.getDate() - i);
            days.push(d);
        }
        const todayStr = this._dateStr(today);
        el.innerHTML = days.map(d => {
            const ds = this._dateStr(d);
            const rec = sleeps.find(s => s.record_date === ds && (s.record_type === 'night' || s.record_type === 'segment'))
                || sleeps.find(s => s.record_date === ds);
            const cls = rec ? ('hero-week-cell--' + (rec.sleep_quality || 'average')) : 'hero-week-cell--empty';
            const isToday = (ds === todayStr) ? ' hero-week-cell--today' : '';
            const dur = rec ? this._durStr(this._durHours(rec.sleep_time, rec.wake_time)) : '';
            return `<div class="hero-week-cell ${cls}${isToday}">
                <div class="hero-week-cell__date">${d.getDate()}</div>
                <div class="hero-week-cell__dur">${dur}</div>
            </div>`;
        }).join('');
    },

    _renderWhoop(r, sorted) {
        if (!sorted || !sorted.length) {
            r.whoopRows.innerHTML = '<div class="hero-whoop-empty">尚未同步手环数据<br><span style="font-size:.75rem">在「数据同步」连接 Whoop 后显示</span></div>';
            r.whoopDate.textContent = '';
            return;
        }
        const last = sorted[sorted.length - 1];
        const prev = sorted.length > 1 ? sorted[sorted.length - 2] : null;
        r.whoopDate.textContent = '最近 ' + last.record_date;
        const rows = [
            { label: '恢复', field: 'recovery_score', higherBetter: true },
            { label: 'Strain', field: 'strain', higherBetter: true },
            { label: '静息心率', field: 'resting_heart_rate', higherBetter: false }
        ];
        const html = rows.map(row => {
            const v = last[row.field];
            if (v == null) return '';
            let trendHtml = '';
            if (prev && prev[row.field] != null) {
                const diff = v - prev[row.field];
                if (diff !== 0) {
                    const up = diff > 0;
                    const good = row.higherBetter ? up : !up;
                    const cls = (up ? 'trend-up-' : 'trend-down-') + (good ? 'good' : 'bad');
                    trendHtml = `<span class="hero-whoop-row__trend ${cls}">${up ? '▲' : '▼'} ${Math.abs(diff).toFixed(1)}</span>`;
                }
            }
            return `<div class="hero-whoop-row">
                <span class="hero-whoop-row__label">${row.label}</span>
                <span><span class="hero-whoop-row__val">${this._num(v)}</span>${trendHtml}</span>
            </div>`;
        }).join('');
        r.whoopRows.innerHTML = html || '<div class="hero-whoop-empty">暂无可用指标</div>';
    },

    // ── 恢复分算法解读：基线轴拆解 + 今日建议 ──
    _nightFor(list, date) {
        if (!Array.isArray(list)) return null;
        return list.find(o => o.record_date === date && (o.record_type === 'night' || o.record_type === 'segment'))
            || list.find(o => o.record_date === date) || null;
    },

    _renderAlgo(body, sleeps, whoop, night) {
        if (!body) return;
        const daily = [...(whoop || [])].filter(o => o && o.record_date)
            .sort((a, b) => (a.record_date < b.record_date ? -1 : 1));
        const sleepsAsc = [...(sleeps || [])].filter(o => o && o.record_date)
            .sort((a, b) => (a.record_date < b.record_date ? -1 : 1));
        const last = daily.length ? daily[daily.length - 1] : null;
        const anchorDate = last ? last.record_date : (night ? night.record_date : null);
        if (!anchorDate) {
            body.innerHTML = '<div class="algo-empty">记录夜间睡眠后，这里会自动拆解「恢复分是怎么算出来的」</div>';
            return;
        }
        const cycle = this._nightFor(sleepsAsc, anchorDate)
            || (night && (night.record_type === 'night' || night.record_type === 'segment') ? night : null);
        const g = (o, f) => (o ? o[f] : null);
        const recovery = g(last, 'recovery_score') ?? g(cycle, 'recovery_score') ?? g(night, 'recovery_score');
        if (recovery == null) {
            body.innerHTML = '<div class="algo-empty">暂无恢复分：连接 Whoop 并完成一次夜间同步后，这里会展示算法拆解。</div>';
            return;
        }
        const strain = g(last, 'strain') ?? g(cycle, 'strain');
        const sleepScore = g(cycle, 'device_score') ?? g(night, 'device_score');
        const hrv = g(last, 'hrv') ?? g(cycle, 'hrv') ?? g(night, 'hrv');
        const rhr = g(last, 'resting_heart_rate') ?? g(cycle, 'resting_heart_rate') ?? g(night, 'resting_heart_rate');
        const eff = g(cycle, 'sleep_efficiency') ?? g(night, 'sleep_efficiency');
        const resp = g(cycle, 'respiratory_rate') ?? g(night, 'respiratory_rate');

        const bl = (arr, field) => {
            const vals = arr.filter(o => o[field] != null && o.record_date < anchorDate)
                .slice(-28).map(o => Number(o[field]));
            return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
        };
        const nightOnly = sleepsAsc.filter(o => o.record_type === 'night' || o.record_type === 'segment');
        const baseHRV = bl(daily, 'hrv');
        const baseRHR = bl(daily, 'resting_heart_rate');
        const baseEff = bl(nightOnly, 'sleep_efficiency');
        const baseResp = bl(nightOnly, 'respiratory_rate');

        const rows = [
            this._algoRow('HRV 心率变异性', '自主神经恢复力 · 越高越好', 3, 'ms', hrv, baseHRV, 0, true, null,
                '权重最高 · 恢复分的第一主导项', '低于基线', '高于基线'),
            this._algoRow('静息心率', '身体负荷残留 · 越低越好', 2, '', rhr, baseRHR, 0, false, null,
                '偏高 = 压力 / 炎症负荷未清', '低于基线', '高于基线'),
            this._algoRow('睡眠效率', '实际睡眠 vs 所需 · 越高越好', 2, '%', eff, baseEff, 0, true,
                '来自睡眠分 · 唯一汇入通道', '睡眠分只以这一项参与恢复计算', '偏低', '充足'),
            this._algoRow('呼吸率', '疾病 / 压力信号 · 越低越好', 1, '次/分', resp, baseResp, 1, false, null,
                '低权重 · 明显升高时提示健康波动', '低于基线', '高于基线')
        ].filter(Boolean);

        if (!rows.length) {
            body.innerHTML = '<div class="algo-empty">体征数据不足：需要至少一条历史记录用于计算 28 天基线。</div>';
            return;
        }

        const relHtml = `<div class="algo-rel">
            <span class="rel-sleep">睡眠分 <span class="rel-num">${sleepScore == null ? '—' : Math.round(sleepScore)}</span></span>
            <span class="rel-sep">· 夜间质量</span><span class="rel-sep">→</span>
            <span class="rel-gate">睡眠效率 ${eff == null ? '—' : Math.round(eff) + '%'} · 唯一汇入</span>
            <span class="rel-sep">→</span>
            <span class="rel-rec">恢复分 <span class="rel-num">${Math.round(recovery)}</span></span>
            <span class="rel-sep">· 今晨状态（HRV 主导）</span>
        </div>`;

        const zone = recovery >= 67 ? 'green' : recovery >= 34 ? 'yellow' : 'red';
        const zoneLbl = {
            green: '绿区 67–100 · 可较高强度',
            yellow: '黄区 34–66 · 中等强度',
            red: '红区 0–33 · 以恢复为主'
        };
        const zoneWord = { green: '状态良好', yellow: '状态一般', red: '状态偏低' };
        const adviceBase = {
            red: '以恢复为主：今天优先低强度活动，今晚尽早入睡，不给身体加码。',
            yellow: '中等强度：训练与工作控制在五成负荷，避免连续加码。',
            green: '状态良好：可安排中等偏上强度的训练或工作冲刺。'
        };
        const strainTxt = strain != null ? '昨日 Strain ' + (typeof strain === 'number' ? strain.toFixed(1) : strain) + '。' : '';
        let why = '';
        if (hrv != null && baseHRV != null && Number(hrv) < Number(baseHRV)) {
            const pct = Math.round((baseHRV - hrv) / baseHRV * 100);
            why = 'HRV 仍低于基线 ' + pct + '%——即使睡眠分' + (sleepScore == null ? '' : ' ' + Math.round(sleepScore)) + '不错，也建议今晚优先睡够时长（而非加练）。';
        }
        const pos = Math.max(4, Math.min(96, recovery));
        const sumHtml = `<div class="algo-sum">
            <span>四项按权重合成 →</span>
            <span class="final-chip">恢复分 ${Math.round(recovery)} · ${zoneLbl[zone]}</span>
            <span>${zoneWord[zone]}${strainTxt}</span>
        </div>
        <div class="algo-zones">
            <div class="az red">红 · 0–33</div>
            <div class="az yel">黄 · 34–66</div>
            <div class="az grn">绿 · 67–100</div>
            <div class="algo-pointer" style="left:${pos}%" title="恢复 ${Math.round(recovery)}"></div>
        </div>
        <div class="algo-zone-scale"><span>0</span><span>33</span><span>66</span><span>100</span></div>
        <div class="algo-advice">
            <span class="a-badge">今日建议</span>
            <div><p>${adviceBase[zone]}</p>${why ? '<p class="why">' + why + '</p>' : ''}</div>
        </div>
        <div class="algo-foot">* 权重仅作方向示意：HRV 为第一主导项，精确配比为 Whoop 专有算法；基线 = 本地近 28 天均值（不含当日）。本地库无 Whoop 的 sleep_need，故用同步到的「睡眠效率」近似其睡眠通道，方向逻辑一致。</div>`;

        body.innerHTML = relHtml + '<div class="algo-rows">' + rows.join('') + '</div>' + sumHtml;
    },

    _algoRow(name, desc, wgt, unit, cur, base, dec, highBetter, fromTag, effectTxt, lowTxt, highTxt) {
        if (cur == null || base == null) return null;
        const baseN = Number(base), curN = Number(cur);
        const diff = curN - baseN;
        const absP = Math.abs(diff / baseN) * 100;
        const dev = (diff / (baseN * 0.35 || 1)) * 25;
        const pos = Math.max(6, Math.min(94, 50 + dev));
        const mag = Math.abs(diff);
        const magFmt = dec === 1 ? mag.toFixed(1) : String(Math.round(mag));
        const sign = diff >= 0 ? '▲ +' : '▼ ';
        const goodSide = highBetter ? diff > 0 : diff < 0;
        const unitStr = unit || '';
        let dotCls, chipCls, chipTxt;
        if (absP < 2) { dotCls = 'neu'; chipCls = 'neu'; chipTxt = '≈ 贴近基线'; }
        else if (goodSide) { dotCls = 'good'; chipCls = 'good'; chipTxt = sign + magFmt + ' · 助力'; }
        else if (absP < 10) { dotCls = 'mild'; chipCls = 'mild'; chipTxt = sign + magFmt + ' · 轻微拉低'; }
        else { dotCls = 'bad'; chipCls = 'bad'; chipTxt = sign + magFmt + ' · 明显拉低'; }
        const dotFmt = dec === 1 ? curN.toFixed(1) : String(Math.round(curN));
        const baseFmt = dec === 1 ? baseN.toFixed(1) : String(Math.round(baseN));
        const wdots = [1, 2, 3].map(i => '<i class="' + (i <= wgt ? 'on' : '') + '"></i>').join('');
        const loCls = highBetter ? 'tint-bad' : 'tint-good';
        const hiCls = highBetter ? 'tint-good' : 'tint-bad';
        const fromHtml = fromTag ? '<div class="algo-fromsleep">' + fromTag + '</div>' : '';
        return '<div class="algo-row">' +
            '<div><div class="algo-m-name">' + name + '<span class="algo-wdots">' + wdots + '</span></div>' +
            '<div class="algo-m-desc">' + desc + '</div>' + fromHtml + '</div>' +
            '<div class="algo-meter">' +
                '<div class="algo-axis"><span>' + lowTxt + '</span><span>' + highTxt + '</span></div>' +
                '<div class="algo-bar">' +
                    '<div class="lo ' + loCls + '"></div><div class="hi ' + hiCls + '"></div>' +
                    '<div class="algo-baseline"></div>' +
                    '<div class="algo-basetag">基线 ' + baseFmt + unitStr + '</div>' +
                '</div>' +
                '<div class="algo-dot algo-dot--' + dotCls + '" style="left:' + pos + '%"></div>' +
                '<div class="algo-dotval" style="left:' + pos + '%">' + dotFmt + unitStr +
                    '<small> 基线 ' + baseFmt + unitStr + '</small></div>' +
            '</div>' +
            '<div class="algo-result"><span class="algo-chip ' + chipCls + '">' + chipTxt + '</span>' +
            '<div class="algo-effect">' + effectTxt + '</div></div>' +
        '</div>';
    },

    _num(v) {
        return (typeof v === 'number') ? (Number.isInteger(v) ? v : v.toFixed(1)) : v;
    },

    _todayStr() { return this._dateStr(new Date()); },

    _dateStr(d) {
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
};

window.HeroOverview = HeroOverview;

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => HeroOverview.load());
} else {
    HeroOverview.load();
}
