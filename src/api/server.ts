import { buildApp } from "./app.js";
import { config } from "../../config/index.js";

async function start() {
  const app = await buildApp();

  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  for (const signal of signals) {
    process.on(signal, async () => {
      app.log.info(`Received ${signal}. Shutting down API gracefully...`);
      await app.close();
      process.exit(0);
    });
  }

  try {
    await app.listen({
      port: config.PORT,
      host: "0.0.0.0",
    });
    console.log(`🚀 Job Queue API listening on http://0.0.0.0:${config.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
