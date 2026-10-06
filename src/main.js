/**
 * P2P Light — AI-терминал P2P-стаканов (Telegram Mini App / web).
 * Bootstrap: тема → Telegram → экраны → фид.
 */
import { state, set, on, rollDay } from './core/store.js';
import { register, navigate, renderTabbar } from './core/router.js';
import { initTelegram, inTelegram } from './services/telegram.js';
import { startFeed } from './services/feed.js';
import { log } from './services/logs.js';
import { HomeScreen } from './screens/home.js';
import { P2PScreen } from './screens/p2p.js';
import { TopScreen } from './screens/top.js';
import { SettingsScreen } from './screens/settings.js';
import { ProfileScreen } from './screens/profile.js';
import { closeTopSheet, sheetOpen } from './ui/sheet.js';
import { splashLeave, splashGuard } from './ui/splash.js';
import { openRegionSheet } from './ui/regionSheet.js';
import { qs } from './core/dom.js';

/* ---------- theme ---------- */
function applyTheme() {
  const t = state.settings.theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  qs('meta[name="theme-color"]')?.setAttribute('content', t === 'light' ? '#ffffff' : '#0b0c0f');
}

/* ---------- boot ---------- */
function boot() {
  splashGuard();                     // сплэш не должен залипнуть, если старт упадёт

  applyTheme();
  on('settings', applyTheme);

  initTelegram();
  rollDay();

  if (state.settings.hideBalanceDefault) set('ui', (u) => { u.balanceHidden = true; });

  register('home', HomeScreen);
  register('p2p', P2PScreen);
  register('top', TopScreen);
  register('settings', SettingsScreen);
  register('profile', ProfileScreen);

  renderTabbar();
  navigate(state.ui.tab || 'home');

  log('info', 'sys', `P2P Light запущен · ${inTelegram ? 'Telegram Mini App' : 'браузер'}`);

  startFeed();

  // первый вход: обязательный выбор региона (открывается под сплэшем)
  if (!state.region) openRegionSheet({ mandatory: true });

  // главный экран уже смонтирован под сплэшем — запускаем уход заставки
  splashLeave();

  // Esc / browser back closes the top sheet
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sheetOpen()) { e.preventDefault(); closeTopSheet(); }
  });

  document.addEventListener('visibilitychange', () => {
    log('info', 'sys', document.hidden ? 'приложение в фоне' : 'приложение активно');
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

// expose for console debugging / e2e checks
window.__p2p = { state };
