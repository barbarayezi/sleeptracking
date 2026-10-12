/**
 * DatePicker — 顶栏日期标签点击弹出「按月翻页」日历。
 *
 * 交互：
 *  - 点击顶栏 #current-date-label 弹出日历浮层，可 ‹/› 翻月、«/» 翻年，
 *    点任意日期跳转（走 App.setDate 统一刷新所有模块）。
 *  - 高亮今天与当前选中日期；「今天」按钮一键回到今天。
 *  - 点击浮层外部 / Esc 关闭。
 */
(function () {
    'use strict';

    let popup = null;          // 浮层根节点（懒创建，全局唯一）
    let viewY = 0, viewM = 0;  // 当前展示的年 / 月（M: 1-12）
    let isOpen = false;

    function fmt(y, m, d) {
        return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }

    function todayStr() {
        const t = new Date();
        return fmt(t.getFullYear(), t.getMonth() + 1, t.getDate());
    }

    function selectedDate() {
        return (typeof App !== 'undefined' && App.currentDate) || todayStr();
    }

    function ensurePopup() {
        if (popup) return;
        popup = document.createElement('div');
        popup.className = 'date-picker-pop hidden';
        popup.addEventListener('click', (e) => e.stopPropagation());  // 防止点内部冒泡到 document 关闭
        document.body.appendChild(popup);
    }

    /** 重建某年某月的日历网格。 */
    function render() {
        const today = todayStr();
        const selected = selectedDate();

        // 标题 + 年/月翻页
        const head = document.createElement('div');
        head.className = 'dp-head';
        head.innerHTML = `
            <button type="button" class="dp-nav" data-act="prev-year" title="上一年">&laquo;</button>
            <button type="button" class="dp-nav" data-act="prev-month" title="上一月">&lsaquo;</button>
            <span class="dp-title">${viewY} 年 ${viewM} 月</span>
            <button type="button" class="dp-nav" data-act="next-month" title="下一月">&rsaquo;</button>
            <button type="button" class="dp-nav" data-act="next-year" title="下一年">&raquo;</button>`;
        popup.innerHTML = '';
        popup.appendChild(head);

        // 星期表头（周一开始）
        const week = document.createElement('div');
        week.className = 'dp-week';
        week.innerHTML = ['一', '二', '三', '四', '五', '六', '日']
            .map((w) => `<span class="dp-wcell">${w}</span>`).join('');
        popup.appendChild(week);

        // 日期网格：首列偏移（周一=0），共 6 行保证月份对齐稳定
        const grid = document.createElement('div');
        grid.className = 'dp-grid';
        const first = new Date(viewY, viewM - 1, 1);
        const lead = (first.getDay() + 6) % 7;
        const daysInMonth = new Date(viewY, viewM, 0).getDate();
        const prevMonthDays = new Date(viewY, viewM - 1, 0).getDate();
        const totalCells = Math.ceil((lead + daysInMonth) / 7) * 7;

        for (let i = 0; i < totalCells; i++) {
            const cell = document.createElement('button');
            cell.type = 'button';
            cell.className = 'dp-day';
            let y, m, d;
            if (i < lead) {
                d = prevMonthDays - lead + 1 + i;
                m = viewM - 1; y = viewY;
                if (m < 1) { m = 12; y -= 1; }
                cell.classList.add('dp-outside');
            } else if (i < lead + daysInMonth) {
                d = i - lead + 1; m = viewM; y = viewY;
            } else {
                d = i - (lead + daysInMonth) + 1;
                m = viewM + 1; y = viewY;
                if (m > 12) { m = 1; y += 1; }
                cell.classList.add('dp-outside');
            }
            const ds = fmt(y, m, d);
            cell.textContent = d;
            cell.dataset.date = ds;
            if (ds === today) cell.classList.add('dp-today');
            if (ds === selected) cell.classList.add('dp-selected');
            grid.appendChild(cell);
        }
        popup.appendChild(grid);

        // 底部：回到今天 + 关闭
        const foot = document.createElement('div');
        foot.className = 'dp-foot';
        foot.innerHTML = `
            <button type="button" class="dp-today-btn">今天</button>
            <button type="button" class="dp-close-btn">关闭</button>`;
        popup.appendChild(foot);
    }

    function position() {
        const label = document.getElementById('current-date-label');
        if (!label) return;
        const r = label.getBoundingClientRect();
        popup.style.visibility = 'hidden';
        popup.classList.remove('hidden');
        const pw = popup.offsetWidth, ph = popup.offsetHeight;
        let left = Math.min(r.left + window.scrollX, window.scrollX + window.innerWidth - pw - 8);
        left = Math.max(8, left);
        let top = r.bottom + window.scrollY + 6;
        if (top + ph > window.scrollY + window.innerHeight - 8) {
            top = r.top + window.scrollY - ph - 6;  // 底部放不下则弹到上方
        }
        popup.style.left = `${Math.round(left)}px`;
        popup.style.top = `${Math.round(top)}px`;
        popup.style.visibility = '';
    }

    function open() {
        ensurePopup();
        const cur = selectedDate();
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cur);
        viewY = m ? Number(m[1]) : new Date().getFullYear();
        viewM = m ? Number(m[2]) : new Date().getMonth() + 1;
        render();
        position();
        isOpen = true;
    }

    function close() {
        if (!popup) return;
        popup.classList.add('hidden');
        isOpen = false;
    }

    function toggle() {
        if (isOpen) { close(); return; }
        open();
    }

    function init() {
        const label = document.getElementById('current-date-label');
        if (!label) return;
        label.classList.add('date-label-clickable');
        label.title = '点击选择日期';

        label.addEventListener('click', (e) => {
            e.stopPropagation();
            toggle();
        });

        // 浮层内事件：翻页 / 选日期 / 今天 / 关闭（事件委托）
        popup = null;
        ensurePopup();
        popup.addEventListener('click', (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;
            const act = btn.dataset.act;
            if (act === 'prev-year') { viewY -= 1; render(); position(); return; }
            if (act === 'next-year') { viewY += 1; render(); position(); return; }
            if (act === 'prev-month') { viewM -= 1; if (viewM < 1) { viewM = 12; viewY -= 1; } render(); position(); return; }
            if (act === 'next-month') { viewM += 1; if (viewM > 12) { viewM = 1; viewY += 1; } render(); position(); return; }
            if (btn.classList.contains('dp-day')) {
                const ds = btn.dataset.date;
                close();
                if (ds && typeof App !== 'undefined' && App.setDate) App.setDate(ds);
                return;
            }
            if (btn.classList.contains('dp-today-btn')) {
                close();
                if (typeof App !== 'undefined' && App.setDate) App.setDate(todayStr());
                return;
            }
            if (btn.classList.contains('dp-close-btn')) { close(); }
        });

        document.addEventListener('click', (e) => {
            if (isOpen && popup && !popup.contains(e.target) && e.target !== label) close();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && isOpen) close();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
