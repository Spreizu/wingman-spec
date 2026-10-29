import { test } from 'node:test';
import assert from 'node:assert/strict';
import { place, get, cancel } from '../src/orders.js';

test('an order without items is refused with "items required"', () => {
  assert.deepEqual(place({ email: 'a@b.ee', items: [] }), { error: 'items required' });
});

test('a placed order can be looked up by id', () => {
  const { order } = place({ email: 'a@b.ee', items: [{ sku: 'a', qty: 2, unitCents: 500 }] });
  assert.equal(get(order.id).totalCents, 1200);
});

test('a pending order can be cancelled', () => {
  const { order } = place({ email: 'a@b.ee', items: [{ sku: 'a', qty: 1, unitCents: 500 }] });
  assert.deepEqual(cancel(order.id), { ok: true });
  assert.equal(get(order.id).status, 'cancelled');
});
