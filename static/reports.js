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

        // Breakdown
        html += '<div class="report-breakdown">';

        // Quality breakdown
        html += '<div class="breakdown-group">';
        html += '<h4>😴 睡眠质量分布</h4>';
        html += '<div class="breakdown-bars">';
        html += this._barRow('良好', report.quality_breakdown.good, report.total_days_recorded, 'good');
        html += this._barRow('一般', report.quality_breakdown.average, report.total_days_recorded, 'average');
        html += this._barRow('较差', report.quality_breakdown.poor, report.total_days_recorded, 'poor');
        html += '</div></div>';

        // Classification breakdown
        html += '<div class="breakdown-group">';
        html += '<h4>⏰ 入睡分类</h4>';
        html += '<div class="breakdown-bars">';
        html += this._barRow('早睡', report.classification_breakdown.early, report.total_records, 'early');
        html += this._barRow('晚睡', report.classification_breakdown.late, report.total_records, 'late');
        html += '</div></div>';

        html += '</div>';

        // Type breakdown
        if (report.type_breakdown) {
            html += '<div class="report-breakdown">';
            html += '<div class="breakdown-group">';
            html += '<h4>🏷️ 记录类型</h4>';
            html += '<div class="breakdown-bars">';
            html += this._barRow('夜间睡眠', report.type_breakdown.night, report.total_records, 'night');
            html += this._barRow('午睡', report.type_breakdown.nap, report.total_records, 'nap');
            html += this._barRow('分段睡眠', report.type_breakdown.segment, report.total_records, 'segment');
            html += '</div></div>';
            html += '</div>';
        }

        // Problem frequency
        if (report.problem_frequency && Object.keys(report.problem_frequency).length > 0) {
            const problemNames = {
                insomnia: '失眠', dreams: '多梦', sweats: '多汗',
                waking: '频醒', early_waking: '早醒'
            };
            html += '<div class="breakdown-group" style="margin-bottom:16px;">';
            html += '<h4>⚠️ 睡眠问题频率</h4>';
            html += '<div class="breakdown-bars">';
            for (const [key, count] of Object.entries(report.problem_frequency).sort((a, b) => b[1] - a[1])) {
                const name = problemNames[key] || key;
                const pct = report.total_days_recorded > 0
                    ? Math.round(count / report.total_days_recorded * 100) : 0;
                html += `<div class="bar-row">
                    <span class="bar-label">${name}</span>
                    <span class="bar-track"><span class="bar-fill poor" style="width:${pct}%"></span></span>
                    <span class="bar-count">${count}次</span>
                </div>`;
            }
            html += '</div></div>';
        }

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
}