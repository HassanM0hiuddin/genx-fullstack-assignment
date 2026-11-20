# Architecture & Debugging Decisions

## 1. Root-Cause Diagnosis

- **Event-loop / CPU behavior:** The fingerprint function does 120,000 rounds of SHA-256, which takes around 50ms. It was called directly inside the async request handler, so it blocked the event loop. While it ran, nothing else could be served, including `/health`. With a burst of 60 requests these blocks stack up, and a health check can end up waiting for seconds. Moving it to a thread would not fully fix this, because hashlib keeps the GIL for small inputs like a 32 byte digest, so the thread still competes with the event loop.

- **Concurrency & race conditions:** The `X-Idempotency-Key` header was checked but never used, and the table had no unique constraint. Two identical retries both inserted a row and both got sent downstream. The handler also waited for the downstream call (at least 250ms) before replying. That slow response is exactly what makes webhook senders retry. When the downstream returned 503, the handler failed with a 500, the event stayed `pending` forever, and the sender's retry created another row.

- **Resource & connection management:** A new SQLite connection was opened for every query (three per request), using the default journal mode and no busy timeout. Under load this can give "database is locked" errors. A new `httpx.AsyncClient` was also created per request, so no connections were reused and there was no limit on how many requests hit the downstream at once.

## 2. Concurrency & Offloading Strategy

I split the work into three parts:

1. **Acknowledging the request (event loop):** The handler validates the body, removes PII with the regexes (this is very fast, so it stays inline), and inserts the row. If the row is new it returns `202`. If the key was already seen it returns `200` with `"duplicate"`. The reply is only sent after the insert is committed, so anything we acknowledge is already saved.

2. **CPU work (`ProcessPoolExecutor`):** The fingerprint runs in a process pool through `run_in_executor`. A separate process is the only option that really gets the hashing off the main interpreter. The pool is started and warmed up during app startup so the first requests don't pay for starting processes. Each worker also watches the parent process and exits if the server gets killed, so no orphan processes are left behind.

3. **Downstream delivery (`asyncio.Queue` and worker tasks):** New events go into a queue. A fixed number of worker tasks (32 by default) take events from it, compute the fingerprint, and send the event. This puts a cap on how many requests we send downstream at once. They share one `httpx.AsyncClient` so connections are reused. Network errors and 408/425/429/5xx responses are retried with exponential backoff and jitter. Other 4xx errors are not retried, and the event is marked `failed`.

Why not the other options:
- `asyncio.to_thread`: does not help here, because the hash loop holds the GIL.
- FastAPI `BackgroundTasks`: runs in the same process (either the thread pool, with the same GIL problem, or the event loop, which blocks it). It also has no retries, no limit on concurrency, and nothing to resume from after a restart.
- `create_task` per request: no limit on concurrency during a burst.
- Celery/Redis: not allowed by the constraints. SQLite is the real record, and the in-memory queue can be rebuilt from it.

## 3. Idempotency & SQLite Concurrency

The database does the deduplication, not Python code. `idempotency_key` has a UNIQUE index, and the insert is:

```sql
INSERT INTO events (...) VALUES (...) ON CONFLICT (idempotency_key) DO NOTHING
```

Then I check `rowcount`. SQLite only allows one writer at a time, so if two identical requests arrive in the same millisecond, one insert gets `rowcount = 1` and the other gets `0`. Only the first one is added to the delivery queue. There is no gap between "check" and "insert", because the insert is the check.

Inside one process all queries also go through a single shared aiosqlite connection, which runs them one after another. That helps, but correctness doesn't depend on it. The UNIQUE constraint works across processes too.

SQLite settings:
- `journal_mode=WAL`: reads don't block writes, and commits are cheap.
- `synchronous=NORMAL`: safe against process crashes in WAL mode, and much faster than FULL.
- `busy_timeout=5000`: another connection waits for the lock instead of failing.

PII is removed before the row is written, so raw content never reaches the disk. I also send an `Idempotency-Key` header to the downstream, so it can drop our own retries if it supports that.

## 4. Failure Modes & Production Trade-offs

- **Downstream down for 60 seconds:** Ingestion keeps working, since replies don't depend on the downstream. Events are saved as `pending`. The workers keep retrying with growing delays (0.2s, 0.4s, 0.8s and so on, capped at 30s). 12 attempts cover more than two minutes, so a 60 second outage recovers on its own. The downside is that while workers are sleeping between retries, new events wait in the queue. In production I would add a circuit breaker, a periodic job to retry `failed` rows, and an alert on queue size.

- **Crash 50ms after acknowledging:** The row is committed before we reply, so the event is not lost. The in-memory queue is gone, but on startup the service loads all `pending` rows and queues them again. If the crash happened after the downstream accepted the event but before we marked it `delivered`, it will be sent again. So delivery is at-least-once, and the downstream should deduplicate using the `Idempotency-Key` header.

- **Running with `--workers 4`:** Deduplication on ingest still works because the UNIQUE constraint is enforced by SQLite across processes. What breaks first:
  1. On restart, all 4 workers load the same `pending` rows and each delivers them, so you could get up to 4 copies. The fix is to claim rows atomically (for example `UPDATE ... SET status='delivering' WHERE status='pending' AND key=?` and only continue if `rowcount = 1`, plus a lease timeout).
  2. Each worker creates its own process pool sized to the CPU count, so there are 4 times too many hashing processes fighting over the cores. `CPU_WORKERS` should be divided by the number of workers.
  3. All writes go through one SQLite file lock. At higher traffic the four processes will wait on each other, and eventually you get "database is locked" errors. That is the point where you need Postgres and a real queue.

## Note on running the tests on Windows

On my Windows machine, the two timing checks (`/health` < 50ms and ingest p95 < 250ms) sit right on the limit. To check where the time goes, I ran the same test against a stub server that does no work at all (returns 202 immediately). It got the same numbers (about 250ms p95 and 170ms for `/health`). So the extra time comes from the test's httpx client opening 60 connections at once on Windows, not from the service. Measured directly, the request handler takes about 10ms, and `/health` answers in about 20ms when called with raw sockets. With the timing limits relaxed, all the correctness checks pass every time (30 rows, no duplicate rows or deliveries, 503s retried, no PII stored). On Linux or macOS the timing checks should have plenty of room.
