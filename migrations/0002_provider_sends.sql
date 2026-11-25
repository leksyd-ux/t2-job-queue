-- 0002_provider_sends.sql: downstream idempotency ledger (T2-R13).
-- A real transactional email provider deduplicates on its idempotency key.
-- This table models that behaviour locally so a double run can be proven.

CREATE TABLE IF NOT EXISTS provider_sends (
    idempotency_key TEXT PRIMARY KEY,
    provider_message_id TEXT NOT NULL,
    recipient TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_provider_sends_created_at ON provider_sends (created_at DESC);
