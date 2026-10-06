/**
 * Deal-context analysis ("AI-слой").
 *
 * Deterministic, explainable scoring — every verdict ships with the factors
 * and weights that produced it, so a B2B user can audit why an offer was
 * recommended or rejected. Weights are user-tunable in Настройки → AI.
 */
import { state, PAY_METHODS } from '../core/store.js';
import { EX, AST, assetRate } from '../data/exchanges.js';

const METHOD_RISK = Object.fromEntries(PAY_METHODS.map((m) => [m.id, m.risk]));
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Volume in USDT → amount of the traded asset. */
export function usdtToAsset(volumeUsdt, asset, fiat) {
  if (asset === 'USDT') return volumeUsdt;
  const usdtUnit = assetRate('USDT', fiat);
  const assetUnit = assetRate(asset, fiat);
  return assetUnit ? (volumeUsdt * usdtUnit) / assetUnit : 0;
}

export function assetToUsdt(amount, asset, fiat) {
  if (asset === 'USDT') return amount;
  const usdtUnit = assetRate('USDT', fiat);
  const assetUnit = assetRate(asset, fiat);
  return usdtUnit ? (amount * assetUnit) / usdtUnit : 0;
}

/* ------------------------------ components ------------------------------ */

function reputationScore(m) {
  const completion = clamp01((m.completion - 0.8) / 0.199);
  const volume = clamp01(Math.log10(Math.max(1, m.orders)) / 4);       // 10k orders ≈ 1.0
  const rating = clamp01((m.rating - 4) / 1);
  const trust = (m.verified ? 0.6 : 0) + (m.pro ? 0.4 : 0);
  return clamp01(completion * 0.4 + volume * 0.25 + rating * 0.15 + trust * 0.2);
}

function priceScore(offer, market) {
  if (!market.median) return 0.5;
  const dev = (offer.price - market.median) / market.median;   // negative = cheaper
  const favourable = offer.side === 'buy' ? -dev : dev;        // buying: cheaper is better
  // map −1.5% … +1.5% onto 0…1
  return clamp01(0.5 + favourable / 0.03);
}

function liquidityScore(offer, assetAmount, fiatNeeded) {
  const cover = clamp01(offer.available / Math.max(1e-9, assetAmount));
  const fitsMin = fiatNeeded >= offer.min;
  const fitsMax = fiatNeeded <= offer.max;
  let s = cover * 0.7;
  s += fitsMin ? 0.15 : 0;
  s += fitsMax ? 0.15 : 0;
  return clamp01(s);
}

function methodScore(methods) {
  if (!methods?.length) return 0.5;
  const risks = methods.map((m) => METHOD_RISK[m] ?? 0.25);
  return clamp01(1 - Math.min(...risks) * 2.2);
}

function speedScore(m) {
  const s = clamp01(1 - (m.avgReleaseMin - 1) / 14);
  return m.online ? s : s * 0.55;
}

function exchangeScore(exId) {
  const r = EX[exId]?.reliability ?? 0.85;
  const wire = state.wires[exId];
  const penalty = wire?.state === 'live' ? 0 : wire?.state === 'connecting' ? 0.12 : 0.25;
  return clamp01((r - 0.8) / 0.2 - penalty);
}

/* ------------------------------ main ------------------------------ */

/**
 * analyze(offer, volumeUsdt) → full deal context.
 */
export function analyze(offer, volumeUsdt = state.settings.volume) {
  const s = state.settings;
  const market = state.market;
  const assetAmount = usdtToAsset(volumeUsdt, offer.asset, offer.fiat);
  const fillable = Math.min(assetAmount, offer.available);
  const fiatNeeded = assetAmount * offer.price;

  const comps = {
    reputation: reputationScore(offer.merchant),
    price: priceScore(offer, market),
    liquidity: liquidityScore(offer, assetAmount, fiatNeeded),
    method: methodScore(offer.methods),
    speed: speedScore(offer.merchant),
    exchange: exchangeScore(offer.exchange),
  };

  const w = s.weights;
  const wSum = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  let score = 0;
  for (const [k, v] of Object.entries(comps)) score += v * (w[k] ?? 0);
  score = (score / wSum) * 100;

  /* ---- hard blockers & flags ---- */
  const flags = [];
  let blocker = null;

  if (offer.merchant.blocked) {
    blocker = { code: 'blocked', text: 'Мерчант в блоклисте платформы' };
  }
  if (fiatNeeded < offer.min) {
    blocker = blocker || { code: 'under_min', text: `Объём ниже лимита офера (мин. ${Math.round(offer.min)} ${offer.fiat})` };
  }
  if (fiatNeeded > offer.max) {
    flags.push({ level: 'warn', text: `Объём выше лимита офера (макс. ${Math.round(offer.max)} ${offer.fiat}) — нужен сплит` });
  }
  if (offer.available < assetAmount) {
    flags.push({ level: 'warn', text: `Ликвидности хватает на ${(offer.available / assetAmount * 100).toFixed(0)}% объёма` });
  }
  if ((offer.kycRequired || 0) > state.kyc.level) {
    blocker = blocker || { code: 'kyc', text: `Мерчант требует KYC уровня ${offer.kycRequired}, у вас ${state.kyc.level}` };
  }
  if (!offer.merchant.online) flags.push({ level: 'warn', text: 'Мерчант офлайн — ответ может занять часы' });
  if (offer.merchant.completion < 0.9) flags.push({ level: 'warn', text: `Низкий процент исполнения: ${(offer.merchant.completion * 100).toFixed(1)}%` });
  if (offer.merchant.orders < 100) flags.push({ level: 'warn', text: `Мало сделок у мерчанта: ${offer.merchant.orders}` });

  // price anomaly: suspiciously generous ads are the classic scam pattern
  const dev = market.median ? ((offer.price - market.median) / market.median) * 100 : 0;
  const favourableDev = offer.side === 'buy' ? -dev : dev;
  if (favourableDev > 2.2) {
    flags.push({ level: 'alert', text: `Цена на ${favourableDev.toFixed(2)}% лучше рынка — аномалия, проверьте мерчанта` });
    score *= 0.72;
  }
  const highRisk = offer.methods.filter((m) => (METHOD_RISK[m] ?? 0) > 0.2);
  if (highRisk.length === offer.methods.length && highRisk.length) {
    flags.push({ level: 'warn', text: 'Только высокорисковые способы оплаты' });
  }
  if (offer.merchant.avgReleaseMin > 10) flags.push({ level: 'warn', text: `Среднее время отпуска ${offer.merchant.avgReleaseMin} мин` });

  const stale = Date.now() - offer.ts;
  if (stale > 15000) flags.push({ level: 'warn', text: `Котировка не обновлялась ${Math.round(stale / 1000)} с` });

  /* ---- economics ---- */
  const feePct = s.exchangeFee || 0;
  const bestPrice = market.best || offer.price;
  const slippagePct = bestPrice ? Math.abs((offer.price - bestPrice) / bestPrice) * 100 : 0;
  const grossFiat = fillable * offer.price;
  const feeFiat = grossFiat * (feePct / 100);
  const totalFiat = offer.side === 'buy' ? grossFiat + feeFiat : grossFiat - feeFiat;
  const effPrice = fillable ? totalFiat / fillable : 0;

  // exit at the target margin set in Настройки → Трейдинг
  const exitPrice = offer.side === 'buy'
    ? effPrice * (1 + s.targetMargin / 100)
    : effPrice * (1 - s.targetMargin / 100);
  const profitFiat = Math.abs(exitPrice - effPrice) * fillable - feeFiat;
  const profitUsdt = profitFiat / (assetRate('USDT', offer.fiat) || 1);

  /* ---- verdict ---- */
  const confidence = Math.round(clamp01(
    0.45 + comps.reputation * 0.25 + comps.exchange * 0.15 + (market.median ? 0.15 : 0)
  ) * 100);

  let verdict;
  if (blocker) {
    verdict = { key: 'blocked', title: 'Сделка недоступна', color: 'var(--sell)', ghost: 'var(--sell-ghost)', icon: 'x' };
  } else if (flags.some((f) => f.level === 'alert') && s.autoRejectRisky) {
    verdict = { key: 'avoid', title: 'Высокий риск', color: 'var(--sell)', ghost: 'var(--sell-ghost)', icon: 'alert' };
  } else if (score >= 78 && slippagePct <= s.slippageTol) {
    verdict = { key: 'strong', title: 'Сильная сделка', color: 'var(--buy)', ghost: 'var(--buy-ghost)', icon: 'zap' };
  } else if (score >= 62) {
    verdict = { key: 'ok', title: 'Приемлемо', color: 'var(--acid)', ghost: 'var(--acid-ghost)', icon: 'check' };
  } else if (score >= 45) {
    verdict = { key: 'caution', title: 'С осторожностью', color: 'var(--warn)', ghost: 'var(--warn-ghost)', icon: 'alert' };
  } else {
    verdict = { key: 'avoid', title: 'Лучше пропустить', color: 'var(--sell)', ghost: 'var(--sell-ghost)', icon: 'alert' };
  }

  const reasons = [];
  if (comps.price > 0.66) reasons.push('цена лучше медианы рынка');
  else if (comps.price < 0.4) reasons.push('цена хуже медианы');
  if (comps.reputation > 0.72) reasons.push('надёжный мерчант');
  else if (comps.reputation < 0.45) reasons.push('слабая репутация');
  if (comps.liquidity > 0.9) reasons.push('объём проходит целиком');
  else if (comps.liquidity < 0.6) reasons.push('ликвидности не хватает');
  if (comps.speed > 0.72) reasons.push('быстрый отпуск');
  if (comps.method < 0.5) reasons.push('рисковые реквизиты');

  return {
    offer, volumeUsdt, assetAmount, fillable, fiatNeeded,
    comps, weights: w, score: Math.round(score), confidence,
    dev, favourableDev, slippagePct,
    grossFiat, feeFiat, totalFiat, effPrice, exitPrice,
    profitFiat, profitUsdt,
    flags, blocker, verdict, reasons,
    executable: !blocker && confidence >= 0 && fillable > 0,
    coverage: assetAmount ? clamp01(fillable / assetAmount) : 0,
  };
}

/**
 * Multi-offer execution plan: fills the requested volume across the book,
 * which is what actually happens when one ad can't absorb the size.
 */
export function buildPlan(offers, volumeUsdt, limit = 6) {
  const f = state.filters;
  const need = usdtToAsset(volumeUsdt, f.asset, f.fiat);
  const sorted = [...offers].sort((a, b) => (f.side === 'buy' ? a.price - b.price : b.price - a.price));
  const legs = [];
  let left = need;
  for (const o of sorted) {
    if (left <= 1e-9 || legs.length >= limit) break;
    const fiatMinAsset = o.min / o.price;
    if (o.available < fiatMinAsset) continue;
    const take = Math.min(left, o.available, o.max / o.price);
    if (take * o.price < o.min) continue;
    legs.push({ offer: o, amount: take, fiat: take * o.price });
    left -= take;
  }
  const filled = need - left;
  const fiatTotal = legs.reduce((a, l) => a + l.fiat, 0);
  const vwap = filled ? fiatTotal / filled : 0;
  const best = sorted[0]?.price || 0;
  return {
    legs, need, filled, left,
    coverage: need ? filled / need : 0,
    vwap, fiatTotal,
    slippagePct: best && vwap ? Math.abs((vwap - best) / best) * 100 : 0,
  };
}

/** Human-readable label for each weight key. */
export const WEIGHT_LABELS = {
  reputation: 'Репутация мерчанта',
  price: 'Отклонение цены',
  liquidity: 'Ликвидность и лимиты',
  method: 'Риск реквизитов',
  speed: 'Скорость отпуска',
  exchange: 'Надёжность биржи',
};
