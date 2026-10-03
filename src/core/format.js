/** Number / money / time formatting. */

const nf = (min, max) => new Intl.NumberFormat('ru-RU', { minimumFractionDigits: min, maximumFractionDigits: max });

export const fmt2 = (n) => nf(2, 2).format(Number(n) || 0);
export const fmt0 = (n) => nf(0, 0).format(Math.round(Number(n) || 0));
export const fmtN = (n, d = 2) => nf(d, d).format(Number(n) || 0);

/** 1 234 567.89 -> "1.23M" for dense tiles */
export function compact(n) {
  const v = Math.abs(Number(n) || 0);
  if (v >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return fmtN(n, 2);
}

/** Split for the hero: "12 345" + ".67" */
export function splitAmount(n, d = 2) {
  const s = fmtN(n, d);
  const sep = s.lastIndexOf(',');
  return sep === -1 ? [s, ''] : [s.slice(0, sep), s.slice(sep)];
}

export const pct = (n, d = 2) => `${n > 0 ? '+' : ''}${fmtN(n, d)}%`;

export const money = (n, cur, d = 2) => `${fmtN(n, d)} ${cur}`;

export function hhmmss(ts = Date.now()) {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':');
}

export function ms(ts = Date.now()) {
  return hhmmss(ts) + '.' + String(new Date(ts).getMilliseconds()).padStart(3, '0');
}

export function dateTime(ts) {
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ts));
}

export function ago(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 10) return 'только что';
  if (s < 60) return `${s} с назад`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин назад`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return `${hr} ч назад`;
  return `${Math.floor(hr / 24)} дн назад`;
}

export const mask = (s, keep = 4) => '•••• ' + String(s).slice(-keep);

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const uid = (p = 'id') => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
