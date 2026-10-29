# order-cancellation Specification

## Purpose
Defines how a customer cancels an order that has not shipped yet.

Baseline: adopted 2026-10-26

## Requirements

### Requirement: A pending order can be cancelled
The system SHALL set the status of a pending order to `cancelled` and answer 200 with `ok: true`.
Confirmed: test test/orders.test.js: a pending order can be cancelled

#### Scenario: cancel pending
- **WHEN** POST /orders/<id>/cancel is called for a pending order
- **THEN** the answer is 200 with `ok: true` and the order status is `cancelled`
