# Observed, unconfirmed: order-placement

Code is evidence of what happens today, not proof it is wanted. Nothing here is a requirement.

## failed-confirmation-email-is-ignored
- Observed: when sending the confirmation e-mail fails, the error is swallowed and the order is still placed, with no log (src/notify.js:6).
- Why unconfirmed: suspected-bug, an empty catch; no test or document says a failed e-mail should be ignored.
- Owner: account owner (customer communication)
- To confirm: ask whether a failed e-mail should be retried, logged or fail the order.

## order-ids-start-at-1000
- Observed: the first order id is 1000, later ones count up by one (src/orders.js:4).
- Why unconfirmed: incidental, no test or document names the starting id or the numbering.
- Owner: account owner
- To confirm: ask whether customers or other systems depend on the id format.

## confirmation-email-subject
- Observed: the e-mail subject is `Order <id> received` (src/notify.js:5).
- Why unconfirmed: untested, the README only says an e-mail is sent.
- Owner: account owner (customer communication)
- To confirm: ask for the wanted wording and add it to the requirement.

## x-powered-by-header
- Observed: every answer carries the header `x-powered-by: helpdesk-dev` (src/server.js:5).
- Why unconfirmed: incidental, looks like a development leftover.
- Owner: tech lead
- To confirm: ask whether it should be removed.
