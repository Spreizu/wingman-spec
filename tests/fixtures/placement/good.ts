import { Cart, Item } from './types';

/**
 * Adds an item to the cart.
 * @spec billing/add-an-item
 */
export function addItem(cart: Cart, item: Item): Cart {
  if (!item) throw new Error('no item');
  // @spec billing/reject-empty
  if (item.qty === 0) {
    throw new Error('empty');
  }
  return { ...cart, items: [...cart.items, item] };
}

export const total = (cart: Cart): number => {
  // @spec billing/rounding
  return Math.round(cart.items.reduce((n, i) => n + i.price, 0) * 100) / 100;
};
