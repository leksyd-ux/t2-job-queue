import { SweepEngine } from "./sweep.js";

async function main() {
  const sweep = new SweepEngine();

  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}. Gracefully stopping sweep engine...`);
    await sweep.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await sweep.start();
}

main().catch((err) => {
  console.error("Fatal sweep engine startup error:", err);
  process.exit(1);
});
