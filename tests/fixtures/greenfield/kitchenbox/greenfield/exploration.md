# Exploration: KitchenBox

## Capability map
- accounts (capability, P0): A visitor can create an account and sign in.
- subscriptions (capability, P0): A customer chooses a plan, skips weeks and pauses.
- billing (integration, P0): Weekly charges and refunds through the PayGate payment provider.
- delivery-slots (integration, P1): Delivery slots and tracking through the CourierX API.
- notifications (integration, P1): E-mails about dispatch and delivery through MailPost.
- packing-list (capability, P2): Kitchen staff get one packing list per delivery day.

## Integration inventory
- PayGate: charges and refunds, owned by finance, sandbox with test cards
- CourierX: slots, bookings, tracking, owned by logistics, sandbox with test postcodes
- MailPost: dispatch and delivery e-mails, owned by IT, sandbox sink address
