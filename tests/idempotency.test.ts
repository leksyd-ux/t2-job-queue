import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { errorHandlerPlugin } from "../src/api/plugins.js";
import { apiRoutes } from "../src/api/routes.js";

describe("T2-R04 & T2-R05: Job Enqueue & Idempotency", () => {
  let app: FastifyInstance;
  const inMemoryJobs: Map<string, any> = new Map();

  beforeAll(async () => {
    app = Fastify();
    await app.register(errorHandlerPlugin);

    // Mock DB
    const mockDb = {
      query: async (sql: string, params: any[] = []) => {
        if (sql.includes("INSERT INTO jobs")) {
          const [id, type, payload, maxAttempts, key] = params;
          if (inMemoryJobs.has(key)) {
            // Simulate ON CONFLICT DO NOTHING
            return { rows: [] };
          }
          const job = {
            id,
            type,
            payload: JSON.parse(payload),
            max_attempts: maxAttempts,
            idempotency_key: key,
            status: "pending",
            attempts: 0,
            run_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          };
          inMemoryJobs.set(key, job);
          return { rows: [job] };
        }
        if (sql.includes("SELECT * FROM jobs WHERE idempotency_key = $1")) {
          const key = params[0];
          const job = inMemoryJobs.get(key);
          return { rows: job ? [job] : [] };
        }
        if (sql.includes("SELECT * FROM jobs WHERE id = $1")) {
          const id = params[0];
          for (const job of inMemoryJobs.values()) {
            if (job.id === id) return { rows: [job] };
          }
          return { rows: [] };
        }
        return { rows: [] };
      },
    };

    app.decorate("db", mockDb as unknown as Pool);
    await app.register(apiRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 202 Accepted and job ID on valid enqueue", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: {
        type: "welcome_email",
        payload: { email: "user@test.com" },
        idempotency_key: "idem_key_001",
      },
    });

    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.data).toBeDefined();
    expect(body.data.idempotency_key).toBe("idem_key_001");
    expect(body.data.status).toBe("pending");
    expect(body.meta.duplicate).toBe(false);
  });

  it("returns existing job when exact same idempotency_key is resent", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: {
        type: "welcome_email",
        payload: { email: "user@test.com" },
        idempotency_key: "idem_key_001", // duplicate key
      },
    });

    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.data).toBeDefined();
    expect(body.data.idempotency_key).toBe("idem_key_001");
    expect(body.meta.duplicate).toBe(true);
  });

  it("rejects enqueue missing required fields with 422 VALIDATION_FAILED", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: {
        // missing type and idempotency_key
        payload: {},
      },
    });

    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });
});
