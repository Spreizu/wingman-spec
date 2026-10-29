# order-cancellation Specification

## Purpose
Defines how a customer cancels an order that has not shipped yet.

## Requirements

### Requirement: A pending order can be cancelled
The system SHALL set the status of a pending order to `cancelled` and answer 200 with `ok: true`.

#### Scenario: cancel pending
- **WHEN** POST /orders/<id>/cancel is called for a pending order
- **THEN** the answer is 200 with `ok: true` and the order status is `cancelled`

### Requirement: Cancelling an unknown order is a 404
The system SHALL answer 404 with the body `nope` when the order does not exist.

#### Scenario: unknown id
- **WHEN** POST /orders/99999/cancel is called and no such order exists
- **THEN** the answer is 404 with the body `nope`
