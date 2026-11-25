import { describe, it, expect } from "vitest";
import { SweepEngine } from "../src/sweep/sweep.js";

describe("T2-R14: Sweep Engine Stuck Job Recovery", () => {
  it("detects and resets stuck processing jobs that exceed timeout", async () => {
    const stuckJobs = [
      {
        id: "stuck-1",
        status: "processing",
        attempts: 1,
        max_attempts: 3,
        started_at: new Date(Date.now() - 120000), // started 2 min ago (threshold 60s)
      },
    ];

    let executedUpdateSql = "";
    let updateParams: any[] = [];

    const mockClient = {
      query: async (sql: string, params: any[] = []) => {
        if (sql.includes("BEGIN") || sql.includes("COMMIT")) return;
        if (sql.includes("SELECT * FROM jobs")) {
          return { rows: stuckJobs };
        }
        if (sql.includes("UPDATE jobs")) {
          executedUpdateSql = sql;
          updateParams = params;
          return { rowCount: 1 };
        }
        return { rows: [] };
      },
      release: () => {},
    };

    const mockPool: any = {
      connect: async () => mockClient,
      end: async () => {},
    };

    const sweep = new SweepEngine(mockPool);
    const count = await sweep.sweepStuckJobs();

    expect(count).toBe(1);
    expect(executedUpdateSql).toContain("status = $1");
    expect(executedUpdateSql).toContain("attempts = $2");
    expect(updateParams[0]).toBe("pending"); // new status
    expect(updateParams[1]).toBe(2);         // attempts incremented to 2
    expect(updateParams[2]).toBe("stuck-1"); // job id
  });

  it("transitions stuck jobs with exhausted attempts directly to dead", async () => {
    const exhaustedJob = [
      {
        id: "exhausted-1",
        status: "processing",
        attempts: 2,
        max_attempts: 3,
        started_at: new Date(Date.now() - 120000),
      },
    ];

    let newStatus = "";

    const mockClient = {
      query: async (sql: string, params: any[] = []) => {
        if (sql.includes("BEGIN") || sql.includes("COMMIT")) return;
        if (sql.includes("SELECT * FROM jobs")) return { rows: exhaustedJob };
        if (sql.includes("UPDATE jobs")) {
          newStatus = params[0];
          return { rowCount: 1 };
        }
        return { rows: [] };
      },
      release: () => {},
    };

    const mockPool: any = {
      connect: async () => mockClient,
      end: async () => {},
    };

    const sweep = new SweepEngine(mockPool);
    await sweep.sweepStuckJobs();

    expect(newStatus).toBe("dead");
  });
});
