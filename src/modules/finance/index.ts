/**
 * Finance module — boundary stub.
 *
 * Phase 6 will implement the double-entry financial ledger and liability tracking.
 *
 * ARCHITECTURAL RULES (non-negotiable):
 *
 * 1. Append-only ledger: journal entries are never updated or deleted.
 *    Corrections use reversal transactions.
 *
 * 2. Double-entry: every financial event produces balanced journal lines.
 *    SUM(DEBIT lines) = SUM(CREDIT lines) within a single journal_transaction.
 *
 * 3. No mutable balance: account balances are always DERIVED from journal_lines.
 *    There is no "balance" column anywhere. Derived balance query:
 *      SELECT
 *        SUM(amount) FILTER (WHERE type = 'CREDIT') -
 *        SUM(amount) FILTER (WHERE type = 'DEBIT')
 *      FROM journal_lines WHERE account_id = ?
 *
 * 4. NUMERIC only: all monetary amounts use NUMERIC(15,2) in PostgreSQL.
 *    FLOAT/REAL/DOUBLE are strictly forbidden for money.
 *
 * 5. Maker-checker: high-risk financial transactions require a second approver.
 *    The transaction creator cannot approve their own transaction by default.
 *
 * 6. Reversal pattern: to correct a posted entry, create a reversal transaction
 *    (identical amounts with swapped debit/credit) and a correcting transaction.
 *    Both must be posted atomically in a DB transaction.
 *
 * 7. Accounting periods: journal_transactions must belong to an open period.
 *    Closed periods are immutable.
 *
 * Core entities (Phase 6):
 *   ledger_accounts       — chart of accounts
 *   accounting_periods    — financial periods (OPEN / CLOSING / CLOSED)
 *   journal_transactions  — posted transaction headers (immutable after posting)
 *   journal_lines         — individual debit/credit lines (immutable after posting)
 *   liabilities           — outstanding obligations (OUTSTANDING / PARTIAL / PAID)
 *   liability_payments    — links liabilities to journal_lines
 *   financial_evidence    — supporting documents linked to transactions
 *
 * See docs/adr/009-finance-ledger.md for the complete design.
 */

export {};
