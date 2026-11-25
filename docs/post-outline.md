# Post Outline — Why You Probably Don't Need Redis for Your Job Queue

## Hook
Every tutorial immediately tells you to install Redis and BullMQ the moment you need background tasks. But in production, running a separate broker introduces the dual-write problem: what happens when your database transaction commits, but the Redis queue publish fails?

## Core Lesson
How PostgreSQL's `FOR UPDATE SKIP LOCKED` lets you build a rock-solid, transactional background job queue in under 100 lines:
1. **Transactional Enqueueing**: Enqueue jobs inside the exact same DB transaction as your business records (e.g. `INSERT INTO orders` + `INSERT INTO jobs`). It either all commits or all rolls back.
2. **Lock-Free Worker Claims**: How `FOR UPDATE SKIP LOCKED` eliminates row contention and race conditions without blocking concurrent workers.
3. **The Jitter Factor**: Why pure exponential backoff causes a "Thundering Herd" retry storm on recovering downstream APIs, and how additive uniform jitter fixes it.
4. **Surviving the `kill -9`**: How a sweep engine automatically resurrects stuck jobs left behind by crashed worker processes.

## The Concrete Artifact
- Screenshot showing the `kill -9` worker recovery trace in the console.
- Code snippet of the atomic SQL claim query.

## Call to Action / Repository
- Link to GitHub repo: `https://github.com/<username>/t2-job-queue`
- Discussion prompt: When do you actually outgrow database-backed queues?
