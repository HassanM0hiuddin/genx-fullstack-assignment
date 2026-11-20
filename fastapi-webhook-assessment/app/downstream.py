import os

import httpx

DOWNSTREAM_URL = os.getenv("DOWNSTREAM_URL", "http://127.0.0.1:9001/events")


class RetryableDownstreamError(Exception):
    """The downstream call failed in a way that is safe and sensible to retry."""


class DownstreamClient:
    """Wraps one shared httpx.AsyncClient so connections are pooled and reused."""

    def __init__(self, url: str | None = None, timeout: float = 10.0, max_connections: int = 50) -> None:
        self.url = url or os.getenv("DOWNSTREAM_URL", DOWNSTREAM_URL)
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout, connect=3.0),
            limits=httpx.Limits(max_connections=max_connections, max_keepalive_connections=max_connections),
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def forward_event(
        self, event_id: str, cleaned_text: str, fingerprint: str, idempotency_key: str
    ) -> dict:
        try:
            response = await self._client.post(
                self.url,
                json={"event_id": event_id, "text": cleaned_text, "fingerprint": fingerprint},
                # Lets a downstream that supports it de-duplicate our own retries
                # (e.g. when we time out after it has already accepted the event).
                headers={"Idempotency-Key": idempotency_key},
            )
        except httpx.TransportError as exc:  # connect errors, timeouts, resets
            raise RetryableDownstreamError(f"{type(exc).__name__}: {exc}") from exc

        if response.status_code in (408, 425, 429) or response.status_code >= 500:
            raise RetryableDownstreamError(f"HTTP {response.status_code}")
        response.raise_for_status()  # other 4xx: permanent, not retried
        return response.json()
