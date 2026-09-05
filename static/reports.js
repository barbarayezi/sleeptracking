/**
 * reports.js — Report panel: fetch, render, and display sleep analysis reports.
 * Exposes: ReportManager class
 */

class ReportManager {
    constructor() {
        this.outputEl = document.getElementById('report-output');
        this.periodSelect = document.getElementById('report-period');
        this.btnGenerate = document.getElementById('btn-generate-report');

        this._initEvents();
    }

    _initEvents() {
        this.btnGenerate.addEventListener('click', () => this.generate());
    }

    async generate() {
        const period = this.periodSelect.value;
        this.outputEl.innerHTML = '<p class="report-placeholder">正在生成报告...</p>';

        try {
            const resp = await fetch(`/api/report?period=${period}`);
            if (!resp.ok) {
                const err = await resp.json();
                this.outputEl.innerHTML = `<p class="report-placeholder" style="color:var(--red)">生成失败: ${err.error}</p>`;
                return;
            }
            const report = await resp.json();
            this._render(report);
        } catch (err) {
            this.outputEl.innerHTML = `<p class="report-placeholder" style="color:var(--red)">网络错误: ${err.message}</p>`;
        }
    }

    /* ── Render ───────────────────────────── */

    _render(report) {
        if (report.total_days_recorded === 0) {
            this.outputEl.innerHTML = `<p class="report-placeholder">${report.message || '该时间段暂无记录。'}</p>`;
            return;
        }

        let html = '';

        // Summary stats
        html += '<div class="report-summary">';
        html += this._statCard(report.average_sleep_hours + 'h', '平均每日睡眠');
        html += this._statCard(report.total_days_recorded + '天', '记录天数');
        html += this._statCard(report.total_records + '条', '总记录数');
        html += this._statCard(report.average_sleep_time, '平均入睡时间');
        html += '</div>';

        // Distribution grid: 4 visual cards with legend + insight
        html += '<div class="report-distribution-grid">';

        const totalQuality = report.total_days_recorded || 1;
        const qualityGoodRate = report.quality_breakdown.good / totalQuality;
        html += this._distCard({
            icon: '😴',
            title: '睡眠质量分布',
            type: 'donut',
            data: [
                { label: '良好', count: report.quality_breakdown.good, color: 'var(--success)' },
                { label: '一般', count: report.quality_breakdown.average, color: 'var(--warning)' },
                { label: '较差', count: report.quality_breakdown.poor, color: 'var(--danger)' },
            ],
            total: report.total_days_recorded,
            unit: '天',
            insight: qualityGoodRate >= 0.5
                ? `睡眠良好率 ${(qualityGoodRate * 100).toFixed(0)}%，整体质量偏优`
                : `睡眠良好率 ${(qualityGoodRate * 100).toFixed(0)}%，质量有提升空间`,
        });

        const totalClass = report.total_records || 1;
        html += this._distCard({
            icon: '⏰',
            title: '入睡分类',
            type: 'donut',
            data: [
                { label: '早睡', count: report.classification_breakdown.early, color: 'var(--primary)' },
                { label: '晚睡', count: report.classification_breakdown.late, color: '#7c3aed' },
            ],
            total: report.total_records,
            unit: '条',
            insight: report.classification_breakdown.late > report.classification_breakdown.early
                ? '晚睡记录更多，建议关注入睡节律'
                : '早睡占比更高，节律相对规律',
        });

        if (report.type_breakdown) {
            html += this._distCard({
                icon: '🏷️',
                title: '记录类型',
                type: 'donut',
                data: [
                    { label: '夜间睡眠', count: report.type_breakdown.night, color: '#0c5a56' },
                    { label: '午睡', count: report.type_breakdown.nap, color: '#d97706' },
                    { label: '分段睡眠', count: report.type_breakdown.segment, color: '#64748b' },
                ],
                total: report.total_records,
                unit: '条',
                insight: `夜间睡眠占 ${(report.type_breakdown.night / totalClass * 100).toFixed(0)}%，为记录主体`,
            });
        }

        if (report.problem_frequency && Object.keys(report.problem_frequency).length > 0) {
            const problemNames = {
                insomnia: '失眠', dreams: '多梦', sweats: '多汗',
                waking: '频醒', early_waking: '早醒'
            };
            const problemColors = {
                insomnia: 'var(--danger)', dreams: 'var(--warning)',
                sweats: '#ea580c', waking: '#0891b2', early_waking: '#7c3aed'
            };
            const problemData = Object.entries(report.problem_frequency)
                .sort((a, b) => b[1] - a[1])
                .map(([key, count]) => ({
                    label: problemNames[key] || key,
                    count,
                    color: problemColors[key] || 'var(--gray-400)',
                }));
            const maxCount = Math.max(...problemData.map(d => d.count));
            html += this._distCard({
                icon: '⚠️',
                title: '睡眠问题频率',
                type: 'bar',
                data: problemData,
                max: maxCount,
                total: report.total_days_recorded,
                unit: '天',
                insight: `最常见问题：${problemData[0].label}，共 ${problemData[0].count} 次`,
            });
        }

        html += '</div>';

        // Trend
        const trendLabels = {
            improving: '📈 睡眠时长正在改善',
            declining: '📉 睡眠时长有所下降，请注意调整',
            stable: '➡️ 睡眠时长保持稳定',
            insufficient_data: '⏳ 数据不足，无法判断趋势'
        };
        html += `<div class="report-trend ${report.trend}">${trendLabels[report.trend] || report.trend}</div>`;

        // Period vs non-period correlation
        if (report.period_correlation && report.period_correlation.has_data) {
            html += this._renderPeriodCorrelation(report.period_correlation);
        }

        // Patterns
        if (report.patterns && report.patterns.length > 0) {
            html += '<div class="report-patterns">';
            html += '<h4>💡 分析洞察</h4><ul>';
            for (const p of report.patterns) {
                html += `<li>${p}</li>`;
            }
            html += '</ul></div>';
        }

        // Daily table
        if (report.daily_hours && report.daily_hours.length > 0) {
            html += '<h4 style="margin-bottom:8px;color:var(--text-muted);font-size:0.85rem;">📅 每日详情</h4>';
            html += '<table class="report-daily-table"><thead><tr>';
            html += '<th>日期</th><th>总时长</th><th>记录</th>';
            html += '</tr></thead><tbody>';

            const qualLabels = { good: '良好', average: '一般', poor: '较差' };
            const typeLabels = { night: '夜间', nap: '午睡', segment: '分段' };
            for (const d of report.daily_hours) {
                const recordDetails = (d.records || []).map(r => {
                    const typeLabel = typeLabels[r.type] || r.type;
                    return `<span class="daily-record-detail">${typeLabel} ${r.hours.toFixed(1)}h</span>`;
                }).join('');

                html += `<tr>
                    <td>${d.date}</td>
                    <td><strong>${d.hours.toFixed(1)}h</strong></td>
                    <td>${recordDetails || '—'}</td>
                </tr>`;
            }
            html += '</tbody></table>';
        }

        this.outputEl.innerHTML = html;
    }

    _renderPeriodCorrelation(corr) {
        const p = corr.period;
        const n = corr.non_period;
        const problemNames = {
            insomnia: '失眠', dreams: '多梦', sweats: '多汗',
            waking: '频醒', early_waking: '早醒'
        };

        const col = (title, cls, g) => {
            const cards = [];
            cards.push(this._statCard(g.avg_hours + 'h', '平均睡眠时长'));
            cards.push(this._statCard(g.good_rate + '%', '睡眠良好率'));
            if (g.avg_device_score != null) {
                cards.push(this._statCard(g.avg_device_score, '平均手环评分'));
            }
            if (g.avg_recovery_score != null) {
                cards.push(this._statCard(g.avg_recovery_score, '平均恢复分'));
            }
            return `<div class="pc-col ${cls}">
                <div class="pc-col-title">${title}（${g.days}天）</div>
                <div class="pc-cards">${cards.join('')}</div>
            </div>`;
        };

        let html = '<div class="period-correlation">';
        html += '<h4>🌸 经期 vs 非经期 · 睡眠对比</h4>';
        html += '<div class="pc-grid">';
        html += col('🌸 经期', 'pc-col--period', p);
        html += col('🌙 其他时间', 'pc-col--non', n);
        html += '</div>';

        // Insight text
        const dH = (p.avg_hours - n.avg_hours);
        const dG = (p.good_rate - n.good_rate);
        const parts = [];
        if (Math.abs(dH) >= 0.15) {
            parts.push(`经期平均睡眠比非经期${dH > 0 ? '多' : '少'}${Math.abs(dH).toFixed(1)}小时`);
        } else {
            parts.push('经期与非经期的平均睡眠时长接近');
        }
        if (Math.abs(dG) >= 3) {
            parts.push(`睡眠良好率${dG > 0 ? '高' : '低'}${Math.abs(dG).toFixed(0)}个百分点`);
        }
        if (parts.length) {
            html += `<div class="pc-insight">💡 ${parts.join('，')}。</div>`;
        }

        // Problem comparison (top problem per group)
        const topProblem = (g) => {
            const entries = Object.entries(g.problems || {});
            if (!entries.length) return null;
            entries.sort((a, b) => b[1] - a[1]);
            return { name: problemNames[entries[0][0]] || entries[0][0], count: entries[0][1] };
        };
        const tp = topProblem(p);
        const tn = topProblem(n);
        if (tp || tn) {
            html += '<div class="pc-problems">';
            html += `<span class="pc-problem pc-problem--period">🌸 经期最常见困扰：${tp ? tp.name + '（' + tp.count + '次）' : '无明显困扰'}</span>`;
            html += `<span class="pc-problem pc-problem--non">🌙 其他时间：${tn ? tn.name + '（' + tn.count + '次）' : '无明显困扰'}</span>`;
            html += '</div>';
        }

        html += '</div>';
        return html;
    }

    _statCard(value, label) {
        return `<div class="stat-card">
            <div class="stat-value">${value}</div>
            <div class="stat-label">${label}</div>
        </div>`;
    }

    _barRow(label, count, total, cssClass) {
        const pct = total > 0 ? Math.round(count / total * 100) : 0;
        return `<div class="bar-row">
            <span class="bar-label">${label}</span>
            <span class="bar-track"><span class="bar-fill ${cssClass}" style="width:${pct}%"></span></span>
            <span class="bar-count">${count}天</span>
        </div>`;
    }

    /* ── Scientific distribution cards ────────────────────────────── */

    _distCard({ icon, title, type, data, total, unit, max, insight }) {
        const nonZero = data.filter(d => d.count > 0);
        const viz = type === 'donut' && nonZero.length > 0
            ? this._donutViz(nonZero, total, unit)
            : this._barViz(data, max);
        const legend = this._distLegend(data, total, type, unit);
        return `<div class="dist-card">
            <div class="dist-card__head">
                <span class="dist-card__icon">${icon}</span>
                <span class="dist-card__title">${title}</span>
            </div>
            <div class="dist-card__body">
                <div class="dist-card__viz">${viz}</div>
                <div class="dist-card__legend">${legend}</div>
            </div>
            <div class="dist-card__insight">${insight}</div>
        </div>`;
    }

    _donutViz(data, total, unit) {
        if (!total || data.length === 0) {
            return '<div class="dist-donut dist-donut--empty">无数据</div>';
        }
        const r = 36;
        const c = 2 * Math.PI * r;
        let offset = 0;
        const segments = data.map(d => {
            const frac = d.count / total;
            const len = frac * c;
            const seg = `<circle cx="50" cy="50" r="${r}" fill="none" stroke="${d.color}" stroke-width="12"
                stroke-dasharray="${len.toFixed(2)} ${(c - len).toFixed(2)}"
                stroke-dashoffset="${-offset.toFixed(2)}"
                transform="rotate(-90 50 50)" />`;
            offset += len;
            return seg;
        }).join('');
        return `<svg class="dist-donut" viewBox="0 0 100 100">
            ${segments}
            <text x="50" y="47" text-anchor="middle" class="dist-donut__total">${total}</text>
            <text x="50" y="60" text-anchor="middle" class="dist-donut__unit">${unit}</text>
        </svg>`;
    }

    _barViz(data, max) {
        const rows = data.map(d => {
            const pct = max > 0 ? (d.count / max * 100).toFixed(1) : 0;
            return `<div class="dist-bar">
                <span class="dist-bar__label">${d.label}</span>
                <span class="dist-bar__track"><span class="dist-bar__fill" style="width:${pct}%;background:${d.color}"></span></span>
                <span class="dist-bar__count">${d.count}次</span>
            </div>`;
        }).join('');
        return `<div class="dist-bars">${rows}</div>`;
    }

    _distLegend(data, total, type, unit = '') {
        const rows = data.map(d => {
            const pct = total > 0 ? Math.round(d.count / total * 100) : 0;
            const countLabel = type === 'bar' ? `${d.count}次` : `${d.count}${unit}`;
            const pctCell = type === 'bar' ? '' : `<span class="dist-legend__pct">${pct}%</span>`;
            return `<div class="dist-legend__row">
                <span class="dist-legend__dot" style="background:${d.color}"></span>
                <span class="dist-legend__label">${d.label}</span>
                <span class="dist-legend__count">${countLabel}</span>
                ${pctCell}
            </div>`;
        }).join('');
        return `<div class="dist-legend">${rows}</div>`;
    }
}