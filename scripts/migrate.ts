import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import { config } from "../config/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { Pool } = pg;

async function runMigrations() {
  console.log("Connecting to PostgreSQL to run migrations...");
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
  });

  try {
    const client = await pool.connect();
    console.log("Connected successfully. Reading migration files...");

    const migrationsDir = path.resolve(__dirname, "../migrations");
    const migrationFiles = fs.readdirSync(migrationsDir).filter(f => f.endsWith(".sql")).sort();

    for (const file of migrationFiles) {
      console.log(`Executing migration: ${file}...`);
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, "utf-8");
      await client.query(sql);
      console.log(`Executed: ${file}`);
    }

    client.release();
    console.log("All migrations executed successfully.");
  } catch (err) {
    console.error("Migration error:", err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigrations();
