## Purpose
Weekly meal-box subscriptions: choosing a plan, skipping a week and pausing, with the weekly order state the other capabilities read.

## ADDED

### Requirement: Choose a plan
The system SHALL let a signed-in customer subscribe to one plan: 2 or 4 meals per box, for 2 or 4 people, delivered weekly.
Why: A signed-in customer wants to choose a plan, so that they pay only for the boxes they want.

#### Scenario: from sign-up to first paid box
- **WHEN** a visitor registers, picks 4 meals for 2 people and pays
- **THEN** a subscription is active and the first box is scheduled for the next free delivery slot

#### Scenario: Plan shows the weekly price
- **WHEN** a customer opens the plan page
- **THEN** the price per box is shown in euros with 2 decimals

#### Scenario: Failure: no plan chosen
- **WHEN** a customer confirms without choosing a plan
- **THEN** confirmation is refused with "choose a plan"

### Requirement: Skip a week
The system SHALL let a subscriber skip any upcoming week until 23:59 on the Tuesday before the delivery week.
Why: A subscriber wants to skip a week, so they never pay for a box they cannot receive.

#### Scenario: skip before the deadline
- **WHEN** a subscriber skips next week on Monday
- **THEN** no box is packed or charged for that week and the week shows as skipped

#### Scenario: Failure: skip after the deadline
- **WHEN** a subscriber skips a week on Wednesday before that week
- **THEN** the skip is refused with "too late" and the box stays scheduled

#### Scenario: Skipping twice does not charge twice
- **WHEN** a subscriber skips the same week twice
- **THEN** the week is skipped once and no second refund or credit is created

### Requirement: Pause a subscription
The system SHALL let a subscriber pause for 1 to 8 weeks and resume automatically afterwards.
Why: A subscriber wants to pause for several weeks, so they are not charged while away.

#### Scenario: Pause for 3 weeks
- **WHEN** a subscriber pauses for 3 weeks
- **THEN** the next 3 weeks are skipped and the 4th week is scheduled

#### Scenario: Failure: pause longer than 8 weeks
- **WHEN** a subscriber asks for 9 weeks
- **THEN** the request is refused with "at most 8 weeks"
