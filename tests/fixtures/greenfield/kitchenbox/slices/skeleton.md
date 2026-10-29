---
id: skeleton
title: A visitor registers, picks a plan and pays with the sandbox card
capabilities: [accounts, subscriptions/choose-a-plan, billing/contract-paygate-charges-api, billing/charge-the-weekly-box]
depends_on: []
size: L
status: planned
milestone: m1
skeleton: true
contract_tests: [billing]
---
## Acceptance criteria
- A visitor can register, pick a plan and pay with the PayGate sandbox card 4242-4242-4242-4242
- A stub of PayGate with a contract test covers charge, timeout and decline
