/**
 * Fundraising module — boundary stub.
 *
 * Phase 5 will implement:
 *   - Fundraising campaign management
 *   - Public donation form
 *   - Payment gateway integration (Midtrans or Xendit)
 *   - Webhook receiver with HMAC signature verification
 *   - Idempotent donation status transitions
 *   - Campaign totals derived from confirmed donations only
 *
 * CRITICAL payment security rules:
 *   1. A client-side button click or redirect is NOT proof of payment.
 *   2. Donation status is set to PAID only after a verified server-side webhook.
 *   3. Webhook payloads are verified with HMAC before processing.
 *   4. Each webhook event has a unique gateway event ID stored for idempotency.
 *   5. Duplicate webhook events are detected and silently accepted (200 response).
 *   6. Payment state transitions happen inside a DB transaction with ledger entry.
 *   7. Campaign totals are derived: SELECT SUM(amount) WHERE status = 'PAID'.
 *
 * See docs/adr/008-payments.md for full webhook and payment architecture.
 */

export {};
