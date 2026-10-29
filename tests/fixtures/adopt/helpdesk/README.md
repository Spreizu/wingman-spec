# helpdesk

A small order desk for a web app: place an order, look it up, cancel it.

## Rules

- Prices are in cents. VAT is 20% and is added to the order total.
- Orders of 100.00 EUR or more (before VAT) get a 10% discount.
- The total is rounded to the nearest cent.
- An order needs at least one item (`{ sku, qty, unitCents }`). Otherwise the answer is 400 `items required`.
- A pending order can be cancelled by its id. Customers get an e-mail when an order is placed.

## API

- `POST /orders` body `{ email, items }` -> 201 `{ id, totalCents, status }`
- `GET /orders/:id` -> 200 order, or 404
- `POST /orders/:id/cancel` -> 200 `{ ok: true }`
