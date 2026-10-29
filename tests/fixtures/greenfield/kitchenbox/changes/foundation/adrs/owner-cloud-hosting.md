---
title: Host on the owner cloud account
status: Proposed
date: 2026-10-06
change: foundation
---

# Host on the owner cloud account

## Context
The app must run on the owner's cloud account with the licensed Postgres.

## Decision
We will deploy to the owner cloud account in staging and production.

## Alternatives considered
- **A document database**: no relational integrity for charges and refunds.

## Consequences
- **Positive**: one transactional store for money-related state.
- **Negative**: schema migrations need care.
- **Follow-ups**: none.
