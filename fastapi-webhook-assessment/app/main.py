from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.database import Database
from app.downstream import DownstreamClient
from app.pipeline import DeliveryPipeline
from app.processor import scrub


class WebhookPayload(BaseModel):
    event_id: str
    tenant_id: str
    content: str


@asynccontextmanager
async def lifespan(app: FastAPI):
    db = Database()
    await db.connect()
    downstream = DownstreamClient()
    pipeline = DeliveryPipeline(db, downstream)
    await pipeline.start()

    app.state.db = db
    app.state.pipeline = pipeline
    try:
        yield
    finally:
        await pipeline.stop()
        await downstream.aclose()
        await db.close()


app = FastAPI(title="Webhook Ingestion Service", lifespan=lifespan)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/webhooks/ingest")
async def ingest_webhook(
    payload: WebhookPayload,
    request: Request,
    x_idempotency_key: str | None = Header(default=None),
):
    if not x_idempotency_key:
        raise HTTPException(status_code=400, detail="Missing X-Idempotency-Key header")

    db: Database = request.app.state.db
    pipeline: DeliveryPipeline = request.app.state.pipeline

    # PII is scrubbed before anything is persisted; raw content never touches disk.
    cleaned_text = scrub(payload.content)

    # The UNIQUE constraint is the idempotency gate: exactly one concurrent caller wins.
    is_new = await db.insert_if_new(x_idempotency_key, payload.event_id, payload.tenant_id, cleaned_text)
    if not is_new:
        return JSONResponse(
            status_code=200,
            content={"status": "duplicate", "event_id": payload.event_id},
        )

    # Durably recorded -> safe to acknowledge. Fingerprinting and delivery happen in the background.
    pipeline.enqueue(x_idempotency_key)
    return JSONResponse(
        status_code=202,
        content={"status": "accepted", "event_id": payload.event_id},
    )
