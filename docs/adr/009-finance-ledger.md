# ADR-009: Financial Ledger Architecture

**Status:** Accepted  
**Date:** 2025

## Non-Negotiable Principles

These rules are architectural constraints, not suggestions. Violating them creates unauditable financial records.

### 1. Append-Only Ledger

Journal entries are **never** updated or deleted after posting.
Corrections are made via reversal transactions (see below).

### 2. Double-Entry

Every financial event produces a balanced set of journal lines:
```
SUM(DEBIT lines) = SUM(CREDIT lines)
```
within a single `journal_transaction`.

If this balance constraint is not satisfied, the transaction must be rejected.
This constraint is enforced both in application code and as a PostgreSQL CHECK constraint.

### 3. No Mutable Balance

There is no `balance` column anywhere.
Account balances are always derived:
```sql
SELECT
  COALESCE(SUM(amount) FILTER (WHERE type = 'CREDIT'), 0) -
  COALESCE(SUM(amount) FILTER (WHERE type = 'DEBIT'), 0) AS balance
FROM journal_lines
WHERE account_id = $1
  AND transaction_id IN (
    SELECT id FROM journal_transactions WHERE status = 'POSTED'
  );
```

### 4. NUMERIC Only

All monetary amounts: `NUMERIC(15,2)`.
FLOAT, REAL, and DOUBLE PRECISION are forbidden in any column storing money.

### 5. Reversal Pattern

To correct a posted journal entry:
1. Create a reversal transaction: identical journal lines with DEBIT/CREDIT swapped.
2. Create a correcting transaction with the correct values.
3. Both transactions are created atomically in a single PostgreSQL transaction.
4. The reversal links to the original via `reverses_transaction_id`.

### 6. Accounting Periods

Journal transactions must reference an `accounting_period`.
Closed periods are immutable — no new transactions can be posted to a closed period.

### 7. Maker-Checker Approval

High-risk transactions require a second approver.
The user who creates a DRAFT transaction cannot approve their own transaction.
This is enforced in the service layer.

## Database Tables

```sql
ledger_accounts (
  id UUID PK,
  code VARCHAR UNIQUE NOT NULL,   -- e.g. 'DONATIONS_IN', 'SCHOLARSHIP_OUT'
  name TEXT NOT NULL,
  type account_type NOT NULL,     -- ASSET, LIABILITY, INCOME, EXPENSE, EQUITY
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  -- NO updated_at: account metadata changes via audit, not edits
)

accounting_periods (
  id UUID PK,
  name VARCHAR NOT NULL,          -- e.g. '2026-Q1'
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status period_status NOT NULL DEFAULT 'OPEN',  -- OPEN, CLOSING, CLOSED
  closed_at TIMESTAMPTZ,
  closed_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)

journal_transactions (
  id UUID PK,
  period_id UUID REFERENCES accounting_periods(id) NOT NULL,
  description TEXT NOT NULL,
  status tx_status NOT NULL DEFAULT 'DRAFT',  -- DRAFT, PENDING_APPROVAL, POSTED, REVERSED
  reference_type TEXT,            -- 'donation', 'disbursement', 'liability_payment', etc.
  reference_id UUID,              -- FK to the source entity
  reverses_transaction_id UUID REFERENCES journal_transactions(id),  -- if this is a reversal
  created_by UUID REFERENCES users(id) NOT NULL,
  approved_by UUID REFERENCES users(id),
  posted_by UUID REFERENCES users(id),
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  -- NO updated_at: transactions are immutable after posting
)

journal_lines (
  id UUID PK,
  transaction_id UUID REFERENCES journal_transactions(id) NOT NULL,
  account_id UUID REFERENCES ledger_accounts(id) NOT NULL,
  type line_type NOT NULL,        -- DEBIT, CREDIT
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL DEFAULT 'IDR',
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  -- NO updated_at: lines are immutable
)

-- Balance constraint enforced via trigger or application-level check:
-- SUM(amount WHERE type='DEBIT') = SUM(amount WHERE type='CREDIT') per transaction

liabilities (
  id UUID PK,
  type liability_type NOT NULL,   -- TUITION, BILL, OPERATIONAL, OTHER
  beneficiary_id UUID REFERENCES users(id),
  total_amount NUMERIC(15,2) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'IDR',
  due_date DATE,
  status liability_status NOT NULL DEFAULT 'OUTSTANDING',  -- OUTSTANDING, PARTIAL, PAID
  description TEXT NOT NULL,
  created_by UUID REFERENCES users(id) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)

liability_payments (
  id UUID PK,
  liability_id UUID REFERENCES liabilities(id) NOT NULL,
  journal_line_id UUID REFERENCES journal_lines(id) NOT NULL,
  amount NUMERIC(15,2) NOT NULL,
  paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)

financial_evidence (
  id UUID PK,
  transaction_id UUID REFERENCES journal_transactions(id) NOT NULL,
  storage_key TEXT NOT NULL,      -- S3 object key
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  uploaded_by UUID REFERENCES users(id) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
```

## Seed: Chart of Accounts

```
Code                Type        Name
CASH_AND_BANK       ASSET       Cash and Bank
RECEIVABLES         ASSET       Receivables
DONATIONS_IN        INCOME      Donation Income
SCHOLARSHIP_OUT     EXPENSE     Scholarship Disbursements
TUITION_OUT         EXPENSE     Tuition Payments
ALLOWANCE_OUT       EXPENSE     Living Allowance Disbursements
BOOK_GRANT_OUT      EXPENSE     Book and Research Grants
OPERATIONAL_OUT     EXPENSE     Operational Expenses
SCHOLARSHIP_LIAB    LIABILITY   Scholarship Obligations
```

## Implementation Phase

Phase 6.
