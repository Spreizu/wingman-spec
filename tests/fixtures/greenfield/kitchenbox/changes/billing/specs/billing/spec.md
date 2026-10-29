## Purpose
Payments through the PayGate provider: weekly charges for boxes, refunds for skipped weeks, and what happens when a charge fails.

## ADDED Requirements

### Requirement: Contract: PayGate charges API
The system SHALL call PayGate POST /v1/charges with amount in cents, currency EUR, a customer token and an idempotency key, authenticated by the PAYGATE_API_KEY bearer token, at most 20 requests per second.
Why: Finance wants charges created exactly as PayGate expects, so that no customer is charged twice or not at all.

#### Scenario: Charge request carries the idempotency key
- **WHEN** a charge is created for box 17
- **THEN** the request has idempotency key "box-17" and an amount in cents

#### Scenario: Failure: PayGate times out after 10 seconds
- **WHEN** PayGate does not answer within 10 seconds
- **THEN** the charge is marked "pending" and retried with the same idempotency key, never with a new one

#### Scenario: Failure: PayGate declines the card
- **WHEN** PayGate answers with decline code card_declined
- **THEN** the box is held, the customer is told to update the card, and no retry happens before they do

### Requirement: Charge the weekly box
The system SHALL charge the subscription price on the Wednesday 7 days before delivery, unless the week is skipped.
Why: A customer wants to pay for the weekly box automatically, so that dinners are sorted without planning.

#### Scenario: Charge a normal week
- **WHEN** it is Wednesday a week before delivery and the week is not skipped
- **THEN** one charge for the plan price is created

#### Scenario: Skipped week is not charged
- **WHEN** the week is skipped
- **THEN** no charge is created

### Requirement: Refund a skipped week
The system SHALL refund the full box price within 1 hour when a subscriber skips a week that was already charged.
Why: A subscriber wants a refund when a week is skipped after payment, so they never pay for a box they cannot receive.

#### Scenario: Refund after a late skip within the deadline
- **WHEN** a charged week is skipped before the deadline
- **THEN** a full refund is requested and shown as "refund pending"

#### Scenario: Failure: duplicate refund request
- **WHEN** the refund request is sent twice
- **THEN** PayGate refunds once because both requests carry the same idempotency key
