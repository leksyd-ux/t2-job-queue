import fp from "fastify-plugin";
import { FastifyPluginAsync, FastifyError } from "fastify";
import pg from "pg";
import { ZodError } from "zod";
import rateLimit from "@fastify/rate-limit";
import { config } from "../../config/index.js";
import { AppError } from "../lib/errors.js";
import { errorEnvelope } from "../lib/envelope.js";

const { Pool } = pg;

declare module "fastify" {
  interface FastifyInstance {
    db: pg.Pool;
  }
}

export const dbPlugin: FastifyPluginAsync = fp(async (fastify) => {
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
  });

  fastify.decorate("db", pool);

  fastify.addHook("onClose", async () => {
    await pool.end();
  });
}, { name: "db" });

export const rateLimitPlugin: FastifyPluginAsync = fp(async (fastify) => {
  await fastify.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    errorResponseBuilder: (request, context) => {
      const retryAfterSec = Math.ceil(context.ttl / 1000);
      return errorEnvelope(
        "RATE_LIMITED",
        `Rate limit exceeded. Try again in ${retryAfterSec} seconds.`
      );
    },
  });
}, { name: "rate-limit" });

export const errorHandlerPlugin: FastifyPluginAsync = fp(async (fastify) => {
  fastify.setNotFoundHandler((request, reply) => {
    reply.status(404).send(errorEnvelope("NOT_FOUND", `Route ${request.method} ${request.url} not found`));
  });

  fastify.setErrorHandler((error: FastifyError | AppError | Error, request, reply) => {
    request.log.error(error);

    if (error instanceof AppError) {
      return reply.status(error.statusCode).send(
        errorEnvelope(error.code, error.message, error.details)
      );
    }

    if (error instanceof ZodError) {
      const details = error.issues.map((issue) => ({
        field: issue.path.join(".") || "body",
        issue: issue.message,
      }));
      return reply.status(422).send(
        errorEnvelope("VALIDATION_FAILED", "Request validation failed", details)
      );
    }

    if ("statusCode" in error && error.statusCode === 429) {
      return reply.status(429).send(errorEnvelope("RATE_LIMITED", error.message || "Rate limit exceeded"));
    }

    if ("statusCode" in error && error.statusCode === 400) {
      return reply.status(400).send(errorEnvelope("INVALID_QUERY", error.message || "Malformed request"));
    }

    return reply.status(500).send(
      errorEnvelope("INTERNAL", "An unexpected internal error occurred")
    );
  });
}, { name: "error-handler" });
