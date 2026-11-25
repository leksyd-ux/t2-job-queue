import pg from "pg";
import { config } from "../../config/index.js";
import { JobRecord } from "../api/repository.js";

let ledgerPool: pg.Pool | undefined;

function getLedgerPool(): pg.Pool {
  if (!ledgerPool) {
    ledgerPool = new pg.Pool({ connectionString: config.DATABASE_URL });
  }
  return ledgerPool;
}

export async function closeLedgerPool(): Promise<void> {
  if (ledgerPool) {
    await ledgerPool.end();
    ledgerPool = undefined;
  }
}

/**
 * Stands in for a transactional email provider's idempotency-key header.
 * The UNIQUE key on provider_sends guarantees that two executions of the
 * same job produce one downstream message, not two.
 */
export async function sendEmail(job: Pick<JobRecord, "idempotency_key" | "payload">): Promise<string> {
  const payload = (job.payload ?? {}) as Record<string, unknown>;
  const recipient = typeof payload.to === "string" ? payload.to : "customer@example.com";
  const providerMessageId = `msg_${job.idempotency_key}`;

  const inserted = await getLedgerPool().query(
    `INSERT INTO provider_sends (idempotency_key, provider_message_id, recipient)
     VALUES ($1, $2, $3)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING provider_message_id`,
    [job.idempotency_key, providerMessageId, recipient]
  );

  if (inserted.rows[0]?.provider_message_id) {
    return inserted.rows[0].provider_message_id as string;
  }

  const existing = await getLedgerPool().query(
    `SELECT provider_message_id FROM provider_sends WHERE idempotency_key = $1`,
    [job.idempotency_key]
  );
  return existing.rows[0].provider_message_id as string;
}
