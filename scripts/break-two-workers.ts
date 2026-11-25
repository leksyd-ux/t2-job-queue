import pg from "pg";
import { config } from "../config/index.js";
import { WorkerEngine } from "../src/worker/worker.js";
import { generateUUIDv7 } from "../src/lib/uuidv7.js";

const { Pool } = pg;

async function runTwoWorkersTest() {
  console.log("==================================================");
  console.log("BREAK-IT 4: TWO CONCURRENT WORKERS (SKIP LOCKED CHECK)");
  console.log("Proving: No double-claims when two workers compete");
  console.log("==================================================");

  const pool = new Pool({ connectionString: config.DATABASE_URL });

  // 1. Enqueue 20 jobs directly into database
  console.log("Seeding 20 pending jobs for competitive claiming...");
  const seededIds: string[] = [];
  for (let i = 1; i <= 20; i++) {
    const id = generateUUIDv7();
    seededIds.push(id);
    await pool.query(
      `INSERT INTO jobs (id, type, payload, status, idempotency_key, created_at, updated_at)
       VALUES ($1, 'competitive_job', '{}', 'pending', $2, now(), now())`,
      [id, `comp_${Date.now()}_${i}`]
    );
  }

  // 2. Instantiate two separate worker engines sharing the pool
  const worker1 = new WorkerEngine(pool);
  const worker2 = new WorkerEngine(pool);

  console.log("Simulating simultaneous claims from Worker 1 and Worker 2...");

  // Concurrent competitive claim calls
  const [claimedByWorker1, claimedByWorker2] = await Promise.all([
    worker1.claimJobs(10),
    worker2.claimJobs(10),
  ]);

  const ids1 = new Set(claimedByWorker1.map((j) => j.id));
  const ids2 = new Set(claimedByWorker2.map((j) => j.id));

  console.log(`Worker 1 claimed: ${ids1.size} job(s)`);
  console.log(`Worker 2 claimed: ${ids2.size} job(s)`);

  // Check for intersection
  const duplicates = [...ids1].filter((id) => ids2.has(id));

  console.log("==================================================");
  if (duplicates.length === 0) {
    console.log("✅ PASS: Zero duplicate claims detected.");
    console.log(`Total uniquely claimed: ${ids1.size + ids2.size} / 20`);
    console.log("PostgreSQL FOR UPDATE SKIP LOCKED successfully isolated each worker transaction.");
  } else {
    console.error(`❌ FAIL: Found ${duplicates.length} duplicate claims:`, duplicates);
    process.exit(1);
  }
  console.log("==================================================");

  await pool.end();
}

runTwoWorkersTest().catch((err) => {
  console.error("Error running two-workers test:", err.message);
  process.exit(1);
});
