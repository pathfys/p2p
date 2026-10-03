import { h, icon, qs, mount, clear } from './dom.js';
import { state, set, on } from './store.js';
import { haptic } from '../services/telegram.js';

const TABS = [
  { id: 'home',     label: 'Главная',   icon: 'home',    title: 'P2PDESK',   sub: 'ai p2p terminal' },
  { id: 'p2p',      label: 'P2P',       icon: 'layers',  title: 'СТАКАНЫ',   sub: 'live order books' },
  { id: 'settings', label: 'Настройки', icon: 'sliders', title: 'НАСТРОЙКИ', sub: 'feed · trading · ai' },
  { id: 'profile',  label: 'Профиль',   icon: 'user',    title: 'ПРОФИЛЬ',   sub: 'kyc · plan · security' },
];

const screens = new Map();
let current = null;
let teardown = null;

export function register(id, factory) { screens.set(id, factory); }

export function navigate(tabId, params = {}) {
  if (!screens.has(tabId)) tabId = 'home';
  if (current === tabId && !params.force) return;

  teardown?.();
  teardown = null;

  current = tabId;
  set('ui', (u) => { u.tab = tabId; });

  const tab = TABS.find((t) => t.id === tabId);
  qs('#screen-title').textContent = tab.title;
  qs('#screen-sub').textContent = tab.sub;
  clear(qs('#topbar-slot'));

  const view = qs('#view');
  const built = screens.get(tabId)({ params, slot: qs('#topbar-slot') });
  const node = built?.node ?? built;
  teardown = built?.destroy ?? null;

  mount(view, h('div.screen', node));
  view.scrollTop = 0;
  window.scrollTo({ top: 0 });
  renderTabbar();
}

export function renderTabbar() {
  const bar = qs('#tabbar');
  mount(bar, TABS.map((t) => {
    const active = current === t.id;
    const needsKyc = t.id === 'profile' && state.kyc.status !== 'approved';
    return h('button.tab', {
      role: 'tab',
      'aria-current': active ? 'page' : null,
      'aria-selected': active ? 'true' : 'false',
      onClick: () => { haptic('select'); navigate(t.id); },
    }, icon(t.icon), h('span', t.label), needsKyc ? h('i.tab-dot') : null);
  }));
}

// the Профиль tab carries an alert dot until KYC is approved
on('kyc', () => { if (current) renderTabbar(); });

export const currentTab = () => current;
export { TABS };
