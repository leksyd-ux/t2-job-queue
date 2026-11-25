import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { config } from "../config/index.js";
import { closeLedgerPool, sendEmail } from "../src/lib/provider.js";

describe("T2-R13: downstream idempotency", () => {
  afterAll(async () => {
    await closeLedgerPool();
  });

  it("two executions with the same job key create exactly one provider send", async () => {
    const key = `r13_${randomUUID()}`;
    const job = { idempotency_key: key, payload: { to: "r13@example.com" } };

    const first = await sendEmail(job);
    const second = await sendEmail(job);
    expect(second).toBe(first);

    const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
    try {
      const rows = await pool.query(
        "SELECT provider_message_id, recipient FROM provider_sends WHERE idempotency_key = $1",
        [key]
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].provider_message_id).toBe(first);
      expect(rows.rows[0].recipient).toBe("r13@example.com");
    } finally {
      await pool.end();
    }
  });
});
