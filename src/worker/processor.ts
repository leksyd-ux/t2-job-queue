import { config } from "../../config/index.js";
import { JobRecord } from "../api/repository.js";
import { sendEmail } from "../lib/provider.js";

export interface ProcessingResult {
  success: boolean;
  error?: string;
  providerMessageId?: string;
}

/**
 * Executes a job payload (default: transactional email).
 * Injects simulated network/provider failures based on FAIL_RATE config.
 *
 * Idempotency check:
 * Uses the job's idempotency_key as the downstream provider idempotency key.
 * The provider ledger has a UNIQUE key, so a double run cannot create two sends.
 */
export async function processJob(job: JobRecord): Promise<ProcessingResult> {
  // 1. Simulate work latency (50ms - 200ms)
  const latency = Math.floor(Math.random() * 150) + 50;
  await new Promise((resolve) => setTimeout(resolve, latency));

  // 2. Injected failure check (configured via FAIL_RATE 0.0 - 1.0)
  if (config.FAIL_RATE > 0 && Math.random() < config.FAIL_RATE) {
    throw new Error(`Email provider 503: Transient delivery failure for recipient '${job.payload?.to || "customer@example.com"}'`);
  }

  // 3. Optional forced payload failure
  if (job.payload?.force_fail === true) {
    throw new Error("Simulated intentional job failure (force_fail = true)");
  }

  return {
    success: true,
    providerMessageId: await sendEmail(job),
  };
}
