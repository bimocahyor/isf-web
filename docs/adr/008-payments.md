# ADR-008: Payment Gateway Architecture

**Status:** Accepted  
**Date:** 2025

## Critical Rule

**A client-side button click, a browser redirect, or a success URL callback is NOT proof of payment.**

Payment status is only updated to PAID after receiving a verified server-side webhook from the payment gateway, with a valid HMAC signature.

## Decision

- Payment gateway is abstracted behind a `PaymentGateway` interface
- The initial provider will be Midtrans or Xendit (Indonesian market)
- A `MockPaymentGateway` is available for development and testing
- All gateway interactions are mediated by the interface — business logic has no direct gateway dependency

## Payment Flow

```
1. User fills donation form → POST /api/v1/campaigns/:id/donations
2. Server creates donation record: status = PENDING
3. Server calls gateway.initiatePayment(...)
4. Server creates payment_record: status = PENDING
5. Server returns { paymentUrl } to client
6. Client redirects to paymentUrl (gateway-hosted payment page)
7. User completes payment at gateway
8. Gateway calls POST /webhooks/payment/:provider (server-to-server)
9. Server verifies HMAC signature → reject if invalid
10. Server looks up webhook idempotency key → return 200 if already processed
11. In a single DB transaction:
    - Update payment_record: status = PAID, confirmed_at = NOW()
    - Update donation: status = PAID
    - Insert journal_lines (debit/credit) in ledger
    - Mark webhook_event: processed = true
12. Emit notification (email to donor)
```

## Webhook Security Requirements

1. **HMAC Verification**: Every webhook request is verified against the gateway's signature header before any processing.
2. **Idempotency**: The gateway's event ID is stored in `webhook_events`. Duplicate event IDs are silently accepted (return 200) without re-processing.
3. **Replay Protection**: Webhook events older than 24 hours are rejected (timestamp check).
4. **Raw Body Required**: HMAC is computed on the raw request body — no JSON parsing before verification.
5. **No Session Middleware**: The webhook endpoint must not have session middleware (different from user-facing routes).
6. **DB Transaction**: Payment state transitions happen inside a single PostgreSQL transaction. If the transaction fails, nothing is committed.

## Database Tables (Phase 5)

```sql
donations (
  id UUID PK,
  campaign_id UUID REFERENCES campaigns(id),
  user_id UUID REFERENCES users(id),  -- nullable for anonymous donations
  donor_name TEXT,
  donor_email TEXT,
  amount NUMERIC(15,2) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'IDR',
  status donation_status NOT NULL DEFAULT 'PENDING',
  payment_record_id UUID REFERENCES payment_records(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)

payment_records (
  id UUID PK,
  gateway TEXT NOT NULL,
  gateway_tx_ref TEXT NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  amount NUMERIC(15,2) NOT NULL,
  currency CHAR(3) NOT NULL,
  method TEXT,
  status payment_status NOT NULL DEFAULT 'PENDING',
  gateway_payload JSONB,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)

webhook_events (
  id UUID PK,
  provider TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_id TEXT UNIQUE NOT NULL,   -- gateway's unique event ID (idempotency key)
  payload JSONB NOT NULL,
  signature_verified BOOLEAN NOT NULL DEFAULT FALSE,
  processed BOOLEAN NOT NULL DEFAULT FALSE,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
```

## Campaign Total Derivation

**Never store a mutable `total_raised` column.**

Always derive the total:
```sql
SELECT COALESCE(SUM(amount), 0)
FROM donations
WHERE campaign_id = $1
  AND status = 'PAID';
```

Cache in Redis or a materialized view only if query performance requires it.

## Provider Selection (Phase 5 Decision)

Both Midtrans and Xendit are viable. Final provider choice is deferred to Phase 5.
The `PaymentGateway` interface ensures that switching providers later requires only a new adapter.

## Implementation Phase

Phase 5.
