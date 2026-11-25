import pg from "pg";
import { config } from "../../config/index.js";
import { JobRecord } from "../api/repository.js";

export class SweepEngine {
  private isRunning = false;
  private pool: pg.Pool;

  constructor(pool?: pg.Pool) {
    this.pool = pool || new pg.Pool({ connectionString: config.DATABASE_URL });
  }

  /**
   * Sweeps stuck 'processing' jobs where started_at has exceeded STUCK_TIMEOUT_MS (T2-R14).
   * This recovers jobs orphaned by crashed workers (e.g. kill -9).
   */
  async sweepStuckJobs(): Promise<number> {
    const thresholdMs = config.STUCK_TIMEOUT_MS;

    const findSql = `
      SELECT * FROM jobs
      WHERE status = 'processing'
        AND started_at <= now() - ($1 || ' milliseconds')::interval
      FOR UPDATE SKIP LOCKED
      LIMIT 100;
    `;

    const client = await this.pool.connect();
    let sweptCount = 0;

    try {
      await client.query("BEGIN");

      const res = await client.query(findSql, [thresholdMs]);
      const stuckJobs: JobRecord[] = res.rows;

      for (const job of stuckJobs) {
        const newAttempts = job.attempts + 1;
        const isDead = newAttempts >= job.max_attempts;
        const nextStatus = isDead ? "dead" : "pending";

        const updateSql = `
          UPDATE jobs
          SET status = $1,
              attempts = $2,
              last_error = 'Stuck processing timeout exceeded (recovered by sweep engine)',
              run_at = now(),
              started_at = NULL,
              updated_at = now()
          WHERE id = $3 AND status = 'processing';
        `;

        await client.query(updateSql, [nextStatus, newAttempts, job.id]);
        sweptCount++;

        console.log(
          `[Sweep] 🧹 Recovered stuck job ${job.id}. Incremented attempts to ${newAttempts}/${job.max_attempts}. New status: '${nextStatus}'.`
        );
      }

      await client.query("COMMIT");
    } catch (err: any) {
      await client.query("ROLLBACK");
      console.error("[Sweep] Error during sweep transaction:", err.message);
    } finally {
      client.release();
    }

    return sweptCount;
  }

  async start(): Promise<void> {
    this.isRunning = true;
    console.log(
      `🧹 Sweep Engine started. Threshold: ${config.STUCK_TIMEOUT_MS}ms | Check Interval: ${config.STUCK_TIMEOUT_MS / 2}ms`
    );

    const checkIntervalMs = Math.max(2000, Math.floor(config.STUCK_TIMEOUT_MS / 2));

    while (this.isRunning) {
      try {
        const swept = await this.sweepStuckJobs();
        if (swept > 0) {
          console.log(`[Sweep] Swept ${swept} orphaned job(s).`);
        }
      } catch (err: any) {
        console.error("[Sweep] Error during sweep loop:", err.message);
      }

      await new Promise((resolve) => setTimeout(resolve, checkIntervalMs));
    }
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    await this.pool.end();
    console.log("[Sweep] Sweep engine stopped.");
  }
}
