Size: M
Risk: none

## Why

Staff need to pause a member account that owes fees without deleting it.

## What Changes

- An admin page `/admin/members` with a form to pause or lock a member firm, and a list of paused firms.

## Capabilities

- **New Capabilities**: `admin-members`

## Edge cases

- Empty paused list -> admin-members/empty-list-shows-no-paused-firms
- Long firm name in the list -> admin-members/long-firm-name-still-shows
- Narrow admin form at 375px -> admin-members/members-form-on-a-narrow-page
