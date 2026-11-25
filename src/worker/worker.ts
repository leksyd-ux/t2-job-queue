import pg from "pg";
import { config } from "../../config/index.js";
import { computeNextRunAt } from "../lib/backoff.js";
import { JobRecord } from "../api/repository.js";
import { processJob } from "./processor.js";

export class WorkerEngine {
  private isRunning = false;
  private activeCount = 0;
  private pool: pg.Pool;

  constructor(pool?: pg.Pool) {
    this.pool = pool || new pg.Pool({ connectionString: config.DATABASE_URL });
  }

  get activeSlots(): number {
    return this.activeCount;
  }

  /**
   * Atomic single-statement claim using PostgreSQL FOR UPDATE SKIP LOCKED (T2-R07, T2-R08).
   *
   * Defence Question Rationale:
   * 1. FOR UPDATE places a row-level write lock on selected candidate rows.
   * 2. SKIP LOCKED instructs PostgreSQL to immediately ignore any row already locked by
   *    another concurrent transaction/worker rather than waiting for the lock to release.
   * 3. Combined in a subquery inside UPDATE ... WHERE id IN (...), this ensures:
   *    - Exactly one worker claims each job.
   *    - No two workers ever claim the same job (zero double-claim race conditions).
   *    - Workers do not block or wait on each other (lock contention is eliminated).
   */
  async claimJobs(availableSlots: number): Promise<JobRecord[]> {
    if (availableSlots <= 0) return [];

    const claimSql = `
      UPDATE jobs
      SET status = 'processing', started_at = now(), updated_at = now()
      WHERE id IN (
        SELECT id FROM jobs
        WHERE status IN ('pending', 'failed') AND run_at <= now()
        ORDER BY run_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $1
      )
      RETURNING *;
    `;

    const res = await this.pool.query(claimSql, [availableSlots]);
    return res.rows;
  }

  async handleJobSuccess(job: JobRecord): Promise<void> {
    const successSql = `
      UPDATE jobs
      SET status = 'succeeded',
          finished_at = now(),
          updated_at = now()
      WHERE id = $1;
    `;
    await this.pool.query(successSql, [job.id]);
    console.log(`[Worker] ✅ Job ${job.id} (${job.type}) succeeded.`);
  }

  async handleJobFailure(job: JobRecord, err: Error): Promise<void> {
    const newAttempts = job.attempts + 1;
    const isDead = newAttempts >= job.max_attempts;
    const newStatus = isDead ? "dead" : "failed";

    // Exponential backoff with jitter (T2-R11)
    const nextRunAt = isDead
      ? new Date()
      : computeNextRunAt(
          newAttempts,
          config.BACKOFF_BASE_MS,
          config.BACKOFF_CAP_MS,
          config.JITTER_MS
        );

    const failSql = `
      UPDATE jobs
      SET status = $1,
          attempts = $2,
          last_error = $3,
          run_at = $4,
          updated_at = now()
      WHERE id = $5;
    `;

    await this.pool.query(failSql, [
      newStatus,
      newAttempts,
      err.message || "Unknown error",
      nextRunAt,
      job.id,
    ]);

    if (isDead) {
      console.error(
        `[Worker] 💀 Job ${job.id} exhausted all ${job.max_attempts} attempts. Moved to DEAD LETTER queue. Error: ${err.message}`
      );
    } else {
      console.warn(
        `[Worker] ⚠️ Job ${job.id} attempt ${newAttempts}/${job.max_attempts} failed. Status: 'failed'. Scheduled retry at: ${nextRunAt.toISOString()}. Error: ${err.message}`
      );
    }
  }

  async runSingleJob(job: JobRecord): Promise<void> {
    this.activeCount++;
    console.log(
      `[Worker] ⏳ Processing job ${job.id} | Active slots: ${this.activeCount}/${config.WORKER_CONCURRENCY}`
    );

    try {
      await processJob(job);
      await this.handleJobSuccess(job);
    } catch (err: any) {
      await this.handleJobFailure(job, err);
    } finally {
      this.activeCount--;
    }
  }

  async start(): Promise<void> {
    this.isRunning = true;
    console.log(
      `🚀 Background Worker started. Concurrency Cap: ${config.WORKER_CONCURRENCY} | Poll Interval: ${config.POLL_INTERVAL_MS}ms`
    );

    while (this.isRunning) {
      try {
        const availableSlots = config.WORKER_CONCURRENCY - this.activeCount;

        if (availableSlots > 0) {
          const claimedJobs = await this.claimJobs(availableSlots);

          if (claimedJobs.length > 0) {
            console.log(
              `[Worker] Claimed ${claimedJobs.length} job(s). Starting concurrent processing...`
            );
            for (const job of claimedJobs) {
              // Fire worker execution asynchronously without blocking the poll loop
              this.runSingleJob(job).catch((err) => {
                console.error(`Unhandled error processing job ${job.id}:`, err);
              });
            }
          }
        }
      } catch (err: any) {
        console.error("[Worker] Error in poll loop:", err.message);
      }

      await new Promise((resolve) => setTimeout(resolve, config.POLL_INTERVAL_MS));
    }
  }

  async stop(): Promise<void> {
    console.log("[Worker] Stopping worker poll loop. Draining active jobs...");
    this.isRunning = false;

    // Wait up to 5 seconds for in-flight tasks to settle
    let waits = 0;
    while (this.activeCount > 0 && waits < 50) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      waits++;
    }

    await this.pool.end();
    console.log("[Worker] Worker shutdown complete.");
  }
}
