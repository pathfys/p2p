/**
 * Telegram WebApp adapter with a browser fallback, so the app is testable
 * outside Telegram (desktop browser) and native-feeling inside it.
 */
import { state, set } from '../core/store.js';

const tg = typeof window !== 'undefined' ? window.Telegram?.WebApp : null;
export const inTelegram = Boolean(tg?.initData !== undefined && tg?.platform && tg.platform !== 'unknown');

export function initTelegram() {
  if (!tg) return;
  try {
    tg.ready();
    tg.expand();
    if (tg.disableVerticalSwipes) tg.disableVerticalSwipes();
    if (tg.setHeaderColor) tg.setHeaderColor('#0a0c0d');
    if (tg.setBackgroundColor) tg.setBackgroundColor('#0a0c0d');

    const u = tg.initDataUnsafe?.user;
    if (u) {
      set('profile', (p) => {
        p.tgId = u.id;
        p.name = [u.first_name, u.last_name].filter(Boolean).join(' ') || p.name;
        p.handle = u.username ? '@' + u.username : p.handle;
        p.photo = u.photo_url || p.photo;
      });
    }
  } catch (e) { console.warn('[tg] init', e); }
}

export function haptic(kind = 'light') {
  if (!state.settings.haptics) return;
  const hf = tg?.HapticFeedback;
  if (!hf) return;
  try {
    if (kind === 'success' || kind === 'error' || kind === 'warning') hf.notificationOccurred(kind);
    else if (kind === 'select') hf.selectionChanged();
    else hf.impactOccurred(kind);
  } catch { /* noop */ }
}

/** Back button is wired to closing the top layer (sheet) when one is open. */
export function setBackButton(visible, handler) {
  const bb = tg?.BackButton;
  if (!bb) return;
  try {
    bb.offClick();
    if (visible) { bb.onClick(handler); bb.show(); } else bb.hide();
  } catch { /* noop */ }
}

export function closeApp() { try { tg?.close(); } catch { /* noop */ } }

/** initData must be verified server-side (HMAC with the bot token) before trusting it. */
export const initData = tg?.initData || '';
