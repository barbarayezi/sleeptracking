/* agent.js — 把「AI 分析」区块接入主应用自带的跨日简报对话能力
 * （GET /api/daily-brief 生成 + POST /api/daily-brief/chat 追问），
 * 不再依赖外部 health-agent 服务（5188 端口）。
 *
 * 与 meal.js 中饮食区块的「生成昨日汇总」共用同一张 brief_chat_messages 表，
 * 因此这里的对话历史可在刷新 / 换设备后通过 GET /api/daily-brief/chat 恢复。
 */
(function () {
  'use strict';

  const generateBtn = document.getElementById('btn-agent-generate');
  const statusEl = document.getElementById('agent-status');
  const resultEl = document.getElementById('agent-result');
  if (!generateBtn || !statusEl || !resultEl) return;

  let briefData = null;   // 最近一次生成的简报 { date, meal_summary, morning, brief }
  let messages = [];      // 对话气泡 [{ role:'user'|'ai', text }]

  const SUGGESTIONS = [
    '今天我该怎么吃更稳血糖？',
    '昨晚睡眠为什么不好？',
    '这周体重趋势怎么看？',
    '给我一个今天的饮食建议',
  ];

  function todayStr() {
    const d = new Date();
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function setStatus(text, isError) {
    statusEl.textContent = text || '';
    statusEl.classList.toggle('error', !!isError);
  }

  function render() {
    if (!briefData && !messages.length) {
      resultEl.classList.add('hidden');
      return;
    }

    const diet = (briefData && briefData.meal_summary) || {};
    const m = (briefData && briefData.morning) || {};
    const chips = [];
    if (diet.meal_count) chips.push(`昨日 ${diet.meal_count} 餐 · ${Math.round(diet.kcal)} kcal`);
    if (m.weight != null) chips.push(`体重 ${m.weight} kg`);
    if (m.water_cups != null) chips.push(`饮水 ${m.water_cups} 杯`);
    if (m.steps != null) chips.push(`步数 ${m.steps}`);
    if (m.sleep_minutes != null) chips.push(`睡眠 ${Math.floor(m.sleep_minutes / 60)}h${m.sleep_minutes % 60}m`);
    const chipHtml = chips.length
      ? `<div class="brief-chips">${chips.map((c) => `<span class="brief-chip">${esc(c)}</span>`).join('')}</div>`
      : '';

    const msgsHtml = messages.map((msg) => {
      const cls = msg.role === 'user' ? 'brief-msg brief-msg--user' : 'brief-msg brief-msg--ai';
      const icon = msg.role === 'user' ? '🧑' : '🤖';
      return `<div class="${cls}"><span class="brief-msg__icon">${icon}</span>`
        + `<div class="brief-msg__bubble">${esc(msg.text).replace(/\n/g, '<br>')}</div></div>`;
    }).join('');

    const suggestHtml = `<div class="agent-suggest">`
      + SUGGESTIONS.map((s) => `<button type="button" class="agent-suggest-chip">${esc(s)}</button>`).join('')
      + `</div>`;

    resultEl.innerHTML = `
      ${chipHtml}
      <div class="brief-chat" id="agent-chat-messages">${msgsHtml}</div>
      ${suggestHtml}
      <div class="brief-input-row">
        <input type="text" id="agent-chat-input" class="brief-chat-input"
               placeholder="对今日分析有疑问或补充？直接说…" autocomplete="off">
        <button type="button" id="agent-chat-send" class="btn btn-ai">发送</button>
      </div>
      <div class="brief-input-hint">按 Enter 发送，AI 会基于你的数据继续回复</div>
    `;
    resultEl.classList.remove('hidden');

    const input = resultEl.querySelector('#agent-chat-input');
    const send = resultEl.querySelector('#agent-chat-send');
    if (input && send) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
      });
      send.addEventListener('click', sendChat);
    }
    resultEl.querySelectorAll('.agent-suggest-chip').forEach((b) => {
      b.addEventListener('click', () => {
        const inp = resultEl.querySelector('#agent-chat-input');
        if (inp) { inp.value = b.textContent; inp.focus(); }
      });
    });

    const c = resultEl.querySelector('#agent-chat-messages');
    if (c) c.scrollTop = c.scrollHeight;
  }

  async function generate() {
    const date = todayStr();
    const orig = generateBtn.textContent;
    generateBtn.disabled = true;
    generateBtn.textContent = '🤖 生成中…';
    setStatus('');
    try {
      const resp = await fetch(`/api/daily-brief?date=${encodeURIComponent(date)}`);
      const data = await resp.json();
      if (!resp.ok) {
        setStatus(data.error || '生成失败', true);
        return;
      }
      briefData = data;
      messages = [{ role: 'ai', text: (data.brief || '').trim() }];
      render();
    } catch (err) {
      setStatus('网络错误：' + err.message, true);
    } finally {
      generateBtn.disabled = false;
      generateBtn.textContent = orig;
    }
  }

  async function sendChat() {
    const input = resultEl.querySelector('#agent-chat-input');
    const send = resultEl.querySelector('#agent-chat-send');
    if (!input || !send) return;
    const text = input.value.trim();
    if (!text) return;
    if (!briefData || !briefData.brief) {
      setStatus('请先点击「生成今日分析」', true);
      return;
    }

    const history = messages.map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.text,
    }));

    messages.push({ role: 'user', text });
    input.value = '';
    input.disabled = true;
    send.disabled = true;
    send.textContent = '回复中…';
    render();

    try {
      const resp = await fetch('/api/daily-brief/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: todayStr(),
          previous_brief: briefData.brief,
          user_message: text,
          history,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        messages.push({ role: 'ai', text: `❌ ${data.error || '回复失败'}` });
      } else {
        messages.push({ role: 'ai', text: (data.reply || '').trim() });
      }
    } catch (err) {
      messages.push({ role: 'ai', text: `❌ 网络错误：${err.message}` });
    } finally {
      render();
      const ni = resultEl.querySelector('#agent-chat-input');
      const ns = resultEl.querySelector('#agent-chat-send');
      if (ni) { ni.disabled = false; ni.focus(); }
      if (ns) { ns.disabled = false; ns.textContent = '发送'; }
      const c = resultEl.querySelector('#agent-chat-messages');
      if (c) c.scrollTop = c.scrollHeight;
    }
  }

  /** 恢复今日已存在的对话历史（跨刷新 / 换设备持久化）。 */
  async function restore() {
    const date = todayStr();
    try {
      const resp = await fetch(`/api/daily-brief/chat?date=${encodeURIComponent(date)}`);
      const data = await resp.json();
      if (!resp.ok || !Array.isArray(data.history) || !data.history.length) return;
      // 历史首条 assistant 即为原始简报
      const first = data.history[0];
      briefData = { brief: first.role === 'assistant' ? (first.content || '') : '' };
      messages = data.history.map((h) => ({ role: h.role, text: h.content || '' }));
      render();
    } catch (e) {
      /* 恢复失败不影响手动生成 */
    }
  }

  generateBtn.addEventListener('click', generate);
  // 进入页面即尝试恢复已有对话；没有历史则保持空状态，等用户点「生成今日分析」
  restore();
})();
