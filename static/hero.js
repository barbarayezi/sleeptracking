/* hero.js — Hero 首页重构：昨晚睡眠 + 评分环 + 指标芯片 + 本周睡眠 + Whoop 总览
 * 纯前端，数据来自 /api/records、/api/whoop/daily、/api/healthkit/metrics。
 */
const HeroOverview = {
    _refs: {},

    async load() {
        this._cache();
        // 数据在东京 Turso，单次请求 ~150ms+ 往返；概览页每次进首页都要拉这两个接口，
        // 走 ApiCache（改动即失效）后二次进入秒开。失效由 App._invalidateAndRefresh 统一触发。
        const fetchJson = window.ApiCache
            ? (url) => ApiCache.fetch(url).catch(() => null)
            : (url) => fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        try {
            const [records, whoop] = await Promise.all([
                fetchJson('/api/records'),
                fetchJson('/api/whoop/daily')
            ]);
            this._render(Array.isArray(records) ? records : [], Array.isArray(whoop) ? whoop : []);
        } catch (e) {
            console.error('hero load failed', e);
        }
    },

    refresh() { return this.load(); },

    _cache() {
        const $ = (id) => document.getElementById(id);
        this._refs = {
            label: $('hero-label'), duration: $('hero-duration'), sub: $('hero-sub'),
            stats: $('hero-stats'),
            scoreGroup: $('hero-score-group'),
            weekStrip: $('hero-week-strip'), recStrip: $('hero-rec-strip'),
            whoopMeta: $('hero-whoop-meta'), weekHint: $('hero-week-hint'),
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

    _render(records, whoop) {
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

        // ── Hero 主卡指标行：恢复 · 深睡占比（与同义 pill/芯片去重后合并到这里） ──
        const whoopSorted = [...whoop].sort((a, b) => (a.record_date < b.record_date ? -1 : 1));
        const latestWhoop = whoopSorted.length ? whoopSorted[whoopSorted.length - 1] : null;
        const recovery = (latestWhoop && latestWhoop.recovery_score != null) ? latestWhoop.recovery_score
            : (night && night.recovery_score != null ? night.recovery_score : null);
        const deep = this._deepPct(night);
        const recZone = (recovery == null) ? null : (recovery >= 67 ? 'high' : recovery >= 34 ? 'mid' : 'low');
        const recZoneWord = { high: '良好', mid: '一般', low: '偏低' };
        const recZoneCls = { high: 'good', mid: 'warn', low: 'bad' };
        const statBits = [];
        if (recovery != null) {
            statBits.push(`<span class="hero-stat hero-stat--${recZoneCls[recZone]}">
                <span class="hs-label">恢复</span><b>${Math.round(recovery)}</b><small>· ${recZoneWord[recZone]}</small></span>`);
        }
        if (deep != null) {
            statBits.push(`<span class="hero-stat">
                <span class="hs-label">深睡占比</span><b>${Math.round(deep)}<span class="hs-unit">%</span></b></span>`);
        }
        r.stats.innerHTML = statBits.length
            ? statBits.join('<span class="hero-stat-sep">·</span>')
            : '<span class="hero-stat-empty">尚无恢复/深睡数据</span>';

        // 评分环：手环评分(device_score) → recovery_score → 无
        const score = (night && night.device_score != null) ? night.device_score
            : (night && night.recovery_score != null ? night.recovery_score : null);
        this._renderScoreGroup(r.scoreGroup, recovery, score, deep);

        // ── 近 7 天健康：睡眠色块 + Whoop 恢复分（原「本周睡眠」「健康总览」两卡已合并） ──
        this._renderWeekHealth(r, sleeps, whoopSorted);
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

    // ── 右栏：恢复（合成）+ 睡眠分/深睡（成分）轻量内联版 ──
    // 无边框无底色，大数字 + 标签，和左侧「恢复 95 · 良好」pill 一套扁平语言。
    _renderScoreGroup(el, recovery, sleepScore, deepPct) {
        if (!el) return;
        const zoneCls = recovery == null ? '' : (recovery >= 67 ? 'good' : recovery >= 34 ? 'warn' : 'bad');
        const zoneWord = { good: '良好', warn: '一般', bad: '偏低' };

        const recHtml = recovery == null ? '' :
            `<div class="hsg-rec">` +
            `<span class="hsg-rec-label">恢复</span>` +
            `<span class="hsg-rec-num hsg-rec-num--${zoneCls}">${Math.round(recovery)}</span>` +
            `<span class="hsg-rec-word hsg-rec-word--${zoneCls}">${zoneWord[zoneCls]}</span>` +
            `</div>`;

        const compBits = [];
        if (sleepScore != null) compBits.push(
            `<div class="hsg-comp"><span class="hsg-comp-label">睡眠分</span>` +
            `<span class="hsg-comp-num hsg-comp-num--sleep">${Math.round(sleepScore)}</span></div>`);
        if (deepPct != null) compBits.push(
            `<div class="hsg-comp"><span class="hsg-comp-label">深睡占比</span>` +
            `<span class="hsg-comp-num">${Math.round(deepPct)}<small>%</small></span></div>`);

        el.innerHTML = (recHtml || compBits.length)
            ? recHtml + (compBits.length ? `<div class="hsg-comps">${compBits.join('<span class="hsg-sep">·</span>')}</div>` : '')
            : '<div class="hsg-empty">暂无数据</div>';
    },

    _ringColor(score) {
        // DS 语义色：≥75 蓝(良好)、≥50 黄(一般)、<50 红(较差)
        if (score == null) return '#cbd5e1';
        if (score >= 75) return '#2563eb';
        if (score >= 50) return '#d97706';
        return '#dc2626';
    },

    // ── 近 7 天 · 睡眠 × 恢复（合并卡）：上排睡眠质量色块，下排 Whoop 恢复分 ──
    _renderWeekHealth(r, sleeps, whoop) {
        const today = new Date();
        const days = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date(today);
            d.setDate(today.getDate() - i);
            days.push(d);
        }
        const todayStr = this._dateStr(today);
        const whoopByDate = {};
        (whoop || []).forEach(o => { if (o && o.record_date) whoopByDate[o.record_date] = o; });

        // 上排：睡眠时长 + 质量底色
        const sleepHtml = days.map(d => {
            const ds = this._dateStr(d);
            const rec = sleeps.find(s => s.record_date === ds && (s.record_type === 'night' || s.record_type === 'segment'))
                || sleeps.find(s => s.record_date === ds);
            const cls = rec ? ('hero-week-cell--' + (rec.sleep_quality || 'average')) : 'hero-week-cell--empty';
            const isToday = (ds === todayStr) ? ' hero-week-cell--today' : '';
            const dur = rec ? this._durStr(this._durHours(rec.sleep_time, rec.wake_time)) : '';
            const tip = rec ? (ds + ' 睡眠 ' + dur) : (ds + ' 无睡眠记录');
            return `<div class="hero-week-cell ${cls}${isToday}" title="${tip}">
                <div class="hero-week-cell__date">${d.getDate()}</div>
                <div class="hero-week-cell__dur">${dur}</div>
            </div>`;
        }).join('');
        r.weekStrip.innerHTML = sleepHtml;

        // 下排：按日恢复分（≥67 绿 / 34–66 黄 / <34 红）
        const cells = days.map(d => {
            const ds = this._dateStr(d);
            const o = whoopByDate[ds];
            const v = (o && o.recovery_score != null) ? Number(o.recovery_score) : null;
            return { ds, v, isToday: ds === todayStr };
        });
        const hasWhoop = cells.some(x => x.v != null);
        const recHtml = cells.map(x => {
            if (!hasWhoop) {
                return `<div class="hero-rec-cell hero-rec-cell--empty" title="${x.ds} 无 Whoop 数据">—</div>`;
            }
            const band = x.v == null ? '' : (x.v >= 67 ? 'high' : x.v >= 34 ? 'mid' : 'low');
            const cls = x.v == null ? 'hero-rec-cell--empty' : 'hero-rec-cell--' + band;
            return `<div class="hero-rec-cell ${cls}${x.isToday ? ' hero-rec-cell--today' : ''}"
                title="${x.ds}${x.v == null ? ' 无恢复分' : ' 恢复 ' + Math.round(x.v)}">${x.v == null ? '—' : Math.round(x.v)}</div>`;
        }).join('');
        r.recStrip.innerHTML = recHtml;

        // 头部提示 + 同步状态
        const base = '底色＝睡眠质量 · 下排＝恢复分';
        const last = (whoop && whoop.length) ? whoop[whoop.length - 1] : null;
        r.weekHint.textContent = last ? base + ' · 同步 ' + last.record_date : base + ' · Whoop 未同步';

        // 底部一行：Strain / 静息心率 与昨日环比（补原 Whoop 卡的增量信息）
        if (last) {
            const prev = whoop.length > 1 ? whoop[whoop.length - 2] : null;
            const parts = [];
            const addMeta = (label, field, higherBetter) => {
                if (last[field] == null) return;
                let t = '';
                if (prev && prev[field] != null && Number(prev[field]) !== Number(last[field])) {
                    const diff = Number(last[field]) - Number(prev[field]);
                    const up = diff > 0;
                    const good = higherBetter ? up : !up;
                    const cls = (up ? 'trend-up-' : 'trend-down-') + (good ? 'good' : 'bad');
                    t = `<span class="${cls}">${up ? '▲' : '▼'} ${Math.abs(diff).toFixed(1)}</span>`;
                }
                parts.push(`<span class="meta-it"><span class="meta-lbl">${label}</span><b>${this._num(last[field])}</b>${t}</span>`);
            };
            addMeta('Strain', 'strain', true);
            addMeta('静息心率', 'resting_heart_rate', false);
            if (parts.length) {
                r.whoopMeta.hidden = false;
                r.whoopMeta.innerHTML = parts.join('');
            } else {
                r.whoopMeta.hidden = true;
            }
        } else {
            r.whoopMeta.hidden = true;
        }
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
        // 深睡占比：当前值用与顶部分组一致的 _deepPct(night)，基线按 nightOnly 逐条重算占比
        const deep = this._deepPct(cycle) ?? this._deepPct(night);
        const baseDeep = (() => {
            const vals = nightOnly.filter(o => o.record_date < anchorDate).slice(-28)
                .map(o => this._deepPct(o)).filter(v => v != null);
            return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
        })();

        // ── 恢复分输入总览（一屏看全：4 项真实输入 + 深睡占比，标注是否参与计算） ──
        // chips 结构：{ label, cur, base, unit, dec, higherBetter, involved }
        // involved=false 表示该指标不汇入恢复分（深睡占比），用虚线边框区别于真实输入。
        const overviewChips = [
            { label: 'HRV', cur: hrv, base: baseHRV, unit: 'ms', dec: 0, higherBetter: true, involved: true },
            { label: '静息心率', cur: rhr, base: baseRHR, unit: '', dec: 0, higherBetter: false, involved: true },
            { label: '睡眠效率', cur: eff, base: baseEff, unit: '%', dec: 0, higherBetter: true, involved: true },
            { label: '呼吸率', cur: resp, base: baseResp, unit: '', dec: 1, higherBetter: false, involved: true },
            { label: '深睡占比', cur: deep, base: baseDeep, unit: '%', dec: 0, higherBetter: true, involved: false },
        ];

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

        // 渲染输入总览条（一屏看全，无需下滚）
        const overviewHtml = '<div class="algo-overview">' +
            overviewChips.map(c => {
                const curFmt = c.cur == null ? '—' : (c.dec === 1 ? Number(c.cur).toFixed(1) : String(Math.round(c.cur)));
                const baseFmt = c.base == null ? '—' : (c.dec === 1 ? Number(c.base).toFixed(1) : String(Math.round(c.base)));
                let arrow = '', arrowCls = 'neu';
                if (c.cur != null && c.base != null) {
                    const diff = Number(c.cur) - Number(c.base);
                    const good = c.higherBetter ? diff > 0 : diff < 0;
                    if (Math.abs(diff / c.base) < 0.02) { arrow = '≈'; arrowCls = 'neu'; }
                    else if (good) { arrow = diff > 0 ? '↑' : '↓'; arrowCls = 'good'; }
                    else { arrow = diff > 0 ? '↑' : '↓'; arrowCls = 'bad'; }
                }
                return `<div class="aoc${c.involved ? '' : ' aoc--skip'}" title="${c.involved ? '参与恢复分计算' : '不参与恢复分计算'}">` +
                    `<span class="aoc-label">${c.label}</span>` +
                    `<span class="aoc-cur">${curFmt}<small>${c.unit}</small></span>` +
                    `<span class="aoc-base aoc-base--${arrowCls}">${arrow} 基线 ${baseFmt}${c.unit}</span>` +
                    `</div>`;
            }).join('') +
            '</div>';

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

        body.innerHTML = relHtml + overviewHtml + '<div class="algo-rows">' + rows.join('') + '</div>' + sumHtml;
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
