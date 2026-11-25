# EXPLAIN.md — Codebase Architecture & Walkthrough

This document breaks down every module in `t2-job-queue` so you can defend your implementation line by line under questioning.

---

## 1. Modules Walkthrough

### `src/worker/worker.ts`
- **What it does**: Separate background daemon executing the poll loop, atomic job claim, task dispatch, and failure/retry scheduling.
- **Data flow**: Queries PostgreSQL using `FOR UPDATE SKIP LOCKED` -> acquires up to `availableSlots` rows -> launches `runSingleJob()` asynchronously up to `config.WORKER_CONCURRENCY` cap -> updates status to `succeeded` or `failed` / `dead`.
- **Failure behaviour**: If job execution throws, increments `attempts`, stores `last_error`, and computes future `run_at` using exponential backoff with jitter (or moves to `dead` if `attempts >= max_attempts`).
- **Key Line to Understand**:
  ```sql
  SELECT id FROM jobs
  WHERE status IN ('pending', 'failed') AND run_at <= now()
  ORDER BY run_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT $1
  ```
  *Why*: Row-level write lock that skips already-claimed rows across concurrent worker processes, eliminating lock contention and race conditions.

---

### `src/lib/backoff.ts`
- **What it does**: Implements truncated exponential backoff with additive uniform jitter.
- **Data flow**: Receives `(attempts, baseMs, capMs, jitterMs)` -> computes `min(cap, base * 2^attempts) + random(0, jitter)` -> returns future Date.
- **Failure behaviour**: Pure arithmetic function with lower bound 0.
- **Key Line to Understand**:
  ```ts
  const jitter = jitterMs > 0 ? Math.floor(Math.random() * (jitterMs + 1)) : 0;
  return Math.min(capMs, baseMs * Math.pow(2, attempts)) + jitter;
  ```
  *Why*: Without jitter, all failed jobs synchronize their retries and cause a Thundering Herd retry storm on recovering downstream dependencies.

---

### `src/sweep/sweep.ts`
- **What it does**: Periodic cleanup worker that detects and recovers jobs abandoned by crashed worker processes (`kill -9`, node reboot, out-of-memory).
- **Data flow**: Scans `jobs` where `status = 'processing'` and `started_at <= now() - STUCK_TIMEOUT_MS` -> increments attempts -> resets status back to `pending` (or `dead` if max attempts reached) and clears `started_at`.
- **Failure behaviour**: Transactions ensure jobs are recovered safely even if multiple sweep processes run.
- **Key Line to Understand**:
  ```sql
  WHERE status = 'processing' AND started_at <= now() - ($1 || ' milliseconds')::interval
  ```
  *Why*: Distinguishes healthy active processing jobs from crashed/stuck worker jobs.

---

### `src/api/repository.ts`
- **What it does**: Handles atomic idempotent job creation and querying.
- **Data flow**: Client sends `idempotency_key` -> attempts `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING` -> if conflict, selects existing job row and returns it with 202 Accepted.
- **Failure behaviour**: PostgreSQL unique index enforces single-row integrity under concurrent requests.
- **Key Line to Understand**:
  ```sql
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING *;
  ```
  *Why*: Guarantees idempotency at the database storage engine layer rather than fragile application-level checks.

---

## 2. The Three Lines to Master Before Defence

1. **The Atomic Claim Query** ([src/worker/worker.ts#L48](file:///Users/leksyd/Desktop/5%20build/t2-job-queue/src/worker/worker.ts#L48)):
   ```sql
   FOR UPDATE SKIP LOCKED
   ```
   *(Why: Locks the row and skips rows locked by other concurrent workers. Prevents double execution without blocking).*

2. **The Jitter Line** ([src/lib/backoff.ts#L25](file:///Users/leksyd/Desktop/5%20build/t2-job-queue/src/lib/backoff.ts#L25)):
   ```ts
   const jitter = jitterMs > 0 ? Math.floor(Math.random() * (jitterMs + 1)) : 0;
   ```
   *(Why: Prevents the Thundering Herd Problem by desynchronizing worker retries).*

3. **Stuck Job Recovery Threshold** ([src/sweep/sweep.ts#L24](file:///Users/leksyd/Desktop/5%20build/t2-job-queue/src/sweep/sweep.ts#L24)):
   ```sql
   WHERE status = 'processing' AND started_at <= now() - ($1 || ' milliseconds')::interval
   ```
   *(Why: Automatically resurrects jobs left in limbo when a worker process gets killed via `kill -9`).*
