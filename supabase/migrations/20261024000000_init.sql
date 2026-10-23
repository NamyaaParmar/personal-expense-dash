-- Ledger schema.
-- The app talks to PostgREST with the anon key, so this migration creates the
-- tables it reads/writes plus permissive RLS policies for the anon role.
-- Use one Supabase project per person; do not ship the anon key publicly.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Transactions (money out and money in)
CREATE TABLE IF NOT EXISTS transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    type TEXT NOT NULL DEFAULT 'debit' CHECK (type IN ('debit','credit')),
    amount NUMERIC(12, 2) NOT NULL,
    category TEXT,
    merchant_raw TEXT,
    merchant_display TEXT,
    note TEXT,
    txn_date DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sms_raw TEXT,
    is_reimbursable BOOLEAN NOT NULL DEFAULT FALSE,
    balance_after NUMERIC(12, 2),
    reimbursed_txn_id UUID
);
CREATE INDEX IF NOT EXISTS transactions_date_idx
    ON transactions (txn_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS transactions_type_date_idx
    ON transactions (type, txn_date DESC, created_at DESC);

-- 2. Investments & holdings
CREATE TABLE IF NOT EXISTS investments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'mutual_fund',
    source TEXT NOT NULL DEFAULT 'manual',
    units NUMERIC(18, 4) NOT NULL DEFAULT 0,
    avg_buy_price NUMERIC(12, 4),
    invested_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
    current_value NUMERIC(12, 2),
    ticker TEXT,
    mode TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Debts & reimbursements
CREATE TABLE IF NOT EXISTS people (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    upi_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS debts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    person_id UUID REFERENCES people(id) ON DELETE CASCADE,
    amount NUMERIC(12, 2) NOT NULL,
    amount_settled NUMERIC(12, 2) NOT NULL DEFAULT 0,
    reason TEXT,
    debt_date DATE NOT NULL DEFAULT CURRENT_DATE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','settled')),
    settled_date TIMESTAMPTZ,
    linked_txn_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Household spending your parents reimburse. txn_id links a pending
-- reimbursement to its expense; settled_txn_id links the credit that paid it.
CREATE TABLE IF NOT EXISTS household_reimbursements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    txn_id UUID REFERENCES transactions(id) ON DELETE CASCADE,
    amount NUMERIC(12, 2) NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','settled')),
    settled_date TIMESTAMPTZ,
    settled_txn_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Recurring income, used to keep salary/stipend credits out of debt matching.
CREATE TABLE IF NOT EXISTS income_sources (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    expected_amount NUMERIC(12, 2),
    frequency TEXT DEFAULT 'monthly',
    credit_keyword TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Merchant -> category memory ("Remember this merchant" in the add sheet).
CREATE TABLE IF NOT EXISTS merchant_mappings (
    raw_name TEXT PRIMARY KEY,
    display_name TEXT,
    category TEXT
);

-- ---------------------------------------------------------------------------
-- RLS. This build has no login flow: the browser sends the anon key, so each
-- table needs an anon policy or the app will see empty results.
-- ---------------------------------------------------------------------------
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE investments ENABLE ROW LEVEL SECURITY;
ALTER TABLE people ENABLE ROW LEVEL SECURITY;
ALTER TABLE debts ENABLE ROW LEVEL SECURITY;
ALTER TABLE household_reimbursements ENABLE ROW LEVEL SECURITY;
ALTER TABLE income_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchant_mappings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ledger_all ON transactions;
DROP POLICY IF EXISTS ledger_all ON investments;
DROP POLICY IF EXISTS ledger_all ON people;
DROP POLICY IF EXISTS ledger_all ON debts;
DROP POLICY IF EXISTS ledger_all ON household_reimbursements;
DROP POLICY IF EXISTS ledger_all ON income_sources;
DROP POLICY IF EXISTS ledger_all ON merchant_mappings;

CREATE POLICY ledger_all ON transactions               FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY ledger_all ON investments                FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY ledger_all ON people                     FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY ledger_all ON debts                      FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY ledger_all ON household_reimbursements   FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY ledger_all ON income_sources             FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY ledger_all ON merchant_mappings          FOR ALL TO anon USING (true) WITH CHECK (true);

GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;
