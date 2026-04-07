"""
Knowledge system with two tiers:

1. Core knowledge (e.g. datamodel.md): loaded at startup, full content injected
   directly into the system prompt. Always available to the agent.

2. Supplemental knowledge (all other files): loaded at startup, summarized by
   Gemini. Summaries go into the system prompt. The agent calls
   `read_knowledge_file(filename)` to load full content on demand.
"""

import logging
from dataclasses import dataclass

from google.cloud import storage

from app.config import settings

logger = logging.getLogger(__name__)

SUMMARIZE_PROMPT = """\
You are indexing a documentation file for a data analysis agent. Read the file below and produce \
a concise summary (3-8 bullet points) that captures:

- Which BigQuery tables/views are documented
- Key columns and their purpose
- Important join keys and relationships to other tables
- Critical gotchas, data type quirks, or required filters
- Any business rules or metric definitions

The summary will be used by the agent to decide whether to load this file when answering a \
specific question. Be specific enough that the agent can make a good decision.

Filename: {filename}

---

{content}
"""


@dataclass
class KnowledgeFile:
    filename: str
    content: str
    summary: str = ""


# Core knowledge — full content in system prompt
_core_content: str = ""

# Supplemental knowledge — summaries in system prompt, full content on demand
_supplemental_files: list[KnowledgeFile] = []

_loaded: bool = False
_summarized: bool = False

_gcs_client: storage.Client | None = None


def _get_gcs_client() -> storage.Client:
    global _gcs_client
    if _gcs_client is None:
        _gcs_client = storage.Client(project=settings.google_cloud_project)
    return _gcs_client


def load_knowledge() -> None:
    """Load only the core knowledge file from GCS at startup. Supplemental files are loaded on demand."""
    global _core_content, _supplemental_files, _loaded

    bucket_name = settings.gcs_bucket
    core_path = settings.gcs_knowledge_prefix + settings.gcs_core_knowledge_file

    logger.info(f"Loading core knowledge from gs://{bucket_name}/{core_path}")

    try:
        client = _get_gcs_client()
        bucket = client.bucket(bucket_name)
        blob = bucket.blob(core_path)

        _core_content = ""
        _supplemental_files = []

        if blob.exists():
            _core_content = blob.download_as_text(encoding="utf-8")
            logger.info(f"Loaded core knowledge: {settings.gcs_core_knowledge_file} ({len(_core_content)} chars)")
        else:
            logger.warning(f"Core knowledge file not found: gs://{bucket_name}/{core_path}")

    except Exception:
        logger.exception(f"Failed to list knowledge files from gs://{bucket_name}/{prefix}")

    _loaded = True
    logger.info(
        f"Knowledge loaded: core={'yes' if _core_content else 'no'}, "
        f"supplemental={len(_supplemental_files)} file(s)"
    )


async def summarize_knowledge() -> None:
    """Use Gemini to summarize each supplemental knowledge file. Called once at startup."""
    global _summarized

    if not _supplemental_files:
        _summarized = True
        return

    from app.agent.core import get_client
    from google.genai import types

    client = get_client()

    for kf in _supplemental_files:
        if kf.summary:
            continue

        prompt = SUMMARIZE_PROMPT.format(filename=kf.filename, content=kf.content)

        try:
            response = client.models.generate_content(
                model=settings.gemini_model,
                contents=[types.Content(role="user", parts=[types.Part(text=prompt)])],
                config=types.GenerateContentConfig(temperature=0.0),
            )
            kf.summary = response.candidates[0].content.parts[0].text
            logger.info(f"Summarized {kf.filename} ({len(kf.summary)} chars)")
        except Exception:
            logger.exception(f"Failed to summarize {kf.filename}")
            kf.summary = f"[Auto-summary failed. First 500 chars:]\n{kf.content[:500]}"

    _summarized = True
    logger.info("Knowledge summarization complete")


def get_knowledge_context() -> str:
    """Return knowledge for the system prompt: core content only. Supplemental files loaded on demand."""
    if not _core_content:
        return ""

    return f"## Data Model Reference\n\n{_core_content}"


def get_file_content(filename: str) -> str | None:
    """Return the full content of a knowledge file. Loads from GCS on demand if not in memory."""
    if filename == settings.gcs_core_knowledge_file and _core_content:
        return _core_content
    for kf in _supplemental_files:
        if kf.filename == filename:
            return kf.content

    # Try loading from GCS on demand
    try:
        client = _get_gcs_client()
        bucket = client.bucket(settings.gcs_bucket)
        blob = bucket.blob(settings.gcs_knowledge_prefix + filename)
        if blob.exists():
            content = blob.download_as_text(encoding="utf-8")
            _supplemental_files.append(KnowledgeFile(filename=filename, content=content))
            logger.info(f"Loaded supplemental file on demand: {filename} ({len(content)} chars)")
            return content
    except Exception:
        logger.exception(f"Failed to load knowledge file on demand: {filename}")

    return None


def get_filenames() -> list[str]:
    """Return available knowledge filenames (core + any already-loaded supplemental + listing from GCS)."""
    names = set()
    if _core_content:
        names.add(settings.gcs_core_knowledge_file)
    for kf in _supplemental_files:
        names.add(kf.filename)

    # List all files from GCS so the agent knows what's available
    try:
        client = _get_gcs_client()
        bucket = client.bucket(settings.gcs_bucket)
        prefix = settings.gcs_knowledge_prefix
        for blob in bucket.list_blobs(prefix=prefix):
            name = blob.name.removeprefix(prefix)
            if name and not name.startswith("."):
                names.add(name)
    except Exception:
        logger.exception("Failed to list knowledge files from GCS")

    return sorted(names)


def get_index_summary() -> list[dict]:
    """Return a summary of loaded knowledge files (for health/debug endpoints)."""
    entries = []
    if _core_content:
        entries.append({
            "filename": settings.gcs_core_knowledge_file,
            "size_chars": len(_core_content),
            "type": "core",
        })
    for kf in _supplemental_files:
        entries.append({
            "filename": kf.filename,
            "size_chars": len(kf.content),
            "summary_chars": len(kf.summary),
            "summarized": bool(kf.summary),
            "type": "supplemental",
        })
    return entries


# ---------------------------------------------------------------------------
# Agent memories — a single append-only file on GCS
# ---------------------------------------------------------------------------

_memories: str = ""


def load_memories() -> None:
    """Load the memories file from GCS at startup."""
    global _memories

    bucket_name = settings.gcs_bucket
    path = settings.gcs_memories_path

    try:
        client = _get_gcs_client()
        bucket = client.bucket(bucket_name)
        blob = bucket.blob(path)

        if blob.exists():
            _memories = blob.download_as_text(encoding="utf-8")
            logger.info(f"Loaded memories ({len(_memories)} chars)")
        else:
            _memories = ""
            logger.info("No memories file found — starting fresh")
    except Exception:
        logger.exception("Failed to load memories")
        _memories = ""


def get_memories_context() -> str:
    """Return memories formatted for the system prompt."""
    if not _memories.strip():
        return ""

    return (
        "## Agent Memories\n\n"
        "These are things you've been told to remember or have learned from past interactions. "
        "Use them to inform your analysis and responses.\n\n"
        + _memories
    )


def save_memory(memory: str) -> dict:
    """Append a new memory entry to the memories file on GCS."""
    global _memories

    from datetime import datetime
    import zoneinfo

    tz = zoneinfo.ZoneInfo("America/Chicago")
    timestamp = datetime.now(tz).strftime("%Y-%m-%d %H:%M")

    entry = f"- [{timestamp}] {memory}\n"

    _memories += entry

    # Write back to GCS
    bucket_name = settings.gcs_bucket
    path = settings.gcs_memories_path

    try:
        client = _get_gcs_client()
        bucket = client.bucket(bucket_name)
        blob = bucket.blob(path)
        blob.upload_from_string(_memories, content_type="text/markdown")
        logger.info(f"Saved memory: {memory[:100]}")
        return {"saved": True, "entry": entry.strip()}
    except Exception as e:
        logger.exception("Failed to save memory")
        return {"error": f"Failed to save memory: {str(e)}"}
