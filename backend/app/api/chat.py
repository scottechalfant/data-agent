"""Chat API endpoints for the interactive agent."""

import asyncio
import json
import logging
import uuid
from typing import Any

logger = logging.getLogger(__name__)

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.auth import get_user_id
from app.agent.core import run_agent, CancelledError
from app.services.storage import (
    get_conversation,
    list_conversations,
    save_conversation,
)

router = APIRouter(prefix="/api/chat", tags=["chat"])

# In-memory task store
_tasks: dict[str, dict] = {}


class ChatRequest(BaseModel):
    message: str
    conversation_id: str | None = None
    model: str | None = None


class ConversationSummary(BaseModel):
    id: str
    title: str
    updated_at: str | None
    created_at: str | None


@router.post("")
async def chat(request_body: ChatRequest, request: Request):
    """Start an agent task. Returns a task_id to poll for progress and results."""
    user_id = get_user_id(request)
    conversation_id = request_body.conversation_id or str(uuid.uuid4())
    task_id = str(uuid.uuid4())

    # Load existing conversation or start fresh
    history = None
    if request_body.conversation_id:
        history = await get_conversation(user_id, request_body.conversation_id)
        if history is None:
            raise HTTPException(status_code=404, detail="Conversation not found")

    # Initialize task state
    cancel_event = asyncio.Event()
    task_state = {
        "status": "starting",
        "plan": None,
        "progress": [],
        "result": None,
        "error": None,
        "cancel_event": cancel_event,
        "conversation_id": conversation_id,
    }
    _tasks[task_id] = task_state

    async def on_progress(status: str):
        if status.startswith("plan:"):
            task_state["plan"] = status[5:]
        else:
            task_state["status"] = status

    # Run agent in background
    async def run_task():
        try:
            result = await run_agent(
                request_body.message,
                history,
                on_progress=on_progress,
                cancel_event=cancel_event,
                model_override=request_body.model,
            )
            if result is None:
                raise RuntimeError("Agent returned None")
            response, updated_history = result

            # Persist conversation
            title = request_body.message[:80] if not request_body.conversation_id else None
            await save_conversation(user_id, conversation_id, updated_history, title=title)

            # Check clarification
            if response.clarification:
                task_state["result"] = {
                    "type": "clarification",
                    "conversation_id": conversation_id,
                    "question": response.clarification.question,
                    "response_type": response.clarification.response_type,
                    "options": response.clarification.options or [],
                }
            else:
                def _serialize_block(b):
                    d = {"type": b.type}
                    if b.type == "text":
                        d["content"] = b.content
                    elif b.type == "chart":
                        d["chart_type"] = b.chart_type
                        d["chart_title"] = b.chart_title
                        d["x_key"] = b.x_key
                        d["y_keys"] = b.y_keys
                        d["x_label"] = b.x_label
                        d["y_label"] = b.y_label
                        d["data"] = b.chart_data
                    elif b.type == "table":
                        d["columns"] = [
                            {"key": c.key, "label": c.label, "format": c.format, "align": c.align}
                            for c in (b.columns or [])
                        ]
                        d["rows"] = b.rows
                        d["caption"] = b.caption
                    elif b.type == "hierarchy_table":
                        d["hierarchy_keys"] = b.hierarchy_keys
                        d["columns"] = [
                            {"key": c.key, "label": c.label, "format": c.format, "align": c.align}
                            for c in (b.value_columns or b.columns or [])
                        ]
                        d["data"] = b.hierarchy_data
                    return d

                task_state["result"] = {
                    "type": "result",
                    "conversation_id": conversation_id,
                    "blocks": [_serialize_block(b) for b in (response.blocks or [])],
                    "steps": [
                        {
                            "step": s.step, "description": s.description,
                            "tool": s.tool, "tool_input": s.tool_input,
                            "tool_output_summary": s.tool_output_summary,
                            "reasoning": s.reasoning,
                        }
                        for s in (response.steps or [])
                    ],
                    "tool_calls_made": list(response.tool_calls_made or []),
                    "token_usage": {
                        "input_tokens": response.token_usage.input_tokens,
                        "output_tokens": response.token_usage.output_tokens,
                    } if response.token_usage else None,
                }

            task_state["status"] = "complete"
        except CancelledError:
            task_state["status"] = "cancelled"
            task_state["error"] = "Cancelled by user."
        except Exception as e:
            import traceback
            logger.error(f"Agent task error: {traceback.format_exc()}")
            task_state["status"] = "error"
            task_state["error"] = str(e)

    asyncio.create_task(run_task())

    return {"task_id": task_id, "conversation_id": conversation_id}


@router.get("/task/{task_id}")
async def get_task(task_id: str):
    """Poll for task status and results."""
    task = _tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    response = {
        "status": task["status"],
        "plan": task["plan"],
        "conversation_id": task["conversation_id"],
    }

    if task["status"] == "complete" and task["result"]:
        response["result"] = task["result"]
        # Clean up after delivery
        del _tasks[task_id]
    elif task["status"] in ("error", "cancelled"):
        response["error"] = task["error"]
        del _tasks[task_id]

    return response


@router.post("/cancel")
async def cancel(request: Request):
    """Cancel an in-progress agent request."""
    body = await request.json()
    task_id = body.get("task_id")
    if not task_id:
        raise HTTPException(status_code=400, detail="task_id required")

    task = _tasks.get(task_id)
    if task and task.get("cancel_event"):
        task["cancel_event"].set()
        return {"cancelled": True}
    return {"cancelled": False, "detail": "Task not found or already completed"}


@router.get("/conversations", response_model=list[ConversationSummary])
async def get_conversations(request: Request):
    """List recent conversations for the current user."""
    user_id = get_user_id(request)
    return await list_conversations(user_id)
