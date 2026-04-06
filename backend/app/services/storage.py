"""GCS-backed conversation and report storage.

Layout:
  gs://{bucket}/conversations/{id}.json
  gs://{bucket}/reports/{id}.json
"""

import json
import logging
import uuid
from datetime import datetime, timezone

from google.cloud import storage
from google.genai import types

from app.config import settings

logger = logging.getLogger(__name__)

_client: storage.Client | None = None


def _get_client() -> storage.Client:
    global _client
    if _client is None:
        _client = storage.Client(project=settings.google_cloud_project)
    return _client


def _bucket() -> storage.Bucket:
    return _get_client().bucket(settings.gcs_bucket)


# ---------------------------------------------------------------------------
# Serialization (same logic as before — Gemini Content ↔ dict)
# ---------------------------------------------------------------------------

def _serialize_contents(contents: list[types.Content]) -> list[dict]:
    serialized = []
    for content in contents:
        parts_data = []
        for part in content.parts:
            if part.text is not None:
                parts_data.append({"text": part.text})
            elif part.function_call is not None:
                parts_data.append({
                    "function_call": {
                        "name": part.function_call.name,
                        "args": dict(part.function_call.args),
                    }
                })
            elif part.function_response is not None:
                parts_data.append({
                    "function_response": {
                        "name": part.function_response.name,
                        "response": part.function_response.response,
                    }
                })
        serialized.append({"role": content.role, "parts": parts_data})
    return serialized


def _deserialize_contents(data: list[dict]) -> list[types.Content]:
    contents = []
    for item in data:
        parts = []
        for p in item["parts"]:
            if "text" in p:
                parts.append(types.Part(text=p["text"]))
            elif "function_call" in p:
                fc = p["function_call"]
                parts.append(types.Part(
                    function_call=types.FunctionCall(name=fc["name"], args=fc["args"])
                ))
            elif "function_response" in p:
                fr = p["function_response"]
                parts.append(types.Part(
                    function_response=types.FunctionResponse(
                        name=fr["name"], response=fr["response"]
                    )
                ))
        contents.append(types.Content(role=item["role"], parts=parts))
    return contents


# ---------------------------------------------------------------------------
# Conversations
# ---------------------------------------------------------------------------

async def get_conversation(conversation_id: str) -> list[types.Content] | None:
    blob = _bucket().blob(f"conversations/{conversation_id}.json")
    if not blob.exists():
        return None
    data = json.loads(blob.download_as_text())
    return _deserialize_contents(data.get("history", []))


async def save_conversation(
    conversation_id: str,
    history: list[types.Content],
    title: str | None = None,
) -> None:
    blob = _bucket().blob(f"conversations/{conversation_id}.json")

    # Merge with existing metadata if present
    doc_data: dict = {}
    if blob.exists():
        doc_data = json.loads(blob.download_as_text())

    doc_data["history"] = _serialize_contents(history)
    doc_data["updated_at"] = datetime.now(timezone.utc).isoformat()
    if title:
        doc_data["title"] = title
    doc_data.setdefault("created_at", doc_data["updated_at"])

    blob.upload_from_string(
        json.dumps(doc_data, default=str, ensure_ascii=False),
        content_type="application/json",
    )


async def list_conversations(limit: int = 50) -> list[dict]:
    bucket = _bucket()
    blobs = list(bucket.list_blobs(prefix="conversations/"))

    # Sort by updated time (falls back to GCS blob updated timestamp)
    summaries = []
    for blob in blobs:
        if not blob.name.endswith(".json"):
            continue
        try:
            data = json.loads(blob.download_as_text())
        except Exception:
            continue
        conv_id = blob.name.removeprefix("conversations/").removesuffix(".json")
        summaries.append({
            "id": conv_id,
            "title": data.get("title", "Untitled"),
            "updated_at": data.get("updated_at"),
            "created_at": data.get("created_at"),
        })

    summaries.sort(key=lambda x: x.get("updated_at") or "", reverse=True)
    return summaries[:limit]


# ---------------------------------------------------------------------------
# Trend reports
# ---------------------------------------------------------------------------

async def save_trend_report(report: dict) -> str:
    report_id = uuid.uuid4().hex[:12]
    report["created_at"] = datetime.now(timezone.utc).isoformat()
    report["id"] = report_id

    blob = _bucket().blob(f"reports/{report_id}.json")
    blob.upload_from_string(
        json.dumps(report, default=str, ensure_ascii=False),
        content_type="application/json",
    )
    return report_id


async def list_trend_reports(limit: int = 20) -> list[dict]:
    bucket = _bucket()
    blobs = list(bucket.list_blobs(prefix="reports/"))

    reports = []
    for blob in blobs:
        if not blob.name.endswith(".json"):
            continue
        try:
            data = json.loads(blob.download_as_text())
        except Exception:
            continue
        reports.append(data)

    reports.sort(key=lambda x: x.get("created_at") or "", reverse=True)
    return reports[:limit]
