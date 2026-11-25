import { config } from "../config/index.js";

const BASE_URL = `http://localhost:${config.PORT}`;

interface StatsResponse {
  data?: {
    processing?: number;
    pending?: number;
    succeeded?: number;
  };
}

async function runConcurrencyTest() {
  console.log("==================================================");
  console.log("BREAK-IT 1: CONCURRENCY CAP ENFORCEMENT");
  console.log(`Expected Cap: ${config.WORKER_CONCURRENCY} concurrent jobs`);
  console.log("==================================================");

  // 1. Enqueue 50 jobs
  console.log("Enqueuing 50 background jobs...");
  const enqueuePromises = [];
  for (let i = 1; i <= 50; i++) {
    enqueuePromises.push(
      fetch(`${BASE_URL}/api/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "send_welcome_email",
          payload: { to: `user_${i}@example.com`, name: `User ${i}` },
          idempotency_key: `concurrency_test_${Date.now()}_${i}`,
        }),
      }).then((r) => r.json())
    );
  }

  await Promise.all(enqueuePromises);
  console.log("Enqueued 50 jobs successfully. Monitoring processing cap...");

  let maxObservedProcessing = 0;
  for (let poll = 0; poll < 20; poll++) {
    const res = await fetch(`${BASE_URL}/api/stats`);
    const data = (await res.json()) as StatsResponse;
    const processing = data.data?.processing || 0;
    maxObservedProcessing = Math.max(maxObservedProcessing, processing);

    console.log(
      `Poll #${poll + 1}: Processing=${processing}/${config.WORKER_CONCURRENCY} | Pending=${data.data?.pending} | Succeeded=${data.data?.succeeded}`
    );

    if (processing > config.WORKER_CONCURRENCY) {
      console.error(
        `❌ FAILED: Concurrency exceeded cap! Observed ${processing} > ${config.WORKER_CONCURRENCY}`
      );
      process.exit(1);
    }

    if (data.data?.pending === 0 && processing === 0) {
      console.log("All 50 jobs finished processing.");
      break;
    }

    await new Promise((r) => setTimeout(r, 400));
  }

  console.log("==================================================");
  console.log(`Max Observed Concurrent Jobs: ${maxObservedProcessing}`);
  console.log(`Worker Concurrency Cap:       ${config.WORKER_CONCURRENCY}`);
  if (maxObservedProcessing <= config.WORKER_CONCURRENCY) {
    console.log("✅ PASS: Concurrency cap held strictly at all times.");
  } else {
    console.error("❌ FAIL: Cap was violated.");
    process.exit(1);
  }
  console.log("==================================================");
}

runConcurrencyTest().catch((err) => {
  console.error("Error running concurrency test:", err.message);
  process.exit(1);
});
