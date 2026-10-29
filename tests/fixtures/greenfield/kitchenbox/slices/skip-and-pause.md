---
id: skip-and-pause
title: A subscriber skips a week or pauses and is refunded
capabilities: [subscriptions/skip-a-week, subscriptions/pause-a-subscription, billing/refund-a-skipped-week]
depends_on: [skeleton]
size: L
status: planned
milestone: m1
skeleton: false
contract_tests: []
---
## Acceptance criteria
- Skipping before the deadline stops the box and refunds a charged week
- Skipping after the deadline is refused
