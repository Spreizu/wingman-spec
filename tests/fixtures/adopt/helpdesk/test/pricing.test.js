import { test } from 'node:test';
import assert from 'node:assert/strict';
import { total } from '../src/pricing.js';

test('adds 20% VAT to a small order', () => {
  assert.equal(total([{ sku: 'a', qty: 1, unitCents: 1000 }]), 1200);
});

test('an order well over 100 EUR gets 10% off before VAT', () => {
  assert.equal(total([{ sku: 'a', qty: 1, unitCents: 20000 }]), 21600);
});
