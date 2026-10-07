// 通用弹窗容器：栈式管理，支持 Esc 关闭与焦点回归。
//
// ⚠️ 历史 bug（用户报的"新建界面有时候退不出来，点取消和 ✕ 都没反应"）：
//
//   旧实现用 `clear(host)` 把 host 的 DOM 全清掉再放新弹窗，**但没有清 stack**。
//   于是「第一个没关就又开了第二个」时：
//     · DOM 上只剩第二个弹窗（第一个被 clear 掉了）
//     · 但 stack = [第一个, 第二个]
//     · 关掉第二个 → 只摘掉自己 → stack 还剩第一个 → `host.hidden` 不设
//       → 屏幕上那个弹窗怎么点都关不掉
//   单开一个弹窗时永远正常，所以用户感觉是"有时候"。
//
//   而且**嵌套是故意的**：editor 里 `await confirmDialog(...)` 需要编辑框和确认框
//   同时在屏上。所以修法不是"覆盖式"（开新的就清空栈），而是：
//   **每个弹窗持有自己的 DOM 节点** —— 打开时 append 到 host，关闭时
//   `remove()` 掉自己那两个节点，host 只在栈空时隐藏。
//   这样嵌套时后开的自然叠在上面（DOM 顺序靠后），关掉上面那个不影响下面。
import { $, append, clear, el } from './dom.js';

let stack = [];

export function openModal({ title, body, footer, onClose, width }) {
  const host = $('#modal-host');
  const mask = el('div.modal-mask');
  const panel = el('div.modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  if (width) panel.style.width = `min(${width}, calc(100vw - 32px))`;

  const head = el('div.modal-head', {}, [
    el('h2', { text: title }),
    el('button.icon-btn', { 'aria-label': '关闭', text: '✕', onclick: () => close() }),
  ]);
  const bodyNode = el('div.modal-body', {}, body);
  panel.append(head, bodyNode);

  if (footer) panel.appendChild(el('div.modal-foot', {}, footer));

  // 关键：只 append 自己的节点，**不 clear(host)** —— 否则会把下面那层弹窗的
  // DOM 抹掉，而它在栈里还留着，就成了关不掉的僵尸。
  host.hidden = false;
  host.append(mask, panel);

  const entry = { panel, mask, onClose };
  // 点遮罩关掉**自己这一层**（用 close 而不是裸的 closeTop，
  // 保证点的是谁的遮罩就关谁，不会误关上层）
  mask.addEventListener('click', () => close('mask'));

  stack.push(entry);
  const firstInput = panel.querySelector('input, textarea, select, button.btn-primary');
  if (firstInput) setTimeout(() => firstInput.focus(), 30);

  function close(reason = 'close') {
    const idx = stack.indexOf(entry);
    if (idx < 0) return;                 // 已经关过了（按钮和 onClose 可能都调一次）
    stack.splice(idx, 1);
    // 摘掉自己的两个节点。用 remove() 而不是 clear(host)，
    // 这样下面那层弹窗的 DOM 不会被一起抹掉。
    try { mask.remove(); } catch (_) { /* 老浏览器兜底 */ }
    try { panel.remove(); } catch (_) { /* 老浏览器兜底 */ }
    if (!stack.length) { clear(host); host.hidden = true; }
    if (onClose) { try { onClose(reason); } catch (e) { console.error(e); } }
  }

  panel.close = close;
  return { panel, body: bodyNode, close };
}

export function closeTop() {
  const top = stack[stack.length - 1];
  if (top) top.panel.close?.();
  return !!top;
}

export function isModalOpen() { return stack.length > 0; }

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && stack.length) {
    e.preventDefault();
    closeTop();
  }
});

/** 轻量确认框（替代 confirm） */
export function confirmDialog({ title, message, confirmText = '确定', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const ctl = openModal({
      title,
      width: '400px',
      body: [el('p', { text: message, style: { fontSize: '13.5px' } })],
      footer: [
        el('div.spacer'),
        el('button.btn', { text: '取消', onclick: () => { done(false); ctl.close(); } }),
        el(`button.btn.${danger ? 'btn-danger' : 'btn-primary'}`, {
          text: confirmText,
          onclick: () => { done(true); ctl.close(); },
        }),
      ],
      onClose: () => done(false),
    });
  });
}

export { append };
