# Observed, unconfirmed: order-lookup

Code is evidence of what happens today, not proof it is wanted. Nothing here is a requirement.

## debug-dump-route
- Observed: GET /debug/dump answers 200 with every order, including customer e-mail addresses (src/server.js:26).
- Why unconfirmed: debug-leftover, no document or test mentions it; it exposes personal data without a login.
- Owner: tech lead
- To confirm: ask whether it is still used; if not, remove it with /spec-fix.

## unknown-order-body
- Observed: an unknown id answers 404 with the body `"nope"` (src/server.js:20).
- Why unconfirmed: incidental, the README says only "404".
- Owner: tech lead
- To confirm: ask for the wanted error body.
