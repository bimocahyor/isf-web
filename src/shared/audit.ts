/**
 * Audit log service.
 *
 * Records security-sensitive and financial actions to the audit_logs table.
 * The audit log is append-only — entries are never updated or deleted.
 *
 * Each entry captures:
 *   - who performed the action (actor_id, actor_email)
 *   - what the action was (action string)
 *   - what entity was affected (entity_type, entity_id)
 *   - contextual information (IP, user agent, metadata)
 *   - when it happened (created_at, always TIMESTAMPTZ)
 *
 * Fire-and-forget vs awaited:
 *   Security-critical events (login, logout, password reset, role change,
 *   authorization denial) use recordAuditEventCritical() which AWAITS the
 *   database write and logs a warning if it fails, but still never throws
 *   to the caller.
 *
 *   Low-priority informational events use recordAuditEvent() (fire-and-forget).
 *
 * Never log: passwords, password hashes, raw tokens, session secrets.
 */

import { getPool } from '../db/client.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Audit action constants
// ---------------------------------------------------------------------------

export const AuditAction = {
  // Authentication
  USER_REGISTERED: 'user.registered',
  LOGIN_SUCCESS: 'auth.login.success',
  LOGIN_FAILED: 'auth.login.failed',
  LOGOUT: 'auth.logout',
  // Password
  PASSWORD_CHANGED: 'user.password.changed',
  PASSWORD_RESET_REQUESTED: 'user.password.reset.requested',
  PASSWORD_RESET_COMPLETED: 'user.password.reset.completed',
  // Email
  EMAIL_VERIFICATION_SENT: 'user.email.verification.sent',
  EMAIL_VERIFIED: 'user.email.verified',
  // Authorization
  AUTHORIZATION_DENIED: 'auth.authorization.denied',
  // Account management
  ACCOUNT_DEACTIVATED: 'user.account.deactivated',
  ACCOUNT_REACTIVATED: 'user.account.reactivated',
  ROLE_CHANGED: 'user.role.changed',
} as const;

export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];

// ---------------------------------------------------------------------------
// Event shape
// ---------------------------------------------------------------------------

export interface AuditEventInput {
  /** ID of the user who performed the action (null for anonymous/system). */
  actorId?: string | null;
  /** Email of the actor at the time of the event. */
  actorEmail?: string | null;
  /** Action identifier — use AuditAction constants. */
  action: string;
  /** Type of entity affected (e.g., 'user', 'article', 'application'). */
  entityType?: string | null;
  /** ID of the entity affected. */
  entityId?: string | null;
  /** Client IP address (extracted from request). */
  ipAddress?: string | null;
  /** User-Agent string from the request. */
  userAgent?: string | null;
  /** Additional structured context. */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Internal write function
// ---------------------------------------------------------------------------

async function _writeAuditEvent(event: AuditEventInput): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO audit_logs
      (actor_id, actor_email, action, entity_type, entity_id,
       ip_address, user_agent, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      event.actorId ?? null,
      event.actorEmail ?? null,
      event.action,
      event.entityType ?? null,
      event.entityId ?? null,
      event.ipAddress ?? null,
      event.userAgent ?? null,
      JSON.stringify(event.metadata ?? {}),
    ],
  );
}

// ---------------------------------------------------------------------------
// Fire-and-forget audit write (informational events)
// ---------------------------------------------------------------------------

/**
 * Persist an audit event to the database — fire-and-forget.
 *
 * This function NEVER throws. If the insert fails, the error is logged
 * at error level but the calling code is not interrupted.
 *
 * Use for informational events where loss is acceptable.
 * Use recordAuditEventCritical() for security-critical events.
 */
export function recordAuditEvent(event: AuditEventInput): void {
  void (async () => {
    try {
      await _writeAuditEvent(event);
    } catch (err) {
      logger.error(
        { err, action: event.action, actorId: event.actorId },
        'Failed to write audit log entry',
      );
    }
  })();
}

// ---------------------------------------------------------------------------
// Awaited audit write (security-critical events)
// ---------------------------------------------------------------------------

/**
 * Persist a security-critical audit event — awaited but never throws.
 *
 * Awaits the database write to ensure durability before the response is sent.
 * If the write fails, logs a warning and continues — does NOT fail the request.
 *
 * Use for: login success/failure, logout, password reset, authorization denial,
 * role changes, email verification.
 */
export async function recordAuditEventCritical(
  event: AuditEventInput,
): Promise<void> {
  try {
    await _writeAuditEvent(event);
  } catch (err) {
    // Log at warn level — audit failure on a critical event is noteworthy
    // but must never block the user-facing response.
    logger.warn(
      { err, action: event.action, actorId: event.actorId },
      'Failed to write critical audit log entry — possible audit gap',
    );
  }
}
