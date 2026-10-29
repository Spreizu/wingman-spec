const { roundMoney } = require('./money');

/**
 * Total of the cart, rounded to cents.
 * @spec billing/rounding
 */
function total(cart) {
  return roundMoney(cart.items.reduce((n, i) => n + i.price, 0));
}

function addItem(cart, item) {
  // @spec billing/reject-empty
  if (item.qty === 0) throw new Error('empty');
  return { ...cart, items: [...cart.items, item] };
}

module.exports = { total, addItem };
