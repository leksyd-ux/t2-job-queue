import { describe, it, expect } from "vitest";
import { WorkerEngine } from "../src/worker/worker.js";

describe("T2-R07 & T2-R08: Atomic Claim Logic & Status Filters", () => {
  it("claims only pending or failed jobs with run_at <= now, never dead or processing", async () => {
    const mockJobsInDb = [
      { id: "1", status: "pending", run_at: new Date(Date.now() - 5000) },
      { id: "2", status: "failed", run_at: new Date(Date.now() - 2000) }, // ready for retry
      { id: "3", status: "failed", run_at: new Date(Date.now() + 60000) }, // future run_at (in backoff delay)
      { id: "4", status: "processing", run_at: new Date(Date.now() - 5000) },
      { id: "5", status: "dead", run_at: new Date(Date.now() - 5000) },
      { id: "6", status: "succeeded", run_at: new Date(Date.now() - 5000) },
    ];

    const mockPool: any = {
      query: async (sql: string, params: any[]) => {
        expect(sql).toContain("FOR UPDATE SKIP LOCKED");
        expect(sql).toContain("status IN ('pending', 'failed')");
        expect(sql).toContain("run_at <= now()");

        const limit = params[0];
        // Simulate query filtering logic
        const eligible = mockJobsInDb.filter(
          (j) => (j.status === "pending" || j.status === "failed") && j.run_at.getTime() <= Date.now()
        );
        return { rows: eligible.slice(0, limit) };
      },
      end: async () => {},
    };

    const worker = new WorkerEngine(mockPool);
    const claimed = await worker.claimJobs(5);

    expect(claimed.length).toBe(2);
    expect(claimed.map((j) => j.id)).toEqual(["1", "2"]);
  });

  it("returns empty array when no slots are available", async () => {
    const mockPool: any = {
      query: async () => ({ rows: [] }),
      end: async () => {},
    };

    const worker = new WorkerEngine(mockPool);
    const claimed = await worker.claimJobs(0);
    expect(claimed).toEqual([]);
  });
});
