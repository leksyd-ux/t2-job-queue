import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const configSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  TRUST_PROXY: z
    .string()
    .transform((val) => val === "true" || val === "1")
    .default("false"),
  DATABASE_URL: z.string().min(1).default("postgresql://postgres:postgres@localhost:5432/job_queue"),
  DEFAULT_PAGE_SIZE: z.coerce.number().int().positive().default(20),
  MAX_PAGE_SIZE: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),

  // Task 2 Worker Tunables (No magic numbers in handlers)
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  BACKOFF_BASE_MS: z.coerce.number().int().positive().default(1000),
  BACKOFF_CAP_MS: z.coerce.number().int().positive().default(30000),
  JITTER_MS: z.coerce.number().int().min(0).default(500),
  STUCK_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  FAIL_RATE: z.coerce.number().min(0).max(1).default(0.0),
  EMAIL_PROVIDER_API_KEY: z.string().default("mock-key"),
});

const parsed = configSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment configuration:", parsed.error.format());
  throw new Error("Invalid environment configuration. Check your .env file.");
}

export const config = parsed.data;
export type Config = z.infer<typeof configSchema>;
