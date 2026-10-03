/**
 * P2PDesk — AI-терминал P2P-стаканов (Telegram Mini App / web).
 * Bootstrap: тема → Telegram → экраны → фид.
 */
import { state, set, on, rollDay } from './core/store.js';
import { register, navigate, renderTabbar } from './core/router.js';
import { initTelegram, inTelegram } from './services/telegram.js';
import { startFeed } from './services/feed.js';
import { log } from './services/logs.js';
import { HomeScreen } from './screens/home.js';
import { P2PScreen } from './screens/p2p.js';
import { SettingsScreen } from './screens/settings.js';
import { ProfileScreen } from './screens/profile.js';
import { closeTopSheet, sheetOpen } from './ui/sheet.js';
import { qs } from './core/dom.js';

/* ---------- theme ---------- */
function applyTheme() {
  const t = state.settings.theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  qs('meta[name="theme-color"]')?.setAttribute('content', t === 'light' ? '#f2f3ef' : '#0a0c0d');
}

/* ---------- boot ---------- */
function boot() {
  applyTheme();
  on('settings', applyTheme);

  initTelegram();
  rollDay();

  if (state.settings.hideBalanceDefault) set('ui', (u) => { u.balanceHidden = true; });

  register('home', HomeScreen);
  register('p2p', P2PScreen);
  register('settings', SettingsScreen);
  register('profile', ProfileScreen);

  renderTabbar();
  navigate(state.ui.tab || 'home');

  log('info', 'sys', `P2PDesk запущен · ${inTelegram ? 'Telegram Mini App' : 'браузер'}`);
  startFeed();

  // Esc / browser back closes the top sheet
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sheetOpen()) { e.preventDefault(); closeTopSheet(); }
  });

  // pause the simulated feed while hidden to save battery
  document.addEventListener('visibilitychange', () => {
    log('info', 'sys', document.hidden ? 'приложение в фоне' : 'приложение активно');
  });

  if (!inTelegram) {
    console.info('%cP2PDesk', 'color:#d4ff3f;font-weight:700',
      'запущен вне Telegram — SDK в режиме заглушки, фид в режиме', state.settings.feedMode);
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

// expose for console debugging / e2e checks
window.__p2p = { state };
