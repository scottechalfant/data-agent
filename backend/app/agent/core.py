"""Core agent loop: sends messages to Gemini, executes tool calls, returns responses."""

import json
import logging
from typing import Any

from google import genai
from google.genai import types

from app.config import settings
from app.agent.tools import TOOL_DECLARATIONS, TOOL_DISPATCH
from app.agent.prompts import SYSTEM_PROMPT
from app.agent.knowledge import get_knowledge_context, get_memories_context
from app.agent.types import AgentResponse, ChartSpec, StepLog

logger = logging.getLogger(__name__)

MAX_TOOL_ROUNDS = 15  # safety limit on tool-call loops

# Map tool names to workflow step descriptions
TOOL_STEP_LABELS = {
    "read_knowledge_file": "Research",
    "get_table_schema": "Research",
    "list_tables": "Research",
    "get_current_date": "Research",
    "run_query": "Query",
    "save_memory": "Memory",
    "create_chart": "Visualize",
}

_client: genai.Client | None = None


def get_client() -> genai.Client:
    global _client
    if _client is None:
        _client = genai.Client(
            vertexai=True,
            project=settings.google_cloud_project,
            location="us-central1",
        )
    return _client


def _serialize_tool_result(result: Any) -> str:
    """Convert a tool result to a JSON string for the model."""
    return json.dumps(result, default=str, ensure_ascii=False)


def _execute_function_call(name: str, args: dict) -> str:
    """Look up and execute a tool, returning the JSON-serialized result."""
    func = TOOL_DISPATCH.get(name)
    if func is None:
        return json.dumps({"error": f"Unknown tool: {name}"})

    logger.info(f"Executing tool: {name}({json.dumps(args, default=str)[:200]})")
    try:
        result = func(**args)
        return _serialize_tool_result(result)
    except Exception as e:
        logger.exception(f"Tool {name} raised an exception")
        return json.dumps({"error": f"Tool execution error: {str(e)}"})


def _summarize_result(name: str, result_str: str, max_len: int = 500) -> str:
    """Create a brief summary of a tool result for the step log."""
    try:
        parsed = json.loads(result_str)
    except json.JSONDecodeError:
        return result_str[:max_len]

    if "error" in parsed:
        return f"Error: {parsed['error']}"

    if name == "run_query":
        rows = parsed.get("rows", [])
        total = parsed.get("total_rows", len(rows))
        if rows:
            preview = json.dumps(rows[:3], default=str)
            if len(preview) > max_len:
                preview = preview[:max_len] + "..."
            return f"{total} rows returned. Preview: {preview}"
        return f"{total} rows returned."

    if name == "read_knowledge_file":
        content = parsed.get("content", "")
        return f"Loaded {parsed.get('filename', '?')} ({len(content)} chars)"

    if name == "get_table_schema":
        cols = parsed.get("columns", [])
        return f"{len(cols)} columns: {', '.join(c['name'] for c in cols[:10])}{'...' if len(cols) > 10 else ''}"

    if name == "list_tables":
        tables = parsed.get("tables", [])
        return f"{len(tables)} tables: {', '.join(t['name'] for t in tables[:10])}"

    if name == "create_chart":
        chart = parsed.get("chart", {})
        return f"Created {chart.get('type', '?')} chart: {chart.get('title', '?')}"

    if name == "save_memory":
        return parsed.get("entry", json.dumps(parsed, default=str)[:max_len])

    if name == "get_current_date":
        return f"{parsed.get('current_date', '?')} {parsed.get('current_time', '')}"

    # Fallback
    s = json.dumps(parsed, default=str)
    return s[:max_len] + ("..." if len(s) > max_len else "")


async def run_agent(
    user_message: str,
    conversation_history: list[types.Content] | None = None,
) -> tuple[AgentResponse, list[types.Content]]:
    """
    Run the agent loop for a single user turn.

    Args:
        user_message: The user's input text.
        conversation_history: Prior conversation contents (for multi-turn).

    Returns:
        (AgentResponse, updated_history) — the agent's final response and the
        full conversation history including this turn.
    """
    client = get_client()

    # Build the system instruction with knowledge file listing and memories
    system_instruction = (
        SYSTEM_PROMPT
        + "\n\n" + get_knowledge_context()
        + "\n\n" + get_memories_context()
    )

    # Build the conversation contents
    history = list(conversation_history or [])
    history.append(types.Content(role="user", parts=[types.Part(text=user_message)]))

    tool_calls_made: list[str] = []
    last_data: list[dict] | None = None
    charts: list[ChartSpec] = []
    steps: list[StepLog] = []
    step_counter = 0

    for round_num in range(MAX_TOOL_ROUNDS):
        response = client.models.generate_content(
            model=settings.gemini_model,
            contents=history,
            config=types.GenerateContentConfig(
                system_instruction=system_instruction,
                tools=[TOOL_DECLARATIONS],
                temperature=0.1,
            ),
        )

        candidate = response.candidates[0]
        parts = candidate.content.parts

        # Capture any reasoning text the model emitted in this round
        reasoning_texts = [p.text for p in parts if p.text]
        reasoning = "\n".join(reasoning_texts).strip() if reasoning_texts else None

        # Check if the model wants to call functions
        function_calls = [p for p in parts if p.function_call is not None]

        if not function_calls:
            # Model is done — log the final analysis/response step
            history.append(candidate.content)
            text = "".join(p.text for p in parts if p.text)

            if steps:
                step_counter += 1
                steps.append(StepLog(
                    step=step_counter,
                    description="Respond",
                    reasoning="Formulated final response.",
                ))

            return AgentResponse(
                message=text,
                data=last_data,
                charts=charts,
                steps=steps,
                tool_calls_made=tool_calls_made,
            ), history

        # Execute each function call and build function response parts
        history.append(candidate.content)
        response_parts = []

        for part in function_calls:
            fc = part.function_call
            tool_name = fc.name
            tool_args = dict(fc.args)
            tool_calls_made.append(tool_name)
            result_str = _execute_function_call(tool_name, tool_args)

            # Log this step
            step_counter += 1
            step_label = TOOL_STEP_LABELS.get(tool_name, "Tool")

            # Sanitize tool input for display (truncate large data, but keep SQL intact)
            display_args = {}
            for k, v in tool_args.items():
                if k == "sql":
                    display_args[k] = v
                elif isinstance(v, list) and len(v) > 5:
                    display_args[k] = f"[{len(v)} items]"
                elif isinstance(v, str) and len(v) > 1000:
                    display_args[k] = v[:1000] + "..."
                else:
                    display_args[k] = v

            steps.append(StepLog(
                step=step_counter,
                description=step_label,
                tool=tool_name,
                tool_input=display_args,
                tool_output_summary=_summarize_result(tool_name, result_str),
                reasoning=reasoning,
            ))
            # Only attach reasoning to the first tool call in a round
            reasoning = None

            # Track query result data for the API response
            if tool_name == "run_query":
                try:
                    parsed = json.loads(result_str)
                    if "rows" in parsed:
                        last_data = parsed["rows"]
                except (json.JSONDecodeError, KeyError):
                    pass

            # Collect chart specs
            if tool_name == "create_chart":
                try:
                    parsed = json.loads(result_str)
                    if "chart" in parsed:
                        c = parsed["chart"]
                        charts.append(ChartSpec(
                            type=c["type"],
                            title=c["title"],
                            x_key=c["x_key"],
                            y_keys=c["y_keys"],
                            data=c["data"],
                            x_label=c.get("x_label", ""),
                            y_label=c.get("y_label", ""),
                        ))
                except (json.JSONDecodeError, KeyError):
                    pass

            response_parts.append(
                types.Part(
                    function_response=types.FunctionResponse(
                        name=tool_name,
                        response=json.loads(result_str),
                    )
                )
            )

        history.append(types.Content(role="user", parts=response_parts))
        logger.info(f"Agent round {round_num + 1}: executed {len(function_calls)} tool(s)")

    # If we exhaust rounds, return what we have
    return AgentResponse(
        message="I reached the maximum number of tool calls. Here's what I found so far based on the queries I ran.",
        data=last_data,
        charts=charts,
        steps=steps,
        tool_calls_made=tool_calls_made,
    ), history


async def run_autonomous(prompt: str) -> AgentResponse:
    """Run the agent with no prior history — used for scheduled/autonomous tasks."""
    response, _ = await run_agent(prompt, conversation_history=None)
    return response
