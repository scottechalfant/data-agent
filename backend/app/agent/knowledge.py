"""
Knowledge system with two phases:

1. Startup: Load all files from gs://{bucket}/knowledge/, then use Gemini to
   produce a concise summary of each. Summaries are held in memory and injected
   into the system prompt.

2. Query time: The agent calls `read_knowledge_file(filename)` to load the full
   content of specific files it needs based on the summaries.
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


_files: list[KnowledgeFile] = []
_loaded: bool = False
_summarized: bool = False

_gcs_client: storage.Client | None = None


def _get_gcs_client() -> storage.Client:
    global _gcs_client
    if _gcs_client is None:
        _gcs_client = storage.Client(project=settings.google_cloud_project)
    return _gcs_client


def load_knowledge() -> None:
    """Read all files from gs://{bucket}/knowledge/ into memory."""
    global _files, _loaded

    prefix = settings.gcs_knowledge_prefix
    bucket_name = settings.gcs_bucket

    logger.info(f"Loading knowledge files from gs://{bucket_name}/{prefix}")

    try:
        client = _get_gcs_client()
        bucket = client.bucket(bucket_name)
        blobs = list(bucket.list_blobs(prefix=prefix))

        _files = []
        for blob in blobs:
            # Skip the prefix "directory" itself
            name = blob.name.removeprefix(prefix)
            if not name or name.startswith("."):
                continue

            try:
                content = blob.download_as_text(encoding="utf-8")
                _files.append(KnowledgeFile(filename=name, content=content))
                logger.info(f"Loaded knowledge file: {name} ({len(content)} chars)")
            except Exception:
                logger.exception(f"Failed to read knowledge file: {name}")

    except Exception:
        logger.exception(f"Failed to list knowledge files from gs://{bucket_name}/{prefix}")

    _loaded = True
    logger.info(f"Knowledge files loaded: {len(_files)} file(s)")


async def summarize_knowledge() -> None:
    """Use Gemini to summarize each knowledge file. Called once at startup."""
    global _summarized

    if not _files:
        _summarized = True
        return

    from app.agent.core import get_client
    from google.genai import types

    client = get_client()

    for kf in _files:
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
            # Fallback: first 500 chars as summary
            kf.summary = f"[Auto-summary failed. First 500 chars:]\n{kf.content[:500]}"

    _summarized = True
    logger.info("Knowledge summarization complete")


def get_knowledge_context() -> str:
    """Return the file summaries for inclusion in the system prompt."""
    if not _files:
        return ""

    sections = []
    for kf in _files:
        summary = kf.summary or f"({len(kf.content)} chars, not yet summarized)"
        sections.append(f"### `{kf.filename}`\n{summary}")

    return (
        "## Knowledge Base\n\n"
        "These documentation files are available. Review the summaries below to decide which "
        "file(s) to load with `read_knowledge_file` before writing queries.\n\n"
        + "\n\n".join(sections)
    )


def get_file_content(filename: str) -> str | None:
    """Return the full content of a specific knowledge file."""
    for kf in _files:
        if kf.filename == filename:
            return kf.content
    return None


def get_filenames() -> list[str]:
    """Return all available knowledge filenames."""
    return [kf.filename for kf in _files]


def get_index_summary() -> list[dict]:
    """Return a summary of loaded knowledge files (for health/debug endpoints)."""
    return [
        {
            "filename": kf.filename,
            "size_chars": len(kf.content),
            "summary_chars": len(kf.summary),
            "summarized": bool(kf.summary),
        }
        for kf in _files
    ]


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
