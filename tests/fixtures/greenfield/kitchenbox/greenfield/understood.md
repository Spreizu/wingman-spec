---
approved_by:
approved_on:
approved_hash:
---
# What we understood

## Product in one paragraph
KitchenBox becomes a web app where customers subscribe to a weekly meal box, pay weekly, skip or pause weeks, and follow delivery; the kitchen gets a packing list. Orders no longer come by e-mail.

## Users and what they need
- Customers: subscribe, pay, skip, see delivery.
- Kitchen staff: one packing list per delivery day.
- Owner (admin): sees that it runs.

## What it must do
- Capabilities: accounts (P0), subscriptions (P0), billing (P0), delivery-slots (P1), notifications (P1), packing-list (P2).

## Systems it connects to
- PayGate (payments, finance), CourierX (delivery, logistics), MailPost (e-mails, IT); all have test environments.

## What happens when things fail
- Card declined: the box is held and the customer updates the card; PayGate or CourierX or MailPost down: retry, never double charge, never lose the order.

## Targets
- 200 concurrent users, 800 ms for 95% of pages, 99.5% availability a month, invoices kept 7 years.

## Out of scope
- Mobile app, recipes, discount codes, several countries.

## Assumptions we made
- A-design-freeform: no visual design exists; we follow common web conventions. Verified by the owner before the pages are built.

## Still open
- Q-failure: answered by the owner on 2026-10-05 (hold for 48 hours); no other open question.
