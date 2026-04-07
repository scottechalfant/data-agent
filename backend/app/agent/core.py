"""Core agent loop: sends messages to Gemini, executes tool calls, returns responses."""

import asyncio
import json
import logging
from collections.abc import Callable, Coroutine
from typing import Any

from google import genai
from google.genai import types

from app.config import settings
from app.agent.tools import TOOL_DECLARATIONS, TOOL_DISPATCH
from app.agent.prompts import SYSTEM_PROMPT
from app.agent.knowledge import get_knowledge_context, get_memories_context
from app.agent.types import AgentResponse, ChartSpec, Clarification, HierarchyTableSpec, StepLog

logger = logging.getLogger(__name__)

MAX_TOOL_ROUNDS = 15  # safety limit on tool-call loops


def _strip_markdown_tables(text: str) -> str:
    """Remove markdown tables from text. They display as duplicates of the auto-rendered table."""
    import re
    # Match markdown tables: lines starting with | and separator lines with |---|
    lines = text.split("\n")
    result = []
    in_table = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("|") and stripped.endswith("|"):
            in_table = True
            continue
        if in_table and (stripped.startswith("|") or stripped.startswith(":")):
            continue
        in_table = False
        result.append(line)
    return "\n".join(result).strip()

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
            location="global",
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


def _describe_tool_call(name: str, args: dict) -> str:
    """Generate a human-readable description of what a tool call is doing."""
    if name == "run_query":
        sql = args.get("sql", "")
        sql_upper = sql.upper().strip()
        # Try to extract a meaningful description from the SQL
        parts = []
        if "COUNT(" in sql_upper or "SUM(" in sql_upper:
            parts.append("Aggregating")
        elif "SELECT" in sql_upper:
            parts.append("Querying")
        # Look for table names
        tables = []
        for keyword in ["FROM ", "JOIN "]:
            idx = sql_upper.find(keyword)
            while idx != -1:
                after = sql[idx + len(keyword):].strip()
                table = after.split()[0].strip("(") if after else ""
                if table and not table.upper().startswith("("):
                    tables.append(table.rstrip(","))
                idx = sql_upper.find(keyword, idx + 1)
        if tables:
            unique_tables = list(dict.fromkeys(tables))  # preserve order, dedupe
            parts.append("from " + ", ".join(unique_tables[:3]))
        # Look for date filters to describe the time range
        for pattern in ["INTERVAL ", "BETWEEN ", ">= '20", "> '20"]:
            if pattern in sql_upper or pattern in sql:
                parts.append("with date filters")
                break
        # Look for GROUP BY to describe grouping
        if "GROUP BY" in sql_upper:
            group_idx = sql_upper.find("GROUP BY")
            group_clause = sql[group_idx + 9:].split("ORDER")[0].split("HAVING")[0].split("LIMIT")[0].strip()
            if group_clause:
                parts.append(f"grouped by {group_clause.strip()}")
        return " ".join(parts) if parts else "Executing SQL query"

    if name == "read_knowledge_file":
        return f"Loading documentation: {args.get('filename', '?')}"

    if name == "get_table_schema":
        return f"Checking schema for {args.get('dataset', '?')}.{args.get('table', '?')}"

    if name == "list_tables":
        return f"Listing tables in {args.get('dataset', '?')} dataset"

    if name == "get_current_date":
        return "Getting current date and time"

    if name == "save_memory":
        memory = args.get("memory", "")
        return f"Saving to memory: {memory[:80]}{'...' if len(memory) > 80 else ''}"

    if name == "create_chart":
        return f"Creating {args.get('chart_type', '?')} chart: {args.get('title', '?')}"

    return f"Calling {name}"


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


# Human-readable status messages for each tool
TOOL_STATUS_MESSAGES = {
    "read_knowledge_file": "Reading documentation...",
    "get_table_schema": "Checking table schema...",
    "list_tables": "Listing available tables...",
    "get_current_date": "Getting current date...",
    "run_query": "Running query...",
    "save_memory": "Saving to memory...",
    "create_chart": "Creating chart...",
}

# Type for the progress callback
ProgressCallback = Callable[[str], Coroutine[Any, Any, None]]

PLAN_PROMPT = """\
The user asked: "{user_message}"

Respond with ONLY a single short sentence (under 100 characters) describing the analysis plan. \
No SQL. No code. No markdown. No explanation. Just one plain-text sentence starting with a verb.
Example: "Check item_metrics for last week's D2C sales by channel and compare to prior week."
"""


CLARIFICATION_PROMPT = """\
The user asked: "{user_message}"

Decide if you need to ask the user a clarifying question before you can answer. You should ask \
ONLY if the request is genuinely ambiguous — meaning you would get a materially different answer \
depending on the interpretation. Do NOT ask if you can make a reasonable assumption.

Examples of when to ask:
- "Show me sales" — which channel? what time period? (too vague)
- "Compare these products" — which products? (missing info)

Examples of when NOT to ask:
- "What were D2C sales last week?" — clear enough, proceed
- "Show me inventory" — assume current snapshot, all items, warehouse locations
- "How are Road Trip Tumblers doing?" — assume recent sales trend, proceed

If you need to ask, respond with EXACTLY this JSON format (no other text):
{{"question": "your question here", "type": "multiple_choice", "options": ["Option A", "Option B", "Option C"]}}

Or for free-text:
{{"question": "your question here", "type": "free_text"}}

If no clarification is needed, respond with exactly: PROCEED
"""


class CancelledError(Exception):
    """Raised when the user cancels the agent."""
    pass


async def check_clarification(
    client: genai.Client,
    user_message: str,
    system_instruction: str,
) -> Clarification | None:
    """Check if the agent needs to ask a clarifying question before proceeding."""
    prompt = CLARIFICATION_PROMPT.format(user_message=user_message)
    try:
        response = await asyncio.to_thread(
            client.models.generate_content,
            model=settings.gemini_model_fast,
            contents=[types.Content(role="user", parts=[types.Part(text=prompt)])],
            config=types.GenerateContentConfig(
                system_instruction=system_instruction,
                temperature=0.0,
            ),
        )
        text = response.candidates[0].content.parts[0].text.strip()

        if text == "PROCEED" or text.startswith("PROCEED"):
            return None

        # Try to parse as JSON
        parsed = json.loads(text)
        return Clarification(
            question=parsed["question"],
            response_type=parsed.get("type", "free_text"),
            options=parsed.get("options", []),
        )
    except (json.JSONDecodeError, KeyError):
        # If parsing fails, treat as no clarification needed
        logger.warning(f"Failed to parse clarification response: {text[:200]}")
        return None
    except Exception:
        logger.exception("Failed to check clarification")
        return None


async def generate_plan(
    client: genai.Client,
    user_message: str,
    system_instruction: str,
) -> str:
    """Generate a brief plan description before the main agent loop."""
    prompt = PLAN_PROMPT.format(user_message=user_message)
    try:
        response = await asyncio.to_thread(
            client.models.generate_content,
            model=settings.gemini_model_fast,
            contents=[types.Content(role="user", parts=[types.Part(text=prompt)])],
            config=types.GenerateContentConfig(
                system_instruction=system_instruction,
                temperature=0.0,
            ),
        )
        text = response.candidates[0].content.parts[0].text.strip()
        # Strip any markdown/code fences and truncate
        text = text.replace("```", "").replace("`", "").strip()
        # Take only the first line/sentence
        first_line = text.split("\n")[0].strip()
        if len(first_line) > 150:
            first_line = first_line[:147] + "..."
        return first_line
    except Exception:
        logger.exception("Failed to generate plan")
        return ""


async def run_agent(
    user_message: str,
    conversation_history: list[types.Content] | None = None,
    on_progress: ProgressCallback | None = None,
    cancel_event: asyncio.Event | None = None,
    model_override: str | None = None,
) -> tuple[AgentResponse, list[types.Content]]:
    """
    Run the agent loop for a single user turn.

    Args:
        user_message: The user's input text.
        conversation_history: Prior conversation contents (for multi-turn).
        on_progress: Optional async callback called with status messages as the agent works.
        cancel_event: Optional event that, when set, stops the agent loop.

    Returns:
        (AgentResponse, updated_history) — the agent's final response and the
        full conversation history including this turn.
    """
    client = get_client()
    agent_model = model_override or settings.gemini_model

    def _check_cancelled():
        if cancel_event and cancel_event.is_set():
            raise CancelledError()

    # Clear query cache for this request
    from app.agent.tools import _query_cache
    _query_cache.clear()

    # Inject current date so the agent never has to guess
    from datetime import datetime
    import zoneinfo
    tz = zoneinfo.ZoneInfo("America/Chicago")
    now = datetime.now(tz)
    date_context = (
        f"## Current Date\n"
        f"Today is {now.strftime('%A, %B %d, %Y')} ({now.strftime('%Y-%m-%d')}). "
        f"The current time is {now.strftime('%I:%M %p')} Central Time. "
        f"Use this to interpret relative dates like 'this week', 'last weekend', 'yesterday', etc."
    )

    # Build the system instruction with knowledge file listing and memories
    system_instruction = (
        SYSTEM_PROMPT
        + "\n\n" + date_context
        + "\n\n" + get_knowledge_context()
        + "\n\n" + get_memories_context()
    )

    import time as _time

    # Skip clarification if this is a follow-up message (conversation already has context)
    is_followup = bool(conversation_history)

    if not is_followup:
        # Run clarification and plan in parallel for first messages
        if on_progress:
            await on_progress("Reviewing request...")

        t0 = _time.monotonic()
        clarification_task = asyncio.create_task(
            check_clarification(client, user_message, system_instruction)
        )
        plan_task = asyncio.create_task(
            generate_plan(client, user_message, system_instruction)
        )

        clarification = await clarification_task
        logger.info(f"Clarification check: {_time.monotonic() - t0:.1f}s")

        _check_cancelled()

        if clarification:
            plan_task.cancel()
            clarification_history = list(conversation_history or [])
            clarification_history.append(
                types.Content(role="user", parts=[types.Part(text=user_message)])
            )
            clarification_history.append(
                types.Content(role="model", parts=[types.Part(text=clarification.question)])
            )
            return AgentResponse(
                message=clarification.question,
                clarification=clarification,
            ), clarification_history

        plan = await plan_task
        logger.info(f"Plan generation: {_time.monotonic() - t0:.1f}s (parallel)")

        if on_progress and plan:
            await on_progress(f"plan:{plan}")
    else:
        # Follow-up: skip clarification, just generate a quick plan
        if on_progress:
            await on_progress("Planning...")
        t0 = _time.monotonic()
        plan = await generate_plan(client, user_message, system_instruction)
        logger.info(f"Plan generation: {_time.monotonic() - t0:.1f}s")
        if on_progress and plan:
            await on_progress(f"plan:{plan}")

    _check_cancelled()

    # Build the conversation contents
    history = list(conversation_history or [])
    history.append(types.Content(role="user", parts=[types.Part(text=user_message)]))

    tool_calls_made: list[str] = []
    last_data: list[dict] | None = None
    charts: list[ChartSpec] = []
    hierarchy_tables: list[HierarchyTableSpec] = []
    steps: list[StepLog] = []
    step_counter = 0

    for round_num in range(MAX_TOOL_ROUNDS):
        _check_cancelled()

        if on_progress:
            if round_num == 0:
                await on_progress("Thinking...")
            else:
                await on_progress("Analyzing results...")

        # Run the blocking Gemini call in a thread so the event loop stays free
        # for SSE progress streaming
        t_gemini = _time.monotonic()
        response = await asyncio.to_thread(
            client.models.generate_content,
            model=agent_model,
            contents=history,
            config=types.GenerateContentConfig(
                system_instruction=system_instruction,
                tools=[TOOL_DECLARATIONS],
                temperature=0.1,
            ),
        )

        logger.info(f"Gemini round {round_num + 1}: {_time.monotonic() - t_gemini:.1f}s")

        candidate = response.candidates[0]
        parts = candidate.content.parts

        # Capture any reasoning text the model emitted in this round
        reasoning_texts = [p.text for p in parts if p.text]
        reasoning = "\n".join(reasoning_texts).strip() if reasoning_texts else None

        # Check if the model wants to call functions
        function_calls = [p for p in parts if p.function_call is not None]

        if not function_calls:
            # Model is done — log the final analysis/response step
            if on_progress and steps:
                await on_progress("Preparing response...")

            history.append(candidate.content)
            text = "".join(p.text for p in parts if p.text)
            text = _strip_markdown_tables(text)

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
                hierarchy_tables=hierarchy_tables,
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

            if on_progress:
                status = TOOL_STATUS_MESSAGES.get(tool_name, f"Running {tool_name}...")
                await on_progress(status)

            _check_cancelled()

            t_tool = _time.monotonic()
            result_str = await asyncio.to_thread(
                _execute_function_call, tool_name, tool_args
            )
            logger.info(f"Tool {tool_name}: {_time.monotonic() - t_tool:.1f}s")

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

            # Build the step description from the tool call args
            tool_description = _describe_tool_call(tool_name, tool_args)

            steps.append(StepLog(
                step=step_counter,
                description=f"{step_label}: {tool_description}",
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

            if tool_name == "create_hierarchy_table":
                try:
                    parsed = json.loads(result_str)
                    if "hierarchy_table" in parsed:
                        h = parsed["hierarchy_table"]
                        hierarchy_tables.append(HierarchyTableSpec(
                            hierarchy_keys=h["hierarchy_keys"],
                            value_keys=h["value_keys"],
                            data=h["data"],
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
        hierarchy_tables=hierarchy_tables,
        steps=steps,
        tool_calls_made=tool_calls_made,
    ), history


async def run_autonomous(prompt: str) -> AgentResponse:
    """Run the agent with no prior history — used for scheduled/autonomous tasks."""
    response, _ = await run_agent(prompt, conversation_history=None)
    return response
