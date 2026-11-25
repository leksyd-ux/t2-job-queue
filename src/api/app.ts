import Fastify, { FastifyInstance, FastifyServerOptions } from "fastify";
import cors from "@fastify/cors";
import { config } from "../../config/index.js";
import { dbPlugin, rateLimitPlugin, errorHandlerPlugin } from "./plugins.js";
import { apiRoutes } from "./routes.js";

export async function buildApp(opts: FastifyServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === "test" ? "silent" : "info",
    },
    trustProxy: config.TRUST_PROXY,
    ...opts,
  });

  await app.register(errorHandlerPlugin);
  await app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });
  await app.register(dbPlugin);
  await app.register(rateLimitPlugin);
  await app.register(apiRoutes);

  return app;
}
