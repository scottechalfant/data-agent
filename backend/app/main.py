"""FastAPI application entry point."""

import logging
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(override=True)

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.agent.knowledge import load_knowledge, load_memories, summarize_knowledge, get_index_summary
from app.api.chat import router as chat_router
from app.api.scheduled import router as scheduled_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)

app = FastAPI(
    title="RTIC Data Analysis Agent",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
async def startup():
    load_knowledge()
    load_memories()
    await summarize_knowledge()


app.include_router(chat_router)
app.include_router(scheduled_router)


@app.get("/health")
async def health():
    return {"status": "ok", "knowledge": get_index_summary()}


# Serve frontend — must be last so /api and /health routes take priority
static_dir = Path(__file__).resolve().parent.parent / "static"
if static_dir.is_dir():
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
