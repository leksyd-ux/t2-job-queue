import { WorkerEngine } from "./worker.js";

async function main() {
  const worker = new WorkerEngine();

  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}. Gracefully stopping worker...`);
    await worker.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await worker.start();
}

main().catch((err) => {
  console.error("Fatal worker startup error:", err);
  process.exit(1);
});
