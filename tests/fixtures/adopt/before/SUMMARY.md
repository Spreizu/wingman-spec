## Adopted: whole repository
Specs: order-pricing (2 req), order-placement (3 req), order-lookup (3 req), order-cancellation (2 req)
Questions for the analyst (summary only; nothing is saved):
- README says 100.00 EUR or more gets the discount, code uses "over"; exact 100 EUR left out.
- Total uses floor, README says nearest cent; rounding left out.
- Confirmation e-mail failures are swallowed by an empty catch; failure behavior left out.
- Cancelling a shipped order answers ok:true and changes nothing; left out.
Test coverage gaps: order-placement e-mail, order-lookup dump/404, cancellation 404: no tests
