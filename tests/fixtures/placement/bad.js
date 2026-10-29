/* @spec billing/rounding */
const { roundMoney } = require('./money');

function total(cart) {
  return roundMoney(cart.items.reduce((n, i) => n + i.price, 0)); /* @spec billing/rounding */
}

function addItem(cart, item) {
  // @spec billing/reject-empty
  if (item.qty === 0) throw new Error('empty');
  // @spec billing/reject-empty
  return { ...cart, items: [...cart.items, item] };
  // @spec billing/add-an-item
}

module.exports = { total, addItem };
