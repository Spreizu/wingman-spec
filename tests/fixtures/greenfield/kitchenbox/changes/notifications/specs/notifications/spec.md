## Purpose
E-mail notifications through the MailPost provider: the dispatch notice and the delivery notice, and what happens when sending fails.

## ADDED Requirements

### Requirement: Contract: MailPost send API
The system SHALL call MailPost POST /v1/send with template id, recipient and variables, authenticated by the MAILPOST_API_KEY bearer token, at most 50 requests per second.
Why: IT wants e-mails sent as MailPost expects, so that notices reach customers and are not rejected.

#### Scenario: Send uses a template
- **WHEN** a dispatch notice is sent
- **THEN** the request carries template "dispatch" and the delivery window as a variable

#### Scenario: Failure: MailPost rejects the address
- **WHEN** MailPost answers with 422 invalid_recipient
- **THEN** the notice is dropped, the address is flagged and no retry happens

#### Scenario: Failure: MailPost is unavailable
- **WHEN** MailPost answers 503
- **THEN** the notice is retried after 1, 5 and 30 minutes and then reported to operations

### Requirement: Notify when a box is dispatched
The system SHALL e-mail the subscriber within 5 minutes after CourierX reports a box as dispatched.
Why: A subscriber wants an e-mail when the box is dispatched, so someone is home to take it.

#### Scenario: Dispatch notice
- **WHEN** CourierX reports dispatched
- **THEN** one e-mail with the time window is sent within 5 minutes

#### Scenario: The same status is not announced twice
- **WHEN** CourierX reports dispatched twice for one box
- **THEN** only one e-mail is sent
