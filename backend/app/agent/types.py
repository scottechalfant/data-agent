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
class ColumnFormat:
    """Format specification for a single table column."""
    key: str          # column name in the data
    label: str        # display label (e.g. "Total Sales")
    format: str       # "text", "currency", "number", "percent", "percent_change", "bps_change", "id"
    align: str = "right"  # "left" or "right"


@dataclass
class ContentBlock:
    """A single renderable block in the agent's response."""
    type: str  # "text", "chart", "table", "hierarchy_table"

    # For type="text"
    content: str | None = None

    # For type="chart"
    chart_type: str | None = None
    chart_title: str | None = None
    x_key: str | None = None
    y_keys: list[str] | None = None
    x_label: str | None = None
    y_label: str | None = None
    chart_data: list[dict[str, Any]] | None = None

    # For type="table"
    columns: list[ColumnFormat] | None = None
    rows: list[dict[str, Any]] | None = None
    caption: str | None = None

    # For type="hierarchy_table"
    hierarchy_keys: list[str] | None = None
    value_columns: list[ColumnFormat] | None = None
    hierarchy_data: list[dict[str, Any]] | None = None


@dataclass
class StepLog:
    """One step in the agent's reasoning/execution trace."""
    step: int
    description: str
    tool: str | None = None
    tool_input: dict[str, Any] | None = None
    tool_output_summary: str | None = None
    reasoning: str | None = None


@dataclass
class Clarification:
    """A question the agent needs answered before proceeding."""
    question: str
    response_type: str = "free_text"
    options: list[str] = field(default_factory=list)


@dataclass
class TokenUsage:
    input_tokens: int = 0
    output_tokens: int = 0


@dataclass
class AgentResponse:
    message: str  # kept for backwards compat / clarifications
    blocks: list[ContentBlock] = field(default_factory=list)
    steps: list[StepLog] = field(default_factory=list)
    tool_calls_made: list[str] = field(default_factory=list)
    clarification: Clarification | None = None
    token_usage: TokenUsage = field(default_factory=TokenUsage)
