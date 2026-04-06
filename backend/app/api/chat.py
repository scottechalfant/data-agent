"""Chat API endpoints for the interactive agent."""

import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.agent.core import run_agent
from app.services.storage import (
    get_conversation,
    list_conversations,
    save_conversation,
)

router = APIRouter(prefix="/api/chat", tags=["chat"])


class ChatRequest(BaseModel):
    message: str
    conversation_id: str | None = None


class ChartData(BaseModel):
    type: str
    title: str
    x_key: str
    y_keys: list[str]
    data: list[dict[str, Any]]
    x_label: str = ""
    y_label: str = ""


class StepLogData(BaseModel):
    step: int
    description: str
    tool: str | None = None
    tool_input: dict[str, Any] | None = None
    tool_output_summary: str | None = None
    reasoning: str | None = None


class ChatResponse(BaseModel):
    conversation_id: str
    message: str
    data: list[dict] | None = None
    charts: list[ChartData] = []
    steps: list[StepLogData] = []
    tool_calls_made: list[str] = []


class ConversationSummary(BaseModel):
    id: str
    title: str
    updated_at: str | None
    created_at: str | None


@router.post("", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """Send a message to the agent and get a response."""
    conversation_id = request.conversation_id or str(uuid.uuid4())

    # Load existing conversation or start fresh
    history = None
    if request.conversation_id:
        history = await get_conversation(request.conversation_id)
        if history is None:
            raise HTTPException(status_code=404, detail="Conversation not found")

    # Run the agent
    try:
        response, updated_history = await run_agent(request.message, history)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Agent error: {str(e)}")

    # Generate a title from the first message
    title = request.message[:80] if not request.conversation_id else None

    # Persist conversation
    await save_conversation(conversation_id, updated_history, title=title)

    return ChatResponse(
        conversation_id=conversation_id,
        message=response.message,
        data=response.data,
        charts=[
            ChartData(
                type=c.type,
                title=c.title,
                x_key=c.x_key,
                y_keys=c.y_keys,
                data=c.data,
                x_label=c.x_label,
                y_label=c.y_label,
            )
            for c in response.charts
        ],
        steps=[
            StepLogData(
                step=s.step,
                description=s.description,
                tool=s.tool,
                tool_input=s.tool_input,
                tool_output_summary=s.tool_output_summary,
                reasoning=s.reasoning,
            )
            for s in response.steps
        ],
        tool_calls_made=response.tool_calls_made,
    )


@router.get("/conversations", response_model=list[ConversationSummary])
async def get_conversations():
    """List recent conversations."""
    return await list_conversations()
