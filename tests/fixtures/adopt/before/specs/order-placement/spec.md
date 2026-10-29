# order-placement Specification

## Purpose
Defines how an order is placed through the API and what the customer is told afterwards.

## Requirements

### Requirement: An order needs items
The system SHALL refuse an order without items with status 400 and the error `items required`.

#### Scenario: empty order
- **WHEN** POST /orders is called with an empty items list
- **THEN** the answer is 400 with the error `items required`

### Requirement: A placed order is created pending
The system SHALL create the order with status `pending` and answer 201 with its id, total in cents and status.

#### Scenario: valid order
- **WHEN** POST /orders is called with an e-mail and one item of quantity 2 at 500 cents
- **THEN** the answer is 201 with a numeric id, a total of 1200 cents and status `pending`

### Requirement: The customer gets a confirmation e-mail
The system SHALL send the customer an e-mail with the subject `Order <id> received` when an order is placed.

#### Scenario: e-mail sent
- **WHEN** an order is placed with the e-mail `a@b.ee`
- **THEN** an e-mail with the subject `Order <id> received` is sent to `a@b.ee`
