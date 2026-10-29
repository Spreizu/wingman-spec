# order-pricing Specification

## Purpose
Defines how the total of an order is calculated: VAT is added and large orders get a discount.

## Requirements

### Requirement: VAT is added to the order total
The system SHALL add 20% VAT to the order subtotal to produce the order total, with prices in cents.

#### Scenario: small order
- **WHEN** an order has one item with quantity 1 and a unit price of 1000 cents
- **THEN** the total is 1200 cents

### Requirement: Large orders get a discount
The system SHALL take 10% off the subtotal, before VAT, of an order well over 100 EUR.

#### Scenario: 200 EUR order
- **WHEN** an order has one item with quantity 1 and a unit price of 20000 cents
- **THEN** the total is 21600 cents
