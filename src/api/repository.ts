import pg from "pg";
import { generateUUIDv7 } from "../lib/uuidv7.js";
import { config } from "../../config/index.js";

export type JobStatus = "pending" | "processing" | "succeeded" | "failed" | "dead";

export interface JobRecord {
  id: string;
  type: string;
  payload: any;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  run_at: string;
  started_at: string | null;
  finished_at: string | null;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
}

export interface JobStats {
  pending: number;
  processing: number;
  succeeded: number;
  failed: number;
  dead: number;
  total: number;
  workerConcurrency: number;
}

export class JobRepository {
  constructor(private pool: pg.Pool) {}

  async enqueue(
    type: string,
    payload: any,
    idempotencyKey: string,
    maxAttempts = config.MAX_ATTEMPTS
  ): Promise<{ job: JobRecord; isDuplicate: boolean }> {
    const id = generateUUIDv7();

    const insertSql = `
      INSERT INTO jobs (id, type, payload, max_attempts, idempotency_key, status, run_at, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, 'pending', now(), now(), now())
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING *;
    `;

    const res = await this.pool.query(insertSql, [
      id,
      type,
      JSON.stringify(payload ?? {}),
      maxAttempts,
      idempotencyKey,
    ]);

    if (res.rows.length > 0) {
      return { job: res.rows[0], isDuplicate: false };
    }

    // Duplicate key detected -> Return existing job (T2-R05)
    const selectSql = `SELECT * FROM jobs WHERE idempotency_key = $1`;
    const existing = await this.pool.query(selectSql, [idempotencyKey]);
    return { job: existing.rows[0], isDuplicate: true };
  }

  async findById(id: string): Promise<JobRecord | null> {
    const res = await this.pool.query(`SELECT * FROM jobs WHERE id = $1`, [id]);
    return res.rows[0] || null;
  }

  async list(
    status?: JobStatus,
    limit = config.DEFAULT_PAGE_SIZE,
    offset = 0
  ): Promise<{ items: JobRecord[]; total: number }> {
    const safeLimit = Math.min(Math.max(1, limit), config.MAX_PAGE_SIZE);
    const safeOffset = Math.max(0, offset);

    const conditions: string[] = [];
    const values: any[] = [];
    let paramIdx = 1;

    if (status) {
      conditions.push(`status = $${paramIdx++}`);
      values.push(status);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countRes = await this.pool.query(
      `SELECT COUNT(*)::int AS total FROM jobs ${whereClause}`,
      values
    );
    const total = countRes.rows[0]?.total || 0;

    const dataSql = `
      SELECT * FROM jobs
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;
    values.push(safeLimit, safeOffset);

    const dataRes = await this.pool.query(dataSql, values);
    return { items: dataRes.rows, total };
  }

  async getStats(): Promise<JobStats> {
    const res = await this.pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE status = 'processing')::int AS processing,
        COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
        COUNT(*) FILTER (WHERE status = 'dead')::int AS dead,
        COUNT(*)::int AS total
      FROM jobs
    `);

    const row = res.rows[0];
    return {
      pending: row.pending || 0,
      processing: row.processing || 0,
      succeeded: row.succeeded || 0,
      failed: row.failed || 0,
      dead: row.dead || 0,
      total: row.total || 0,
      workerConcurrency: config.WORKER_CONCURRENCY,
    };
  }

  async retryDeadJob(id: string): Promise<JobRecord | null> {
    const res = await this.pool.query(
      `
      UPDATE jobs
      SET status = 'pending',
          attempts = 0,
          last_error = NULL,
          run_at = now(),
          started_at = NULL,
          finished_at = NULL,
          updated_at = now()
      WHERE id = $1 AND status = 'dead'
      RETURNING *;
      `,
      [id]
    );

    return res.rows[0] || null;
  }
}
