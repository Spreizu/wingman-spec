# order-lookup Specification

## Purpose
Defines how an order, or every order, is read back through the API.

## Requirements

### Requirement: An order can be looked up by id
The system SHALL answer GET /orders/<id> with 200 and the order when it exists.

#### Scenario: existing order
- **WHEN** GET /orders/<id> is called for a placed order
- **THEN** the answer is 200 with the order, including its total in cents

### Requirement: An unknown order is a 404
The system SHALL answer 404 with the body `nope` when no order has the given id.

#### Scenario: unknown id
- **WHEN** GET /orders/99999 is called and no such order exists
- **THEN** the answer is 404 with the body `nope`

### Requirement: Every order can be listed
The system SHALL answer GET /debug/dump with 200 and all orders, including customer e-mail addresses.

#### Scenario: dump
- **WHEN** GET /debug/dump is called
- **THEN** the answer is 200 with a list of every order placed so far
