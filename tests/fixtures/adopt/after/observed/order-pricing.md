# Observed, unconfirmed: order-pricing

Code is evidence of what happens today, not proof it is wanted. Nothing here is a requirement.

## discount-at-exactly-100-eur
- Observed: an order of exactly 100.00 EUR gets no discount (src/pricing.js:12 uses "more than").
- Why unconfirmed: contradicts-doc, README.md says "100.00 EUR or more" gets 10% off.
- Owner: account owner (pricing rules)
- To confirm: ask which is meant, "100 or more" or "over 100"; then fix the code (/spec-fix) or the README, and add the exact-100 case to the requirement.

## total-rounding
- Observed: a fractional cent is cut off (src/pricing.js:13, floor).
- Why unconfirmed: contradicts-doc, README.md says the total is rounded to the nearest cent.
- Owner: account owner (pricing rules)
- To confirm: ask whether to round or to cut; check a 1005-cent item with the discount (10% off then 20% VAT gives a fraction).
