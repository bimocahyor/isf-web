/**
 * Audit module — boundary stub.
 *
 * Phase 1 will implement foundational audit logging.
 * Later phases extend it for financial and document access events.
 *
 * The audit_logs table records:
 *   - actor_id         → who performed the action
 *   - action           → what was done (e.g. 'auth:login', 'application:submit')
 *   - entity_type      → the type of entity affected (e.g. 'application')
 *   - entity_id        → the UUID of the affected entity
 *   - before_state     → JSONB snapshot before the change (where applicable)
 *   - after_state      → JSONB snapshot after the change (where applicable)
 *   - ip_address       → client IP
 *   - user_agent       → client user-agent string
 *   - created_at       → TIMESTAMPTZ of the event
 *
 * Sensitive field values must be REDACTED before storing in before/after states.
 * Audit logs are append-only and must never be deleted.
 *
 * Security events that must always be logged:
 *   - Authentication: login, logout, failed login, password change, password reset
 *   - Authorization: access denied events
 *   - User management: role changes, account creation, soft-delete
 *   - Document access: who accessed which private document and when
 *   - Financial: all journal transaction creations, approvals, postings, reversals
 *   - Application: status transitions
 */

export {};
