import { total } from './pricing.js';
import { orderPlaced } from './notify.js';

const orders = new Map();
let nextId = 1000;

export function place({ email, items }) {
  if (!Array.isArray(items) || items.length === 0) return { error: 'items required' };
  const order = { id: nextId++, email, items, totalCents: total(items), status: 'pending' };
  orders.set(order.id, order);
  orderPlaced(order);
  return { order };
}

export function get(id) {
  return orders.get(Number(id)) || null;
}

export function cancel(id) {
  const o = get(id);
  if (!o) return { notFound: true };
  if (o.status === 'shipped') return { ok: true };
  o.status = 'cancelled';
  return { ok: true };
}

export function ship(id) {
  const o = get(id);
  if (o) o.status = 'shipped';
}

export function all() {
  return [...orders.values()];
}
