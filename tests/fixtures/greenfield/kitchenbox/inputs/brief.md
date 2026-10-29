# KitchenBox: client brief

KitchenBox delivers weekly meal boxes (2 or 4 meals, for 2 or 4 people). Today orders arrive by e-mail and are packed from a spreadsheet; the owner wants a web app with subscriptions.

## What customers do
They register, choose a plan and pay weekly. They can skip any week up to the Tuesday before delivery, or pause for up to 8 weeks. They want to see when the box arrives and whether it was delivered.

## What the kitchen does
Staff print one packing list per delivery day, ready by 16:00 the day before.

## Systems
Payments go through PayGate, delivery through CourierX, e-mails through MailPost (API notes in the other files here). The app is hosted on the owner's cloud account; Postgres is already licensed.

## Numbers we know
About 200 customers browsing at once on Sunday evenings; the app may be down at most about 3 hours a month; invoices must be kept 7 years.

## Not now
No mobile app, no recipes, no discount codes, no multi-country.
