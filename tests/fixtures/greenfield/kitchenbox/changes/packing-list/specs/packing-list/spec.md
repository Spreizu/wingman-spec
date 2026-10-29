## Purpose
The daily packing list for the kitchen: which boxes with which meals leave on which delivery day, built from the active and not skipped subscriptions.

## ADDED Requirements

### Requirement: Daily packing list
The system SHALL produce for each delivery day, by 16:00 the day before, a list of boxes with meal counts and diet notes, excluding skipped weeks.
Why: Kitchen staff want a packing list per delivery day, so the right boxes leave on time.

#### Scenario: list for tomorrow
- **WHEN** it is 16:00 and 12 subscribers are active, 2 of them skipped
- **THEN** the list has 10 boxes with their meals and diet notes

#### Scenario: An empty day gives an empty list
- **WHEN** no box is scheduled for a day
- **THEN** the list is empty and says "no boxes"
