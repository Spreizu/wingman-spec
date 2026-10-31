## Purpose
Delivery through the CourierX API: reserving a delivery slot per box, reading its tracking status, and what happens when the courier is unavailable.

## ADDED

### Requirement: Contract: CourierX slots and tracking API
The system SHALL call CourierX GET /v2/slots?postcode=, POST /v2/bookings and GET /v2/bookings/{id}, authenticated by the COURIERX_API_KEY header, at most 5 requests per second.
Why: Logistics wants slots booked and tracked as CourierX defines them, so that every box is delivered in its slot.

#### Scenario: Slots are requested by postcode
- **WHEN** a customer enters postcode 10115
- **THEN** the request is GET /v2/slots?postcode=10115

#### Scenario: Failure: CourierX is unavailable
- **WHEN** CourierX answers 503 or does not answer within 5 seconds
- **THEN** the customer sees "delivery times are unavailable, try again" and the subscription is not changed

#### Scenario: Failure: no coverage for the postcode
- **WHEN** CourierX answers with an empty slot list
- **THEN** the customer is told the area is not served and cannot subscribe

### Requirement: Reserve a delivery slot
The system SHALL reserve a CourierX slot for each box when it is charged, and keep the booking id with the box.
Why: A customer wants a delivery slot reserved with the subscription, so that someone is home to take the box.

#### Scenario: Slot reserved with the charge
- **WHEN** a box is charged
- **THEN** a booking exists and its id is stored with the box

#### Scenario: Failure: slot taken meanwhile
- **WHEN** CourierX answers that the slot is gone
- **THEN** the next free slot on the same weekday is booked and the customer is told the new time

### Requirement: Show delivery status
The system SHALL show each box as scheduled, dispatched, delivered or failed, from CourierX status, refreshed at most every 10 minutes.
Why: A subscriber wants to see when the box arrives and whether it was delivered, so someone is home to take it.

#### Scenario: watch a box arrive
- **WHEN** a box is booked, dispatched and delivered
- **THEN** the customer sees scheduled, then dispatched with the time window, then delivered

#### Scenario: Failure: delivery failed
- **WHEN** CourierX reports a failed delivery
- **THEN** the box shows "failed" and the customer is offered a new slot
