<!-- Integration contract: the spec of one external system, in `specs/<integration>/spec.md`
     (spec-only change). Keep what a developer needs to build against it without asking.
     Secrets: name them and say who provides them; never write a value. -->
## Purpose
<One or two sentences, 50+ characters: what the product uses <System> for and which product features depend on it.>

## Requirements

### Requirement: Contract
The system SHALL call <System> only as described here.
Why: <who needs this integration to work this way, and why>

- Base URLs: sandbox <url>, production <url>
- Authentication: <scheme>; credential names <NAME>, held by <role>
- Operations used: <METHOD path: purpose>, one line each, with the request and response fields that matter
- Limits: <rate limit, payload size, timeouts>, and what the system does at the limit
- Idempotency: <key or rule>; webhooks: <events, signature check, retries>
- Sandbox data: <accounts, card numbers or ids that give each outcome below>

#### Scenario: Success: <operation>
- **WHEN** <the system calls it with sandbox data X>
- **THEN** <exact response and what the product shows or stores>

### Requirement: Failure handling
The system SHALL handle every failure of <System> without losing or duplicating the user's data.
Why: <who is hurt when a failure loses or duplicates data, and how>

#### Scenario: Failure: <System> is unavailable
- **WHEN** <the call times out after N seconds or returns 5xx>
- **THEN** <retry rule, what the user sees, what is stored, when it is retried or given up>

#### Scenario: Failure: <System> rejects the request
- **WHEN** <the sandbox outcome for a rejection>
- **THEN** <user-visible message, no partial state>
