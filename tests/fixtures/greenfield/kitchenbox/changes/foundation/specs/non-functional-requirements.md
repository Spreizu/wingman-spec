## Purpose
Measurable quality targets for the whole product: speed, availability, data retention and password storage.

## ADDED

### Requirement: Page response time
The system SHALL answer 95% of page requests in under 800 ms with 200 concurrent users.
Why: The owner wants pages that answer quickly, so that customers do not leave while ordering.

#### Scenario: Under load
- **WHEN** 200 users browse at once
- **THEN** 95% of responses arrive in under 800 ms

### Requirement: Availability
The system SHALL be available 99.5% of each calendar month, excluding a maintenance window of 2 hours per month.
Why: The owner wants the app up around the clock, so that orders are not lost to downtime.

#### Scenario: Monthly availability
- **WHEN** a month has passed
- **THEN** measured downtime outside the window is under 0.5%

### Requirement: Data retention
The system SHALL delete a closed account's personal data within 30 days and keep invoices for 7 years.
Why: The owner wants closed accounts deleted on time, so that personal data is not kept longer than the law allows.

#### Scenario: Delete personal data
- **WHEN** an account was closed 31 days ago
- **THEN** its personal data is gone and its invoices remain

### Requirement: Password storage
The system SHALL store passwords only as salted hashes with a work factor that takes at least 100 ms to compute.
Why: The owner wants passwords stored only as salted hashes, so that a leak of the database does not expose customers.

#### Scenario: No plain passwords
- **WHEN** the user table is read
- **THEN** no password is readable and each hash is salted
