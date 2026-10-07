import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canTransition, assertTransition, isTerminal, makeRef } from '../src/domain/deal.js';
import { DomainError } from '../src/domain/errors.js';

test('переходы автомата сделки', () => {
  assert.ok(canTransition('created', 'paid'));
  assert.ok(canTransition('paid', 'released'));
  assert.ok(canTransition('released', 'done'));
  assert.ok(!canTransition('created', 'released'), 'нельзя перескочить paid');
  assert.ok(!canTransition('done', 'paid'), 'done терминальный');
  assert.ok(isTerminal('done') && isTerminal('cancelled'));
  assert.throws(() => assertTransition('created', 'done'), (e) => e instanceof DomainError && e.code === 'conflict');
});

test('референс сделки формата P2D-XXXXXX', () => {
  let i = 0;
  const seq = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
  const ref = makeRef(() => seq[i++ % seq.length]!);
  assert.match(ref, /^P2D-[A-Z0-9]{6}$/);
});
