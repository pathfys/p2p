import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialSubscription, subscribe, cancel, isActive, canUseBestOffers, activePlan, DAY_MS,
} from '../src/domain/subscription.js';
import { DomainError } from '../src/domain/errors.js';

test('пробный период однократен', () => {
  const t0 = 1_000_000;
  let s = initialSubscription();
  s = subscribe(s, 'trial', t0);
  assert.equal(s.plan, 'trial');
  assert.equal(s.trialUsed, true);
  assert.equal(s.until, t0 + DAY_MS);
  // повторный пробный запрещён даже после отмены
  s = cancel(s);
  assert.throws(() => subscribe(s, 'trial', t0 + 1), (e) => e instanceof DomainError && e.code === 'conflict');
});

test('лучшие стаканы только на quarter и только пока активен', () => {
  const t0 = 1_000_000;
  const week = subscribe(initialSubscription(), 'week', t0);
  assert.equal(canUseBestOffers(week, t0), false);

  const q = subscribe(initialSubscription(), 'quarter', t0);
  assert.equal(canUseBestOffers(q, t0), true);
  assert.equal(activePlan(q, t0)?.id, 'quarter');

  // после истечения срока доступ закрывается
  const afterExpiry = t0 + 91 * DAY_MS;
  assert.equal(isActive(q, afterExpiry), false);
  assert.equal(canUseBestOffers(q, afterExpiry), false);
});

test('неизвестный тариф отклоняется', () => {
  assert.throws(() => subscribe(initialSubscription(), 'gold' as never, 1), (e) => e instanceof DomainError);
});
