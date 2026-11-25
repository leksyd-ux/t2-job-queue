import { config } from "../config/index.js";

const BASE_URL = `http://localhost:${config.PORT}`;

interface JobResponse {
  data?: { id?: string };
  meta?: { duplicate?: boolean };
}

async function runDuplicateTest() {
  console.log("==================================================");
  console.log("BREAK-IT 3: IDEMPOTENT ENQUEUE & DUPLICATE DEDUPLICATION");
  console.log("==================================================");

  const sharedKey = `shared_idempotency_key_${Date.now()}`;

  console.log(`Sending first POST /api/jobs with key: ${sharedKey}...`);
  const res1 = await fetch(`${BASE_URL}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "order_receipt",
      payload: { order_id: 101, amount: 49.99 },
      idempotency_key: sharedKey,
    }),
  });
  const data1 = (await res1.json()) as JobResponse;
  const id1 = data1.data?.id;
  const isDup1 = data1.meta?.duplicate;
  console.log(`First Request Result: Status=${res1.status}, ID=${id1}, isDuplicate=${isDup1}`);

  console.log(`Sending second POST /api/jobs with identical key: ${sharedKey}...`);
  const res2 = await fetch(`${BASE_URL}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "order_receipt",
      payload: { order_id: 101, amount: 49.99 },
      idempotency_key: sharedKey,
    }),
  });
  const data2 = (await res2.json()) as JobResponse;
  const id2 = data2.data?.id;
  const isDup2 = data2.meta?.duplicate;
  console.log(`Second Request Result: Status=${res2.status}, ID=${id2}, isDuplicate=${isDup2}`);

  console.log("==================================================");
  if (id1 === id2 && isDup2 === true) {
    console.log("✅ PASS: Exactly one job was created. Second request safely returned the existing job.");
    console.log(`Job ID: ${id1}`);
  } else {
    console.error("❌ FAIL: Duplicate idempotency was not handled properly.");
    process.exit(1);
  }
  console.log("==================================================");
}

runDuplicateTest().catch((err) => {
  console.error("Error running duplicate test:", err.message);
  process.exit(1);
});
