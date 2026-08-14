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
            whoopRows: $('hero-whoop-rows'), whoopDate: $('hero-whoop-date')
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

        // ── 本周睡眠色块 + Whoop 总览
        this._renderWeek(r.weekStrip, sleeps);
        this._renderWhoop(r, whoopSorted);
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
