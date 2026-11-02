## Purpose

Lets a signed-in admin pause or lock a member firm and see which firms are paused or locked.

## ADDED

### Requirement: Members page
The system SHALL show `/admin/members` to an admin with a firm select, a pause box, a lock box and a save button.
Why: Staff want one place to pause a firm, so that they do not edit the database by hand.

#### Scenario: Admin opens the members page
- **WHEN** an admin opens `/admin/members`
- **THEN** `[data-testid="members-firm"]`, `[data-testid="members-save"]` and `[data-testid="members-list"]` are visible

```visual
route: /admin/members
role: admin
component: members_index
viewports: 768, 1280
key: [data-testid="members-firm"]
key: [data-testid="members-save"]
key: [data-testid="members-list"]
```

#### Scenario: Members form on a narrow page
- **WHEN** an admin opens `/admin/members` at 375px
- **THEN** `[data-testid="members-firm"]` and `[data-testid="members-save"]` are visible and nothing in `#main` scrolls sideways

```visual
route: /admin/members
role: admin
component: members_index
viewports: 375
key: [data-testid="members-firm"]
key: [data-testid="members-save"]
state: one-row
  do: fill [data-testid="members-filter"] = Example Ltd
  key: [data-testid="member-row"]
state: many-rows
  key: [data-testid="member-row"]
  expect: [data-testid="members-firm"] above [data-testid="members-save"] @375
```

### Requirement: Paused list
The system SHALL list each paused or locked firm with its name and flags, show `No paused firms.` when there are none, and show a firm name of 90 characters in full.
Why: Staff need to see who is paused, so that they clear the right firm.

#### Scenario: Empty list shows no paused firms
- **WHEN** an admin opens `/admin/members` and no firm is paused
- **THEN** `[data-testid="members-empty"]` text is `No paused firms.`

Not visual: the live app may already have paused firms; covered by `tests/MembersPageTest.php`

#### Scenario: List shows pause and lock labels
- **WHEN** firm `Example Ltd` is paused and not locked
- **THEN** `[data-testid="members-list"]` has a row with `Example Ltd`, pause on and lock off

Not visual: the live app may have other paused firms; covered by `tests/MembersPageTest.php`

#### Scenario: Long firm name still shows
- **WHEN** a paused firm's name is 90 characters
- **THEN** that full name is in `[data-testid="members-list"]`

```visual
route: /admin/members
role: admin
component: members_index
viewports: 375, 1280
key: [data-testid="members-list"]
state: long-name
  do: fill [data-testid="members-filter"] = Long
  key: [data-testid="member-row"]
```
