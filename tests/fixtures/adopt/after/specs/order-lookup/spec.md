# order-lookup Specification

## Purpose
Defines how a placed order is read back through the API by its id.

Baseline: adopted 2026-10-26

## Requirements

### Requirement: An order can be looked up by id
The system SHALL answer GET /orders/<id> with 200 and the order when it exists, and with 404 when it does not.
Confirmed: test test/orders.test.js: a placed order can be looked up by id

#### Scenario: existing order
- **WHEN** GET /orders/<id> is called for a placed order
- **THEN** the answer is 200 with the order, including its total in cents

#### Scenario: unknown order
- **WHEN** GET /orders/<id> is called and no such order exists
- **THEN** the answer is 404
