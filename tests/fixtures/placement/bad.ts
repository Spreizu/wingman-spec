// @spec billing/add-an-item
import { Cart, Item } from './types';

export function addItem(cart: Cart, item: Item): Cart {
  const items = [...cart.items, item]; // @spec billing/add-an-item
  return { ...cart, items };
}

export const total = (cart: Cart): number => {
  // @spec billing/rounding
  const sum = cart.items.reduce((n, i) => n + i.price, 0);
  // @spec billing/rounding
  const rounded = Math.round(sum * 100) / 100;
  // @spec billing/reject-empty

  return rounded;
};
