const VAT = 0.2;
const DISCOUNT_FROM_CENTS = 10000;

export function subtotal(items) {
  return items.reduce((sum, i) => sum + i.qty * i.unitCents, 0);
}

export function total(items) {
  const sub = subtotal(items);
  const discounted = sub > DISCOUNT_FROM_CENTS ? sub * 0.9 : sub;
  return Math.floor(discounted * (1 + VAT));
}
