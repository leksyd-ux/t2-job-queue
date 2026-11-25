# DEFENCE.md — Published Defence Questions & Answer Drafts

These are drafts to memorise and explain out loud. Line references point at the
committed code. Where a behaviour is simulated or limited, the answer says so.

---

## 1. Trace the Atomic Claim Query

**Question:** Walk line-by-line through your worker's claim query. What does `FOR UPDATE SKIP LOCKED` do, and why is standard `FOR UPDATE` insufficient when multiple worker instances run concurrently?

### Answer Draft

`WorkerEngine.claimJobs` in `src/worker/worker.ts:32-50` does one statement:

1. `:33` returns immediately when there are no free concurrency slots, so the
   SQL never claims more than `config.WORKER_CONCURRENCY` jobs.
2. `:35-46` is the single atomic statement:
   - `UPDATE jobs SET status='processing', started_at=now(), updated_at=now()`
     marks the rows as taken and records when work began.
   - `WHERE id IN (SELECT …)` chooses candidates in the same statement, so the
     selection and the state change cannot be separated by another worker.
   - The subquery filters `status IN ('pending','failed') AND run_at <= now()`
     (`:40`), so `dead` and already-`processing` jobs are never claimable.
   - `ORDER BY run_at ASC` takes the oldest due work first.
   - `FOR UPDATE` (`:42`) takes row-level write locks on the candidates inside
     the statement's transaction.
   - `SKIP LOCKED` tells Postgres to skip any row another worker already holds
     instead of waiting for that lock.
   - `LIMIT $1` (`:43`) bounds the batch to the available slots.
   - `RETURNING *` gives the worker the exact claimed rows.
3. `:48-49` returns those rows for processing.

Plain `FOR UPDATE` would make a second worker block on the first worker's rows.
With several workers that creates lock queues and can deadlock or stall the poll
loop. `SKIP LOCKED` lets each worker take a different free row immediately, so
exactly one worker claims each job and no worker waits on another. The partial
index `idx_jobs_claim` in `migrations/0001_init.sql:25-27` covers the filter.
`evidence/break-two-workers.log` records 10 + 10 unique claims with zero overlap.

---

## 2. Exponential Backoff & The Jitter Line

**Question:** Explain your exponential backoff formula. Why is random jitter added to the delay? What is the Thundering Herd Problem, and what happens to a recovering downstream service if jitter is omitted?

### Answer Draft

On failure, `src/worker/worker.ts:64-95`:

1. `:65` computes `newAttempts = job.attempts + 1`.
2. `:66` sets `isDead = newAttempts >= job.max_attempts`.
3. `:69-77` sets `run_at` to `now()` when dead, otherwise to
   `computeNextRunAt(newAttempts, BASE, CAP, JITTER)`.
4. `:79-95` persists `status` (`failed` or `dead`), the incremented attempts,
   `last_error`, and the new `run_at`.

The formula lives in `src/lib/backoff.ts:20-24`:
`delay = min(cap, base * 2^attempts) + floor(random() * (jitter + 1))`.
`base`, `cap` and `jitter` all come from the Zod-validated config, never from a
handler literal. With base 1000, cap 30000 and jitter 500, attempt 1 waits about
2 s and attempt 2 about 4 s, plus up to 500 ms of noise. The real RunAt values
are visible in `evidence/break-failure.log`.

Jitter exists because without it every job that failed in the same outage
computes the same delay and retries at the same millisecond. That synchronised
retry storm is the Thundering Herd Problem: a provider that has just recovered
is immediately hit by all retries at once and can fail again. Uniform additive
jitter spreads retries across a window. `tests/backoff.test.ts` proves growth,
the cap and the jitter bounds; the comment at `src/lib/backoff.ts:7-13` records
the reasoning.

---

## 3. Idempotent Enqueue & Deduplication

**Question:** How does the system handle duplicate job submissions? Explain what happens at both the HTTP API layer and the PostgreSQL database layer when two identical `idempotency_key` requests arrive at the exact same millisecond.

### Answer Draft

HTTP layer: `src/api/routes.ts:9-14` validates that `type` and
`idempotency_key` are present; `:46-65` always answers `202 Accepted` with
`data: job` and `meta.duplicate`. A duplicate is therefore not an error status.

Database layer: `src/api/repository.ts:44-49` inserts with a fresh UUIDv7 and
`ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`. The UNIQUE constraint is
declared at `migrations/0001_init.sql:20`, so Postgres is the final authority.

- If the INSERT returns a row, `:59-60` reports `isDuplicate: false`.
- If it returns no row, another request already owns that key; `:63-66` selects
  the existing row and reports `isDuplicate: true`.

With two simultaneous identical requests, one INSERT wins the unique-key race
and commits; the other gets a conflict, then its SELECT sees the committed row.
Neither request creates a second job or performs work inline.

The same idea protects the downstream side: `src/lib/provider.ts` inserts into
`provider_sends`, whose primary key is the idempotency key
(`migrations/0002_provider_sends.sql`). `tests/provider-idempotency.test.ts`
calls the send twice and proves one row and one message id. The provider is a
local simulation, not a real external email API — no credentials were supplied.

---

## 4. Crash Recovery (The `kill -9` Test & The Sweep Engine)

**Question:** If a worker process abruptly dies (e.g. out-of-memory error or `kill -9`) in the middle of executing a job, the job is left with `status = 'processing'`. How does the system detect and recover orphaned jobs without human intervention?

### Answer Draft

Claiming sets `status='processing'` and `started_at=now()`
(`src/worker/worker.ts:35-46`). If the worker dies before writing a terminal
state, that row stays `processing` forever unless something reconciles it.

`SweepEngine` in `src/sweep/sweep.ts` is a separate process:

1. `:20-26` selects `processing` rows whose `started_at` is older than
   `STUCK_TIMEOUT_MS`, using `FOR UPDATE SKIP LOCKED` so two sweepers do not
   fight over the same rows.
2. `:32` opens a transaction and `:34-35` reads the candidates.
3. `:38-40` increments attempts by one and chooses `dead` when retries are
   exhausted, otherwise `pending`.
4. `:42-53` updates status, attempts, `last_error`, `run_at=now()` and
   `started_at=NULL`. The `WHERE id=$3 AND status='processing'` guard stops the
   sweep from overwriting a row a live worker has already finished.
5. `:61` commits the batch; `:78-90` repeats on the configured interval.

The test sequence is captured in `evidence/kill-worker-state.log` and the three
`evidence/kill-worker-*.png` screenshots: before the kill the seeded job is
`processing` with 1 attempt; after `kill -9` it is still `processing`; the sweep
(with `STUCK_TIMEOUT_MS=5000` for the test) moved it to `pending` with 2
attempts; after restarting the worker it became `succeeded`.
`evidence/sweep-recovery.log` contains the real recovery lines.

Known limitation: there is no fencing token. If a *live but very slow* worker is
swept and then finishes, its late update could still overwrite the newer state.
The kill-9 case cannot do that because the process is gone.
