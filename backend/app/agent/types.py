from dataclasses import dataclass, field
from typing import Any


@dataclass
class ToolCall:
    name: str
    args: dict[str, Any]


@dataclass
class ToolResult:
    name: str
    result: Any
    error: str | None = None


@dataclass
class ChartSpec:
    type: str  # "line", "bar", "pie"
    title: str
    x_key: str
    y_keys: list[str]
    data: list[dict[str, Any]]
    x_label: str = ""
    y_label: str = ""


@dataclass
class StepLog:
    """One step in the agent's reasoning/execution trace."""
    step: int
    description: str  # what the agent is doing (e.g. "Research", "Query", "Analyze")
    tool: str | None = None  # tool name if a tool was called
    tool_input: dict[str, Any] | None = None  # arguments passed to the tool
    tool_output_summary: str | None = None  # truncated result summary
    reasoning: str | None = None  # any text the model emitted alongside tool calls


@dataclass
class AgentMessage:
    role: str  # "user", "assistant", "tool"
    content: str
    tool_calls: list[ToolCall] = field(default_factory=list)
    tool_results: list[ToolResult] = field(default_factory=list)
    data: dict[str, Any] | None = None  # structured data (tables, etc.)


@dataclass
class Clarification:
    """A question the agent needs answered before proceeding."""
    question: str
    response_type: str = "free_text"  # "free_text" or "multiple_choice"
    options: list[str] = field(default_factory=list)


@dataclass
class HierarchyTableSpec:
    hierarchy_keys: list[str]
    value_keys: list[str]
    data: list[dict[str, Any]]


@dataclass
class AgentResponse:
    message: str
    data: list[dict[str, Any]] | None = None  # query result rows
    charts: list[ChartSpec] = field(default_factory=list)
    hierarchy_tables: list[HierarchyTableSpec] = field(default_factory=list)
    steps: list[StepLog] = field(default_factory=list)
    tool_calls_made: list[str] = field(default_factory=list)
    clarification: Clarification | None = None  # set when agent needs user input
