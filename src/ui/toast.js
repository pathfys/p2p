import { h, icon, qs } from '../core/dom.js';
import { haptic } from '../services/telegram.js';

const ICON_BY_KIND = { ok: 'check', err: 'alert', warn: 'alert', info: 'info' };

export function toast(title, body, kind = 'info', ttl = 3200) {
  const host = qs('#toasts');
  if (!host) return;
  const el = h('div.toast', { class: kind, role: 'status' },
    icon(ICON_BY_KIND[kind] || 'info', { class: kind === 'ok' ? 't-buy' : kind === 'err' ? 't-sell' : kind === 'warn' ? 't-warn' : 't-acid' }),
    h('div', h('div.tt', title), body ? h('div.tb', body) : null),
  );
  host.append(el);
  haptic(kind === 'ok' ? 'success' : kind === 'err' ? 'error' : kind === 'warn' ? 'warning' : 'light');
  setTimeout(() => {
    el.classList.add('is-out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, ttl);
  while (host.children.length > 3) host.firstChild.remove();
}
