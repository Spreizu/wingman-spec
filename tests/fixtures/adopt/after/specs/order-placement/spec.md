# order-placement Specification

## Purpose
Defines how an order is placed through the API and what the customer is told afterwards.

Baseline: adopted 2026-10-26

## Requirements

### Requirement: An order needs items
The system SHALL refuse an order without items with status 400 and the error `items required`.
Confirmed: test test/orders.test.js: an order without items is refused with "items required"

#### Scenario: empty order
- **WHEN** POST /orders is called with an empty items list
- **THEN** the answer is 400 with the error `items required`

### Requirement: A placed order is answered with its id and total
The system SHALL answer a valid POST /orders with status 201 and the order's id, total in cents and status.
Confirmed: doc README.md (API)

#### Scenario: valid order
- **WHEN** POST /orders is called with an e-mail and one item of quantity 2 at 500 cents
- **THEN** the answer is 201 with an id, a total of 1200 cents and a status

### Requirement: The customer is e-mailed when an order is placed
The system SHALL send the customer an e-mail when their order is placed.
Confirmed: doc README.md (Rules)

#### Scenario: e-mail sent
- **WHEN** an order is placed with the e-mail `a@b.ee`
- **THEN** an e-mail is sent to `a@b.ee`
