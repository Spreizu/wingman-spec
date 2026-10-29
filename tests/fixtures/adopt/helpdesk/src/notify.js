import * as mailer from './mailer.js';

export function orderPlaced(order) {
  try {
    mailer.send(order.email, `Order ${order.id} received`);
  } catch (e) {
  }
}
