/**
 * Notifications module — boundary stub.
 *
 * Future phases will implement:
 *   - Transactional email via Nodemailer (SMTP)
 *   - Email templates for:
 *       - Email verification
 *       - Password reset
 *       - Application status change
 *       - Scholarship award notification
 *       - Donation confirmation
 *       - Review assignment
 *
 * All email credentials must be configured via environment variables.
 * For local development, Mailpit is used as a local SMTP sink.
 * Email bodies must not contain sensitive data (passwords, tokens in clear text).
 * Reset/verification tokens in emails must be short-lived (≤1 hour).
 */

export {};
