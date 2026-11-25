# EVIDENCE.md — Task 2: Background Jobs Done Properly (`t2-job-queue`)

All proof below was produced on 2026-11-25 against the local Postgres database
`job_queue`, the Fastify API on port 3001 and the console on port 5174. No proof
was invented: every log is captured command output and every screenshot is a
headless-Chrome capture of the running app.

| Requirement ID | What it proves | Proof (file/screenshot/log) | Command to produce | Date | Produced by |
|---|---|---|---|---|---|
| **T2-R01** | All required job columns exist | `evidence/schema.log` | `psql "$DATABASE_URL" -c '\d jobs'` | 2026-11-25 | Build agent (user-authorized) |
| **T2-R02** | Status enum allows exactly five states | `evidence/schema.log`, `migrations/0001_init.sql` | `psql "$DATABASE_URL" -c '\d jobs'` | 2026-11-25 | Build agent (user-authorized) |
| **T2-R03** | `failed` (retryable) is documented separately from `dead` (human) | `README.md` §1 | `sed -n '7,30p' README.md` | 2026-11-25 | Build agent (user-authorized) |
| **T2-R04** | POST enqueue returns 202 + id and performs no work inline | `tests/idempotency.test.ts`, `evidence/verification.log` | `npm test -- tests/idempotency.test.ts` | 2026-11-25 | Build agent (user-authorized) |
| **T2-R05** | Duplicate key returns the existing job via the DB UNIQUE constraint | `evidence/break-duplicate.log` | `npm run break:duplicate` | 2026-11-25 | Build agent (user-authorized) |
| **T2-R06** | Worker runs as its own process | `src/worker/index.ts`, `evidence/worker.log` | `npm run dev:worker` | 2026-11-25 | Build agent (user-authorized) |
| **T2-R07** | One atomic `UPDATE … FOR UPDATE SKIP LOCKED` claim | `src/worker/worker.ts`, `evidence/break-two-workers.log` | `npm run break:two-workers` | 2026-11-25 | Build agent (user-authorized) |
| **T2-R08** | Only pending/failed with `run_at <= now()` are claimed | `tests/claim.test.ts`, `evidence/schema.log` (partial claim index) | `npm test -- tests/claim.test.ts` | 2026-11-25 | Build agent (user-authorized) |
| **T2-R09** | Concurrency cap of 5 held during 50 jobs | `evidence/break-concurrency.log` | `npm run break:concurrency` | 2026-11-25 | Build agent (user-authorized) |
| **T2-R10** | Failed attempt increments `attempts` and stores `last_error` | `evidence/break-failure.log`, `evidence/worker.log` | `npm run break:failure` | 2026-11-25 | Build agent (user-authorized) |
| **T2-R11** | Backoff grows exponentially with additive jitter | `src/lib/backoff.ts`, `tests/backoff.test.ts`, `evidence/break-failure.log` (future `RunAt` values) | `npm test -- tests/backoff.test.ts` | 2026-11-25 | Build agent (user-authorized) |
| **T2-R12** | Exhausted retries become `dead` | `evidence/break-failure.log`, `evidence/console-dead_letters.png` | `npm run break:failure` | 2026-11-25 | Build agent (user-authorized) |
| **T2-R13** | A double run produces one downstream send | `evidence/provider-idempotency.log`, `src/lib/provider.ts`, `migrations/0002_provider_sends.sql` | `npm test -- tests/provider-idempotency.test.ts` | 2026-11-25 | Build agent (user-authorized) |
| **T2-R14** | Stuck `processing` jobs are recovered to pending with +1 attempt | `evidence/kill-worker-state.log`, `evidence/sweep-recovery.log`, `evidence/kill-worker-before.png`, `evidence/kill-worker-after.png`, `evidence/kill-worker-recovered.png` | Seed one in-flight row; `kill -9` worker; run sweep with `STUCK_TIMEOUT_MS=5000`; restart worker | 2026-11-25 | Build agent (user-authorized) |
| **T2-R15** | Dead letter view and manual retry work | `evidence/console-dead_letters.png`, `evidence/dead-retry.log` | `curl -X POST http://localhost:3001/api/dead-letters/<id>/retry` | 2026-11-25 | Build agent (user-authorized) |
| **T2-R16** | `GET /api/jobs/:id` returns a single job | `evidence/job-by-id.log` | `curl http://localhost:3001/api/jobs/<id>` | 2026-11-25 | Build agent (user-authorized) |
| **T2-R17** | All tunables are Zod-validated at startup | `config/index.ts`, `.env.example`, `evidence/verification.log` | `npm run typecheck` | 2026-11-25 | Build agent (user-authorized) |
| **Kill test** | Worker killed with SIGKILL and recovered by sweep | `evidence/kill-worker-*.png`, `evidence/kill-worker-state.log`, `evidence/sweep-recovery.log` | See `evidence/kill-worker-state.log` for before/after/after-restart states | 2026-11-25 | Build agent (user-authorized) |
| **Console UI** | Three views, five badges, processing N/N, detail drawer | `evidence/console-jobs.png`, `evidence/console-trigger.png`, `evidence/console-dead_letters.png` | Chrome headless at `http://localhost:5174/?view=jobs\|trigger\|dead_letters` | 2026-11-25 | Build agent (user-authorized) |
| **Two workers** | Zero duplicate claims across competing workers | `evidence/break-two-workers.log` | `npm run break:two-workers` | 2026-11-25 | Build agent (user-authorized) |
| **Verification** | Lint, typecheck, tests and console build all pass | `evidence/verification.log` | `npm run lint && npm run typecheck && npm test && (cd console && npm run build)` | 2026-11-25 | Build agent (user-authorized) |

## Honest limitations

- The transactional email provider is **simulated locally**. There is no real
  third-party API key; `EMAIL_PROVIDER_API_KEY` is a placeholder and no external
  email is sent. The idempotency guarantee is real: `provider_sends` has a UNIQUE
  key and the test proves one ledger row for two executions.
- The console-screenshot statuses were produced by seeding four explicit fixture
  rows with SQL (`console_*_fixture`) in addition to the jobs created by the
  break-it scripts. They are real rows in the database, not edited screenshots.
- The kill-worker sequence was run by the build agent because the student
  explicitly authorised it in this session; normally the student performs it.
- The sweep timeout was shortened to 5000 ms only for the recovery test via an
  environment override. The committed default remains 60000 ms.
- The console is pointed at `http://localhost:3001`. A public deployment URL was
  not provided, so no public-URL check was performed.
