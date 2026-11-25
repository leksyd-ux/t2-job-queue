# t2-job-queue — Background Jobs Done Properly

Production-grade background job queue built directly on **PostgreSQL 16**, **Fastify**, and **TypeScript**. Moves slow and unreliable tasks off the HTTP request path, handles retries with exponential backoff and jitter, and guarantees atomic execution without external message brokers.

---

## 1. Job Lifecycle & Schema (T2-R01, T2-R02, T2-R03)

### State Machine Lifecycle
```
[POST /api/jobs]
       │
       ▼
    pending
       │
       ▼ (Atomic claim via FOR UPDATE SKIP LOCKED)
   processing
    ├───► succeeded (work completed successfully)
    │
    ├───► failed    (transient error, retries remaining; run_at set to future backoff)
    │        │
    │        └─► (claimed again when now() >= run_at) ──► processing
    │
    └───► dead      (attempts >= max_attempts; exhausted, moved to Dead Letter Queue)
```

### Distinction: `failed` vs `dead`
- **`failed`**: The job encountered a transient error (e.g. rate limit, 503 from external email API). It still has retries remaining (`attempts < max_attempts`). The worker sets `status = 'failed'` and computes a future `run_at` using exponential backoff with jitter. Workers will automatically re-claim this job once `run_at <= now()`.
- **`dead`**: The job has exhausted all allowed attempts (`attempts >= max_attempts`). It is quarantined in the Dead Letter Queue (DLQ). Workers will **never** automatically claim a dead job. It requires human inspection or manual intervention via `POST /api/dead-letters/:id/retry`.

---

## 2. Atomic Claim Query (T2-R07, T2-R08)

The worker process claims available jobs in a single atomic SQL statement:

```sql
UPDATE jobs
SET status = 'processing', started_at = now(), updated_at = now()
WHERE id IN (
  SELECT id FROM jobs
  WHERE status IN ('pending', 'failed') AND run_at <= now()
  ORDER BY run_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT $1 -- available concurrency slots
)
RETURNING *;
```

### Why `FOR UPDATE SKIP LOCKED`?
1. **Zero Race Conditions**: `FOR UPDATE` places exclusive row-level write locks on candidate rows inside the transaction.
2. **Lock Contention Elimination**: Standard `FOR UPDATE` forces competing transactions to wait until the lock is released. `SKIP LOCKED` instructs PostgreSQL to immediately skip already-locked rows and claim the next available row.
3. **No Double-Claims**: Even if 10 worker processes run simultaneously, each job is guaranteed to be claimed by exactly one worker.

---

## 3. Backoff Formula with Additive Jitter (T2-R11)

```ts
delay = Math.min(capMs, baseMs * Math.pow(2, attempts)) + Math.floor(Math.random() * (jitterMs + 1));
```

### Why is Jitter Essential? (The Thundering Herd Problem)
When a third-party service (e.g. email provider, SMS gateway) recovers from an outage, thousands of retrying jobs with pure exponential backoff would calculate the exact same delay and strike the service at the exact same millisecond. Jitter introduces uniform random noise, spreading retries evenly across time and allowing the downstream service to recover gracefully.

---

## 4. Design Decisions

### Decision 1: PostgreSQL vs Redis / BullMQ
- **Chosen**: PostgreSQL using `FOR UPDATE SKIP LOCKED`.
- **Alternative considered**: Redis + BullMQ.
- **Why Postgres won**: Zero multi-database consistency issues. Job enqueuing can be committed within the exact same database transaction as the business domain entities (e.g. creating an order and enqueuing its confirmation email in one atomic transaction). Eliminates the dual-write problem and reduces infrastructure complexity.

### Decision 2: Separate Worker & Sweep Processes
- **Chosen**: Independent Node.js processes for API, Worker, and Sweep.
- **Alternative considered**: In-process background timer (`setInterval`) inside the Fastify web server.
- **Why separate won**: Web requests and CPU/network-heavy background jobs cannot starve each other. The API server can be scaled independently of worker pools. If a worker process crashes (`kill -9`), the HTTP API remains unaffected and the sweep engine recovers orphaned jobs.

---

## 5. Setup & Running Instructions (X-R01)

### Prerequisites
- Node.js >= 20
- PostgreSQL >= 16

### Quick Start
```bash
cp .env.example .env
npm install
npm run migrate

# Terminal 1: Start API Server
npm run dev

# Terminal 2: Start Background Worker
npm run dev:worker

# Terminal 3: Start Sweep Engine (for crashed worker recovery)
npm run dev:sweep

# Terminal 4: Start Console UI
cd console && npm install && npm run dev
```

### Running Break-It Verification Tests
```bash
npm test
npm run break:concurrency   # Proves worker concurrency cap holds under 50 jobs
npm run break:failure       # Traces pending -> failed -> dead lifecycle
npm run break:duplicate     # Proves idempotency_key deduplication
npm run break:two-workers   # Proves zero double claims between competing workers
```
