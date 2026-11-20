"""Background processing pipeline: fingerprint (CPU, process pool) -> deliver (I/O, retries).

The HTTP handler only claims the idempotency key and enqueues it. A fixed pool of
asyncio worker tasks drains the queue, so the amount of concurrent downstream
traffic is bounded no matter how large the incoming burst is.
"""

from __future__ import annotations

import asyncio
import logging
import os
import random
from concurrent.futures import ProcessPoolExecutor

from app.database import STATUS_DELIVERED, STATUS_FAILED, Database
from app.downstream import DownstreamClient, RetryableDownstreamError
from app.processor import fingerprint, init_worker, warm_up

log = logging.getLogger("webhooks.pipeline")


def _env_int(name: str, default: int) -> int:
    return int(os.getenv(name, default))


def _env_float(name: str, default: float) -> float:
    return float(os.getenv(name, default))


class DeliveryPipeline:
    def __init__(self, db: Database, downstream: DownstreamClient) -> None:
        self.db = db
        self.downstream = downstream
        self.queue: asyncio.Queue[str] = asyncio.Queue()

        self.delivery_workers = _env_int("DELIVERY_WORKERS", 32)
        self.cpu_workers = _env_int("CPU_WORKERS", max(1, min(8, (os.cpu_count() or 2) - 1)))
        self.max_attempts = _env_int("DELIVERY_MAX_ATTEMPTS", 12)
        self.backoff_base = _env_float("DELIVERY_BACKOFF_BASE", 0.2)
        self.backoff_cap = _env_float("DELIVERY_BACKOFF_CAP", 30.0)

        self._pool: ProcessPoolExecutor | None = None
        self._tasks: list[asyncio.Task] = []

    async def start(self) -> None:
        self._pool = ProcessPoolExecutor(
            max_workers=self.cpu_workers, initializer=init_worker, initargs=(os.getpid(),)
        )
        loop = asyncio.get_running_loop()
        # Spawn every worker process now rather than on the first request.
        await asyncio.gather(*(loop.run_in_executor(self._pool, warm_up) for _ in range(self.cpu_workers)))

        self._tasks = [
            asyncio.create_task(self._worker(i), name=f"delivery-worker-{i}")
            for i in range(self.delivery_workers)
        ]

        # Crash recovery: anything accepted but not delivered by a previous run.
        for key in await self.db.pending_keys():
            self.queue.put_nowait(key)

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()
        if self._pool is not None:
            self._pool.shutdown(wait=False, cancel_futures=True)
            self._pool = None

    def enqueue(self, idempotency_key: str) -> None:
        self.queue.put_nowait(idempotency_key)

    def _backoff(self, attempt: int) -> float:
        # Exponential backoff with full jitter so retries from a burst don't re-synchronise.
        ceiling = min(self.backoff_cap, self.backoff_base * (2 ** (attempt - 1)))
        return random.uniform(ceiling / 2, ceiling)

    async def _worker(self, worker_id: int) -> None:
        while True:
            key = await self.queue.get()
            try:
                await self._process(key)
            except asyncio.CancelledError:
                raise
            except Exception:  # never let one bad event kill the worker
                log.exception("worker %d: unexpected error processing %s", worker_id, key)
            finally:
                self.queue.task_done()

    async def _process(self, key: str) -> None:
        event = await self.db.get_pending(key)
        if event is None:
            return  # already delivered or failed

        fp = event.fingerprint
        if fp is None:
            loop = asyncio.get_running_loop()
            fp = await loop.run_in_executor(self._pool, fingerprint, event.cleaned_text)
            await self.db.set_fingerprint(key, fp)

        for attempt in range(1, self.max_attempts + 1):
            try:
                await self.downstream.forward_event(event.event_id, event.cleaned_text, fp, key)
            except RetryableDownstreamError as exc:
                await self.db.record_attempt(key, str(exc))
                if attempt == self.max_attempts:
                    break
                delay = self._backoff(attempt)
                log.warning("delivery of %s failed (%s), retry %d in %.2fs", key, exc, attempt, delay)
                await asyncio.sleep(delay)
                continue
            except Exception as exc:  # non-retryable (e.g. 4xx)
                await self.db.record_attempt(key, f"{type(exc).__name__}: {exc}")
                await self.db.set_status(key, STATUS_FAILED)
                log.error("delivery of %s failed permanently: %s", key, exc)
                return

            await self.db.record_attempt(key, None)
            await self.db.set_status(key, STATUS_DELIVERED)
            return

        await self.db.set_status(key, STATUS_FAILED)
        log.error("delivery of %s gave up after %d attempts", key, self.max_attempts)
