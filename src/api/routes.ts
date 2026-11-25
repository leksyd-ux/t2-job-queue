import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { JobRepository, JobStatus } from "./repository.js";
import { isValidUUID } from "../lib/uuidv7.js";
import { AppError } from "../lib/errors.js";
import { successEnvelope } from "../lib/envelope.js";
import { config } from "../../config/index.js";

const EnqueueJobSchema = z.object({
  type: z.string().min(1, "type is required"),
  payload: z.record(z.any()).default({}),
  idempotency_key: z.string().min(1, "idempotency_key is required"),
  max_attempts: z.number().int().positive().optional().default(config.MAX_ATTEMPTS),
});

const QueryJobsSchema = z.object({
  status: z.enum(["pending", "processing", "succeeded", "failed", "dead"] as const).optional(),
  limit: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const apiRoutes: FastifyPluginAsync = async (fastify) => {
  const repo = new JobRepository(fastify.db);

  // Health endpoint
  fastify.get("/health", async (request, reply) => {
    try {
      const res = await fastify.db.query("SELECT 1 AS alive");
      if (res.rows[0]?.alive !== 1) {
        return reply.status(503).send({ status: "unhealthy", database: "disconnected" });
      }
      return reply.status(200).send(
        successEnvelope({
          status: "healthy",
          uptime: process.uptime(),
          timestamp: new Date().toISOString(),
        })
      );
    } catch (err: any) {
      return reply.status(503).send({ status: "unhealthy", error: err.message });
    }
  });

  // POST /api/jobs - Enqueue a job (T2-R04, T2-R05)
  // Always returns 202 Accepted. Idempotent on idempotency_key.
  fastify.post("/api/jobs", async (request, reply) => {
    const parse = EnqueueJobSchema.safeParse(request.body);
    if (!parse.success) {
      const details = parse.error.issues.map((i) => ({
        field: i.path.join("."),
        issue: i.message,
      }));
      throw AppError.validationFailed("Invalid job enqueue payload", details);
    }

    const { type, payload, idempotency_key, max_attempts } = parse.data;
    const { job, isDuplicate } = await repo.enqueue(type, payload, idempotency_key, max_attempts);

    return reply.status(202).send({
      data: job,
      meta: {
        duplicate: isDuplicate,
      },
    });
  });

  // GET /api/jobs - List jobs with optional status filter (T2-R16)
  fastify.get("/api/jobs", async (request, reply) => {
    const parse = QueryJobsSchema.safeParse(request.query);
    if (!parse.success) {
      throw AppError.invalidQuery("Invalid query parameters");
    }

    const limit = Math.min(parse.data.limit || config.DEFAULT_PAGE_SIZE, config.MAX_PAGE_SIZE);
    const offset = parse.data.offset || 0;

    const { items, total } = await repo.list(parse.data.status as JobStatus, limit, offset);
    const hasMore = offset + limit < total;

    return reply.status(200).send(
      successEnvelope(items, {
        total,
        limit,
        offset,
        hasMore,
      })
    );
  });

  // GET /api/jobs/:id - Get job status and attempts (T2-R16)
  fastify.get("/api/jobs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidUUID(id)) {
      throw AppError.invalidId(`Malformed identifier: '${id}' is not a valid UUID`);
    }

    const job = await repo.findById(id);
    if (!job) {
      throw AppError.notFound(`Job with id '${id}' not found`);
    }

    return reply.status(200).send(successEnvelope(job));
  });

  // GET /api/stats - Job Queue statistics for console
  fastify.get("/api/stats", async (request, reply) => {
    const stats = await repo.getStats();
    return reply.status(200).send(successEnvelope(stats));
  });

  // GET /api/dead-letters - List dead letter jobs (T2-R15)
  fastify.get("/api/dead-letters", async (request, reply) => {
    const parse = QueryJobsSchema.safeParse(request.query);
    const limit = Math.min(parse.data?.limit || config.DEFAULT_PAGE_SIZE, config.MAX_PAGE_SIZE);
    const offset = parse.data?.offset || 0;

    const { items, total } = await repo.list("dead", limit, offset);
    const hasMore = offset + limit < total;

    return reply.status(200).send(
      successEnvelope(items, {
        total,
        limit,
        offset,
        hasMore,
      })
    );
  });

  // POST /api/dead-letters/:id/retry - Manually retry a dead job (T2-R15)
  fastify.post("/api/dead-letters/:id/retry", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidUUID(id)) {
      throw AppError.invalidId(`Malformed identifier: '${id}' is not a valid UUID`);
    }

    const job = await repo.retryDeadJob(id);
    if (!job) {
      throw AppError.notFound(`Dead job with id '${id}' not found or is not in 'dead' state`);
    }

    return reply.status(200).send(successEnvelope(job));
  });
};
