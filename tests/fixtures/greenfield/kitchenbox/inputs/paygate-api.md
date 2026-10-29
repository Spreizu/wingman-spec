# PayGate API notes
POST /v1/charges {amount_cents, currency, customer_token, idempotency_key}; POST /v1/refunds {charge_id, idempotency_key}. Bearer token in PAYGATE_API_KEY (finance holds it). 20 requests per second. Sandbox: https://sandbox.paygate.example, card 4242-4242-4242-4242 pays, 4000-0000-0000-0002 is declined.
