-- 0001_init.sql: Schema for background job queue (Task 2)

DO $$ BEGIN
    CREATE TYPE job_status AS ENUM ('pending', 'processing', 'succeeded', 'failed', 'dead');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS jobs (
    id UUID PRIMARY KEY,
    type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status job_status NOT NULL DEFAULT 'pending',
    attempts INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 5,
    last_error TEXT,
    run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partial index to serve atomic claim query: FOR UPDATE SKIP LOCKED
CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs (run_at ASC)
WHERE status IN ('pending', 'failed');

-- Index for stuck worker recovery sweep
CREATE INDEX IF NOT EXISTS idx_jobs_stuck_sweep ON jobs (started_at ASC)
WHERE status = 'processing';

-- Indexes for status filtering and dead letter inspections
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs (created_at DESC);
