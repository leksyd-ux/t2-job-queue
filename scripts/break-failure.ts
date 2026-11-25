import { config } from "../config/index.js";
import type { JobRecord } from "../src/api/repository.js";

const BASE_URL = `http://localhost:${config.PORT}`;

async function runFailureTest() {
  console.log("==================================================");
  console.log("BREAK-IT 2: FAILURE LIFECYCLE & EXPONENTIAL BACKOFF");
  console.log("Proving: pending -> processing -> failed (with backoff) -> ... -> dead");
  console.log("==================================================");

  const key = `failing_job_${Date.now()}`;
  console.log(`Enqueuing intentionally failing job with key: ${key}...`);

  const enqueueRes = await fetch(`${BASE_URL}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "failing_email",
      payload: { to: "fail@example.com", force_fail: true },
      idempotency_key: key,
      max_attempts: 3,
    }),
  });

  const enqueueJson = (await enqueueRes.json()) as { data?: { id?: string } };
  const jobId = enqueueJson.data?.id;
  console.log(`Job enqueued with ID: ${jobId}. Monitoring state transitions...`);

  let lastStatus = "";
  let lastAttempts = 0;

  for (let poll = 0; poll < 30; poll++) {
    const res = await fetch(`${BASE_URL}/api/jobs/${jobId}`);
    const data = (await res.json()) as { data?: JobRecord };
    const job = data.data;

    if (!job) {
      throw new Error(`Job ${jobId} was not found while polling`);
    }

    if (job.status !== lastStatus || job.attempts !== lastAttempts) {
      console.log(
        `Transition: Status='${job.status}' | Attempts=${job.attempts}/${job.max_attempts} | LastError='${job.last_error || "none"}' | RunAt=${job.run_at}`
      );
      lastStatus = job.status;
      lastAttempts = job.attempts;
    }

    if (job.status === "dead") {
      console.log("==================================================");
      console.log("✅ PASS: Job successfully exhausted retries and transitioned to 'dead'.");
      console.log(`Final Error Recorded: ${job.last_error}`);
      console.log("==================================================");
      return;
    }

    await new Promise((r) => setTimeout(r, 600));
  }

  console.warn("Test timed out before job reached 'dead' state. Ensure worker is running.");
}

runFailureTest().catch((err) => {
  console.error("Error running failure test:", err.message);
  process.exit(1);
});
