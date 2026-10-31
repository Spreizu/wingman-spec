## Purpose
Customer accounts: registration and sign-in, the identity every subscription, payment and delivery belongs to.

## ADDED

### Requirement: Register an account
The system SHALL let a visitor register with an e-mail address and a password of at least 10 characters.
Why: A visitor wants an account of their own, so that they can subscribe and pay for a weekly box.

#### Scenario: Register with a new e-mail
- **WHEN** a visitor submits an unused e-mail and a 12-character password
- **THEN** an account exists and the visitor is signed in

#### Scenario: Failure: e-mail already registered
- **WHEN** a visitor submits an e-mail that has an account
- **THEN** registration is refused with "email taken" and no second account is created

#### Scenario: Failure: password too short
- **WHEN** a visitor submits a 6-character password
- **THEN** registration is refused with "password too short" and no account is created

### Requirement: Sign in
The system SHALL sign a registered customer in with e-mail and password and lock the account for 15 minutes after 5 failed attempts.
Why: A registered customer wants to sign in, so that they reach their subscription without registering again.

#### Scenario: Sign in with the right password
- **WHEN** a customer submits the right password
- **THEN** a session starts

#### Scenario: Lock after 5 failures
- **WHEN** a customer submits a wrong password 5 times in a row
- **THEN** the 6th attempt is refused for 15 minutes even with the right password
