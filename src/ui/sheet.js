import { h, icon, qs, append } from '../core/dom.js';
import { haptic, setBackButton } from '../services/telegram.js';

const stack = [];

/**
 * openSheet({ title, body, foot, onClose }) -> { close, el, body }
 * body/foot accept a Node, an array of Nodes, or a builder fn receiving the api.
 */
export function openSheet({ title, subtitle, body, foot, onClose, dismissible = true } = {}) {
  const layers = qs('#layers');
  const scrim = h('div.scrim');
  const bodyEl = h('div.sheet-body');
  const footEl = foot ? h('div.sheet-foot') : null;

  const api = { close, el: null, bodyEl, footEl, setFoot, setBody };

  const closeBtn = h('button.btn.btn-icon.btn-ghost', { 'aria-label': 'Закрыть', onClick: () => close() }, icon('x'));
  const sheet = h('div.sheet', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Диалог' },
    h('div.sheet-grip', h('i')),
    h('div.sheet-head',
      h('div', { style: { flex: '1', minWidth: '0' } },
        h('h2', title || ''),
        subtitle ? h('div.t-xs.t-muted', { style: { marginTop: '1px' } }, subtitle) : null,
      ),
      dismissible ? closeBtn : null,
    ),
    bodyEl,
    footEl,
  );
  api.el = sheet;

  setBody(body);
  if (foot) setFoot(foot);

  if (dismissible) scrim.addEventListener('click', () => close());
  layers.append(scrim, sheet);
  document.body.style.overflow = 'hidden';
  haptic('light');

  const entry = { scrim, sheet, onClose, close };
  stack.push(entry);
  syncBack();

  // drag-to-dismiss on the grip area
  if (dismissible) attachDrag(sheet, close);

  function setBody(content) {
    bodyEl.replaceChildren();
    const c = typeof content === 'function' ? content(api) : content;
    if (c) append(bodyEl, [c]);
  }
  function setFoot(content) {
    if (!footEl) return;
    footEl.replaceChildren();
    const c = typeof content === 'function' ? content(api) : content;
    if (c) append(footEl, [c]);
  }

  function close(result) {
    const i = stack.indexOf(entry);
    if (i === -1) return;
    stack.splice(i, 1);
    sheet.classList.add('is-out');
    scrim.style.animation = 'fade-in .2s reverse both';
    setTimeout(() => { sheet.remove(); scrim.remove(); }, 240);
    if (!stack.length) document.body.style.overflow = '';
    syncBack();
    onClose?.(result);
  }

  return api;
}

function syncBack() {
  const top = stack[stack.length - 1];
  setBackButton(Boolean(top), () => top?.close());
}

function attachDrag(sheet, close) {
  let y0 = null, dy = 0;
  const grip = sheet.querySelector('.sheet-grip');
  const head = sheet.querySelector('.sheet-head');
  const start = (e) => { y0 = e.touches ? e.touches[0].clientY : e.clientY; sheet.style.transition = 'none'; };
  const move = (e) => {
    if (y0 === null) return;
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    dy = Math.max(0, y - y0);
    sheet.style.transform = `translateY(${dy}px)`;
  };
  const end = () => {
    if (y0 === null) return;
    sheet.style.transition = 'transform .26s cubic-bezier(.16,1,.3,1)';
    if (dy > 110) close(); else sheet.style.transform = '';
    y0 = null; dy = 0;
  };
  for (const el of [grip, head]) {
    if (!el) continue;
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: true });
    el.addEventListener('touchend', end);
  }
}

export function closeTopSheet() { stack[stack.length - 1]?.close(); }
export const sheetOpen = () => stack.length > 0;

/** Simple confirm dialog built on the sheet. */
export function confirmSheet({ title, message, confirmLabel = 'Подтвердить', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const s = openSheet({
      title,
      body: h('div.t-sm.t-dim', { style: { lineHeight: '1.5' } }, message),
      foot: [
        h('button.btn.btn-ghost', { onClick: () => { done = true; s.close(); resolve(false); } }, 'Отмена'),
        h(`button.btn.${danger ? 'btn-danger' : 'btn-primary'}`, { onClick: () => { done = true; s.close(); resolve(true); } }, confirmLabel),
      ],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}
