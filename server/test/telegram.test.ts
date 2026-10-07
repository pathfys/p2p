import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { HmacTelegramVerifier } from '../src/adapters/telegram/verifier.js';

const BOT = 'TESTBOT:abc123';

/** Собирает валидный initData, подписанный по схеме Telegram. */
function makeInitData(authDateSec: number, user: object): string {
  const params = new URLSearchParams();
  params.set('auth_date', String(authDateSec));
  params.set('user', JSON.stringify(user));
  // data_check_string из декодированных пар, отсортированных по ключу
  const dcs = [...params].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT).digest();
  const hash = createHmac('sha256', secret).update(dcs).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

test('валидный initData проходит, user.id доверяется', () => {
  const v = new HmacTelegramVerifier(BOT);
  const now = Date.now();
  const initData = makeInitData(Math.floor(now / 1000), { id: 42, first_name: 'Art', username: 'art' });
  const u = v.verify(initData, now);
  assert.ok(u);
  assert.equal(u.id, '42');
  assert.equal(u.firstName, 'Art');
});

test('подделанный hash отклоняется', () => {
  const v = new HmacTelegramVerifier(BOT);
  const now = Date.now();
  const initData = makeInitData(Math.floor(now / 1000), { id: 7, first_name: 'X' }).replace(/hash=[0-9a-f]+/, 'hash=' + '0'.repeat(64));
  assert.equal(v.verify(initData, now), null);
});

test('просроченный auth_date отклоняется', () => {
  const v = new HmacTelegramVerifier(BOT);
  const now = Date.now();
  const stale = makeInitData(Math.floor(now / 1000) - 3600, { id: 7, first_name: 'X' });
  assert.equal(v.verify(stale, now), null);
});

test('чужой бот-токен не проходит (подпись не сойдётся)', () => {
  const v = new HmacTelegramVerifier('OTHER:999');
  const now = Date.now();
  const initData = makeInitData(Math.floor(now / 1000), { id: 7, first_name: 'X' });
  assert.equal(v.verify(initData, now), null);
});
