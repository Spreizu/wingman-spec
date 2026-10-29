---
title: Use PostgreSQL for all state
status: Proposed
date: 2026-10-06
change: foundation
---

# Use PostgreSQL for all state

## Context
The app must run on the owner's cloud account with the licensed Postgres.

## Decision
We will keep subscriptions, boxes, charges and refunds in the licensed PostgreSQL.

## Alternatives considered
- **A document database**: no relational integrity for charges and refunds.

## Consequences
- **Positive**: one transactional store for money-related state.
- **Negative**: schema migrations need care.
- **Follow-ups**: none.
