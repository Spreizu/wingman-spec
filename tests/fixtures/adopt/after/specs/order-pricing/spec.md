# order-pricing Specification

## Purpose
Defines how the total of an order is calculated: VAT is added and large orders get a discount.

Baseline: adopted 2026-10-26

## Requirements

### Requirement: VAT is added to the order total
The system SHALL add 20% VAT to the order subtotal to produce the order total, with prices in cents.
Confirmed: doc README.md (Rules), test test/pricing.test.js: adds 20% VAT to a small order

#### Scenario: small order
- **WHEN** an order has one item with quantity 1 and a unit price of 1000 cents
- **THEN** the total is 1200 cents

### Requirement: Orders over 100 EUR get a discount
The system SHALL take 10% off the subtotal, before VAT, of an order whose subtotal is more than 100.00 EUR.
Confirmed: test test/pricing.test.js: an order well over 100 EUR gets 10% off before VAT

#### Scenario: 200 EUR order
- **WHEN** an order has one item with quantity 1 and a unit price of 20000 cents
- **THEN** the total is 21600 cents
