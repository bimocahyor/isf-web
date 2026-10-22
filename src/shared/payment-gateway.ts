/**
 * Payment gateway interface boundary.
 *
 * All payment gateway implementations MUST satisfy this interface.
 * This allows swapping providers (Midtrans, Xendit, etc.) without
 * changing business logic.
 *
 * IMPLEMENTED IN PHASE 5. This file defines the interface contract only.
 *
 * Available implementations (Phase 5):
 *   MockPaymentGateway       — local development and testing
 *   MidtransPaymentGateway   — Midtrans Snap / Core API
 *   XenditPaymentGateway     — Xendit invoices / payment links
 *
 * Critical architectural rules:
 *   1. A client-side button click or redirect is NOT payment confirmation.
 *   2. Donations are PENDING until a verified server-side webhook marks them PAID.
 *   3. Webhook payloads are verified with HMAC before any state change.
 *   4. Processed event IDs are stored for replay protection.
 *   5. All payment state transitions happen inside a database transaction.
 *   6. Payment records are never hard-deleted.
 *   7. Campaign totals are always derived — never stored as a mutable balance.
 *
 * See docs/adr/008-payments.md for architecture details.
 */

// ---------------------------------------------------------------------------
// Value objects
// ---------------------------------------------------------------------------

/** The result of initiating a payment at the gateway. */
export interface PaymentInitResult {
  /** Gateway-assigned transaction reference (external ID). */
  gatewayTransactionRef: string;
  /** URL to redirect the user to for completing payment. */
  paymentUrl: string;
  /** ISO-8601 expiry time for the payment link. */
  expiresAt: string;
}

/** Notification received from the gateway (parsed, not raw). */
export interface WebhookNotification {
  /** Unique event ID from the gateway — used for idempotency. */
  eventId: string;
  /** Gateway-assigned transaction reference. */
  gatewayTransactionRef: string;
  /** Normalized payment status. */
  status: 'pending' | 'paid' | 'failed' | 'expired' | 'refunded';
  /** Amount in smallest currency unit (e.g., cents for IDR). */
  amount: number;
  /** ISO-4217 currency code (e.g., 'IDR'). */
  currency: string;
  /** ISO-8601 timestamp of the event at the gateway. */
  occurredAt: string;
  /** Raw gateway-specific payload for reconciliation. */
  rawPayload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * Payment gateway interface.
 * All gateway adapters must implement this interface.
 */
export interface PaymentGateway {
  readonly name: string;

  /**
   * Initiate a payment at the gateway.
   * Returns a payment URL to redirect the user to.
   * The donation is created as PENDING before calling this method.
   */
  initiatePayment(params: {
    donationId: string;
    amount: number;
    currency: string;
    description: string;
    customerEmail?: string;
    customerName?: string;
    callbackUrl: string;
    successUrl: string;
  }): Promise<PaymentInitResult>;

  /**
   * Verify and parse an incoming webhook notification.
   *
   * @param rawBody  The raw request body (Buffer or string) for HMAC verification.
   * @param headers  The request headers.
   * @returns Parsed notification, or throws if signature is invalid.
   */
  verifyAndParseWebhook(
    rawBody: Buffer | string,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<WebhookNotification>;
}

// ---------------------------------------------------------------------------
// Mock implementation (for tests and local development)
// ---------------------------------------------------------------------------

/**
 * Mock payment gateway for local development and tests.
 * Does NOT make real HTTP calls. Does NOT process real money.
 *
 * Implemented in Phase 5.
 */
export class MockPaymentGateway implements PaymentGateway {
  readonly name = 'mock';

  initiatePayment(params: {
    donationId: string;
    amount: number;
    currency: string;
    description: string;
    customerEmail?: string;
    customerName?: string;
    callbackUrl: string;
    successUrl: string;
  }): Promise<PaymentInitResult> {
    // Phase 5 implementation placeholder
    void params;
    return Promise.reject(new Error('MockPaymentGateway.initiatePayment: not yet implemented (Phase 5)'));
  }

  verifyAndParseWebhook(
    rawBody: Buffer | string,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<WebhookNotification> {
    // Phase 5 implementation placeholder
    void rawBody;
    void headers;
    return Promise.reject(new Error('MockPaymentGateway.verifyAndParseWebhook: not yet implemented (Phase 5)'));
  }
}
