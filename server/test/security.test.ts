import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeLogText, escapeHtml, plainText } from '../src/adapters/security/sanitize.js';
import { SessionCodec } from '../src/adapters/security/session.js';
import { TokenBucketLimiter } from '../src/adapters/security/ratelimit.js';

test('санитизация логов: выживает только <b>', () => {
  const xss = '<img src=x onerror=alert(1)> <b>цена</b>';
  const out = safeLogText(xss);
  assert.ok(!out.includes('<img'), 'тег img экранирован');
  assert.ok(out.includes('&lt;img'), 'как текст');
  assert.ok(out.includes('<b>цена</b>'), 'жирный сохранён');
});

test('escapeHtml экранирует кавычки и скобки', () => {
  assert.equal(escapeHtml(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  assert.equal(plainText('  a\u0000b  '), 'a b');
});

test('session: подпись/проверка, подделка, срок', () => {
  const secret = 'x'.repeat(40);
  const codec = new SessionCodec(secret, 1000);
  const t0 = 10_000;
  const token = codec.issue('u_1', '1', t0);
  const claims = codec.verify(token, t0 + 500);
  assert.equal(claims?.sub, 'u_1');
  // просрочен
  assert.equal(codec.verify(token, t0 + 2000), null);
  // подделка полезной нагрузки ломает подпись
  const bad = token.replace(/^[^.]+/, Buffer.from('{"sub":"admin","exp":9e15}').toString('base64url'));
  assert.equal(codec.verify(bad, t0 + 100), null);
  // мусор
  assert.equal(codec.verify('garbage', t0), null);
});

test('session: другой секрет не проходит', () => {
  const a = new SessionCodec('a'.repeat(40));
  const b = new SessionCodec('b'.repeat(40));
  const tok = a.issue('u_1', '1', 1000);
  assert.equal(b.verify(tok, 1001), null);
});

test('token bucket: лимит и восстановление', () => {
  let now = 0;
  const rl = new TokenBucketLimiter(3, 1000, () => now);
  assert.ok(rl.take('k').ok);
  assert.ok(rl.take('k').ok);
  assert.ok(rl.take('k').ok);
  const denied = rl.take('k');
  assert.equal(denied.ok, false);
  assert.ok(denied.retryAfterMs > 0);
  now += 1000; // полное восстановление
  assert.ok(rl.take('k').ok);
  // независимые ключи
  assert.ok(rl.take('other').ok);
});
