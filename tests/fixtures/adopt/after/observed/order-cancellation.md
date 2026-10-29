# Observed, unconfirmed: order-cancellation

Code is evidence of what happens today, not proof it is wanted. Nothing here is a requirement.

## cancel-shipped-order-answers-ok
- Observed: cancelling a shipped order answers 200 `ok: true` but leaves the order shipped (src/orders.js:21).
- Why unconfirmed: suspected-bug, success is reported for a cancel that did nothing; the README does not say what happens after shipping.
- Owner: account owner (order handling)
- To confirm: ask what a customer should see (an error, or a real cancel with a refund).

## cancel-unknown-order-is-404
- Observed: cancelling an unknown id answers 404 (src/server.js:24).
- Why unconfirmed: untested, no test or document covers it.
- Owner: tech lead
- To confirm: add a test; likely intended.
