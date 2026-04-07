"""BigQuery tools exposed to the Gemini agent via function calling."""

import contextvars
from dataclasses import dataclass, field

from google import genai
from google.cloud import bigquery

from app.config import settings

_bq_client: bigquery.Client | None = None


@dataclass
class RequestContext:
    """Per-request state for query caching and last result tracking."""
    query_cache: dict[str, dict] = field(default_factory=dict)
    last_query_result: dict | None = None


# Each async task gets its own context automatically
_request_ctx: contextvars.ContextVar[RequestContext] = contextvars.ContextVar(
    "_request_ctx", default=RequestContext()
)


def init_request_context() -> None:
    """Initialize a fresh request context. Call at the start of each agent run."""
    _request_ctx.set(RequestContext())


def get_bq_client() -> bigquery.Client:
    global _bq_client
    if _bq_client is None:
        _bq_client = bigquery.Client(project=settings.google_cloud_project)
    return _bq_client


def get_last_query_result() -> dict | None:
    """Return the most recent query result for this request."""
    return _request_ctx.get().last_query_result


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------

def run_query(sql: str) -> dict:
    """Execute a read-only SQL query against BigQuery and return results."""
    ctx = _request_ctx.get()
    normalized = sql.strip().rstrip(";").upper()
    if not normalized.startswith("SELECT") and not normalized.startswith("WITH"):
        return {"error": "Only SELECT queries are allowed."}

    # Return cached result for identical SQL
    cache_key = sql.strip()
    if cache_key in ctx.query_cache:
        ctx.last_query_result = ctx.query_cache[cache_key]
        return ctx.last_query_result

    client = get_bq_client()

    # Dry run first to check cost
    dry_job_config = bigquery.QueryJobConfig(
        dry_run=True,
        use_query_cache=False,
    )
    try:
        dry_job = client.query(sql, job_config=dry_job_config)
        estimated_bytes = dry_job.total_bytes_processed or 0
        if estimated_bytes > settings.bq_max_bytes_billed:
            gb = estimated_bytes / 1_073_741_824
            return {
                "error": f"Query would scan {gb:.1f} GB, exceeding the {settings.bq_max_bytes_billed / 1_073_741_824:.0f} GB limit. Add filters to reduce scope."
            }
    except Exception as e:
        return {"error": f"Query validation failed: {str(e)}"}

    # Execute
    job_config = bigquery.QueryJobConfig(
        maximum_bytes_billed=settings.bq_max_bytes_billed,
    )
    try:
        result = client.query(sql, job_config=job_config).result()
        rows = [dict(row) for row in result]
        if len(rows) > settings.bq_max_rows:
            rows = rows[: settings.bq_max_rows]
            res = {
                "rows": rows,
                "truncated": True,
                "total_rows": result.total_rows,
                "message": f"Results truncated to {settings.bq_max_rows} rows.",
            }
        else:
            res = {"rows": rows, "total_rows": len(rows)}
        ctx.query_cache[cache_key] = res
        ctx.last_query_result = res
        return res
    except Exception as e:
        return {"error": f"Query execution failed: {str(e)}"}


def get_table_schema(dataset: str, table: str) -> dict:
    """Get the schema (column names and types) for a BigQuery table or view."""
    client = get_bq_client()
    table_ref = f"{settings.google_cloud_project}.{dataset}.{table}"
    try:
        t = client.get_table(table_ref)
        columns = [
            {"name": f.name, "type": f.field_type, "description": f.description or ""}
            for f in t.schema
        ]
        return {
            "table": table_ref,
            "columns": columns,
            "row_count": t.num_rows,
            "description": t.description or "",
        }
    except Exception as e:
        return {"error": str(e)}


def list_tables(dataset: str) -> dict:
    """List all tables in a BigQuery dataset."""
    client = get_bq_client()
    try:
        tables = client.list_tables(f"{settings.google_cloud_project}.{dataset}")
        return {
            "dataset": dataset,
            "tables": [
                {"name": t.table_id, "type": t.table_type} for t in tables
            ],
        }
    except Exception as e:
        return {"error": str(e)}


def get_current_date() -> dict:
    """Get the current date in Central Time (the business timezone)."""
    from datetime import datetime
    import zoneinfo

    tz = zoneinfo.ZoneInfo("America/Chicago")
    now = datetime.now(tz)
    return {
        "current_date": now.strftime("%Y-%m-%d"),
        "current_time": now.strftime("%H:%M:%S"),
        "timezone": "America/Chicago",
    }


def save_memory(memory: str) -> dict:
    """Save a piece of information to the agent's persistent memory."""
    from app.agent.knowledge import save_memory as _save
    return _save(memory)


def read_knowledge_file(filename: str) -> dict:
    """Load the full content of a specific knowledge file by name."""
    from app.agent.knowledge import get_file_content, get_filenames

    content = get_file_content(filename)
    if content is None:
        return {
            "error": f"File '{filename}' not found. Available files: {get_filenames()}"
        }

    return {"filename": filename, "content": content}


def add_block(
    block_type: str,
    # text block
    content: str | None = None,
    # chart block
    chart_type: str | None = None,
    chart_title: str | None = None,
    x_key: str | None = None,
    y_keys: list[str] | None = None,
    x_label: str | None = None,
    y_label: str | None = None,
    # table / hierarchy_table block
    columns: list[dict] | None = None,
    caption: str | None = None,
    # hierarchy_table block
    hierarchy_keys: list[str] | None = None,
    # shared: data source
    data: list[dict] | None = None,
    use_last_query: bool = False,
    max_rows: int | None = None,
) -> dict:
    """Add a content block to the response. Builds the narrative piece by piece."""

    # Resolve data for chart/table types
    if block_type in ("chart", "table", "hierarchy_table"):
        if use_last_query or not data:
            last = get_last_query_result()
            if last and "rows" in last:
                data = last["rows"]
            elif not data:
                return {"error": "No data provided and no previous query results available."}
        if not data:
            return {"error": "No data provided."}
        if max_rows and len(data) > max_rows:
            data = data[:max_rows]

    if block_type == "text":
        if not content:
            return {"error": "content is required for text blocks."}
        return {"block": {"type": "text", "content": content}}

    if block_type == "chart":
        valid_chart_types = (
            "line", "bar", "stacked_bar", "horizontal_bar", "area", "stacked_area",
            "pie", "scatter", "combo", "heatmap", "waterfall", "funnel", "treemap", "radar",
        )
        if chart_type not in valid_chart_types:
            return {"error": f"Invalid chart_type. Must be one of: {valid_chart_types}"}
        if not x_key or not y_keys:
            return {"error": "x_key and y_keys are required for chart blocks."}
        sample = data[0]
        missing = [k for k in [x_key] + y_keys if k not in sample]
        if missing:
            return {"error": f"Keys not found in data: {missing}. Available: {list(sample.keys())}"}
        return {
            "block": {
                "type": "chart",
                "chart_type": chart_type,
                "chart_title": chart_title or "",
                "x_key": x_key,
                "y_keys": y_keys,
                "x_label": x_label or "",
                "y_label": y_label or "",
                "data": data,
            }
        }

    if block_type == "table":
        if not columns:
            return {"error": "columns is required for table blocks."}
        sample = data[0]
        col_keys = [c["key"] for c in columns]
        missing = [k for k in col_keys if k not in sample]
        if missing:
            return {"error": f"Keys not found in data: {missing}. Available: {list(sample.keys())}"}
        # Filter data to only include specified columns
        filtered = [{k: row.get(k) for k in col_keys} for row in data]
        return {
            "block": {
                "type": "table",
                "columns": columns,
                "rows": filtered,
                "caption": caption,
            }
        }

    if block_type == "hierarchy_table":
        if not hierarchy_keys or not columns:
            return {"error": "hierarchy_keys and columns are required for hierarchy_table blocks."}
        return {
            "block": {
                "type": "hierarchy_table",
                "hierarchy_keys": hierarchy_keys,
                "columns": columns,
                "data": data,
            }
        }

    return {"error": f"Unknown block_type: {block_type}"}


# ---------------------------------------------------------------------------
# Tool dispatch map
# ---------------------------------------------------------------------------

TOOL_DISPATCH = {
    "run_query": run_query,
    "get_table_schema": get_table_schema,
    "list_tables": list_tables,
    "get_current_date": get_current_date,
    "save_memory": save_memory,
    "read_knowledge_file": read_knowledge_file,
    "add_block": add_block,
}


# ---------------------------------------------------------------------------
# Gemini function declarations
# ---------------------------------------------------------------------------

TOOL_DECLARATIONS = genai.types.Tool(
    function_declarations=[
        genai.types.FunctionDeclaration(
            name="read_knowledge_file",
            description="Load the full content of a knowledge documentation file.",
            parameters=genai.types.Schema(
                type="OBJECT",
                properties={
                    "filename": genai.types.Schema(
                        type="STRING",
                        description="Exact filename to load (e.g., 'datamodel.md').",
                    ),
                },
                required=["filename"],
            ),
        ),
        genai.types.FunctionDeclaration(
            name="save_memory",
            description="Save important information to persistent memory.",
            parameters=genai.types.Schema(
                type="OBJECT",
                properties={
                    "memory": genai.types.Schema(
                        type="STRING",
                        description="A concise, self-contained statement of what to remember.",
                    ),
                },
                required=["memory"],
            ),
        ),
        genai.types.FunctionDeclaration(
            name="run_query",
            description="Execute a read-only SQL query against BigQuery. Returns rows as JSON.",
            parameters=genai.types.Schema(
                type="OBJECT",
                properties={
                    "sql": genai.types.Schema(
                        type="STRING",
                        description="The SQL SELECT query to execute.",
                    ),
                },
                required=["sql"],
            ),
        ),
        genai.types.FunctionDeclaration(
            name="get_table_schema",
            description="Get column names and types for a BigQuery table or view.",
            parameters=genai.types.Schema(
                type="OBJECT",
                properties={
                    "dataset": genai.types.Schema(type="STRING", description="Dataset name."),
                    "table": genai.types.Schema(type="STRING", description="Table name."),
                },
                required=["dataset", "table"],
            ),
        ),
        genai.types.FunctionDeclaration(
            name="list_tables",
            description="List all tables and views in a BigQuery dataset.",
            parameters=genai.types.Schema(
                type="OBJECT",
                properties={
                    "dataset": genai.types.Schema(type="STRING", description="Dataset name."),
                },
                required=["dataset"],
            ),
        ),
        genai.types.FunctionDeclaration(
            name="get_current_date",
            description="Get the current date and time in Central Time.",
            parameters=genai.types.Schema(type="OBJECT", properties={}),
        ),
        genai.types.FunctionDeclaration(
            name="add_block",
            description=(
                "Add a content block to build the response. Call this multiple times to compose "
                "a narrative with text, charts, tables, and hierarchy tables in any order. "
                "Each call appends one block to the response."
            ),
            parameters=genai.types.Schema(
                type="OBJECT",
                properties={
                    "block_type": genai.types.Schema(
                        type="STRING",
                        enum=["text", "chart", "table", "hierarchy_table"],
                        description=(
                            "'text' — markdown text (headings, bullets, bold, etc.). "
                            "'chart' — a visualization. "
                            "'table' — a formatted data table with explicit column definitions. "
                            "'hierarchy_table' — a collapsible multi-level grouped table."
                        ),
                    ),
                    # text
                    "content": genai.types.Schema(
                        type="STRING",
                        description="Markdown text content. Required for block_type='text'.",
                    ),
                    # chart
                    "chart_type": genai.types.Schema(
                        type="STRING",
                        enum=[
                            "line", "bar", "stacked_bar", "horizontal_bar", "area", "stacked_area",
                            "pie", "scatter", "combo", "heatmap", "waterfall", "funnel", "treemap", "radar",
                        ],
                        description="Chart type. Required for block_type='chart'.",
                    ),
                    "chart_title": genai.types.Schema(type="STRING", description="Chart title."),
                    "x_key": genai.types.Schema(type="STRING", description="X-axis data key."),
                    "y_keys": genai.types.Schema(
                        type="ARRAY", items=genai.types.Schema(type="STRING"),
                        description="Y-axis data keys. For combo charts, first key = bars, rest = lines.",
                    ),
                    "x_label": genai.types.Schema(type="STRING", description="X-axis label."),
                    "y_label": genai.types.Schema(type="STRING", description="Y-axis label."),
                    # table columns
                    "columns": genai.types.Schema(
                        type="ARRAY",
                        items=genai.types.Schema(
                            type="OBJECT",
                            properties={
                                "key": genai.types.Schema(type="STRING", description="Column key in the data."),
                                "label": genai.types.Schema(type="STRING", description="Display label."),
                                "format": genai.types.Schema(
                                    type="STRING",
                                    enum=["text", "id", "currency", "number", "percent", "percent_change", "bps_change"],
                                    description="How to format values in this column.",
                                ),
                            },
                            required=["key", "label", "format"],
                        ),
                        description="Column definitions for table or hierarchy_table blocks.",
                    ),
                    "caption": genai.types.Schema(type="STRING", description="Table caption/subtitle."),
                    # hierarchy
                    "hierarchy_keys": genai.types.Schema(
                        type="ARRAY", items=genai.types.Schema(type="STRING"),
                        description="Hierarchy column keys from broadest to most specific. For hierarchy_table only.",
                    ),
                    # data source
                    "use_last_query": genai.types.Schema(
                        type="BOOLEAN",
                        description="Use data from the most recent run_query result. Preferred over passing data.",
                    ),
                    "data": genai.types.Schema(
                        type="ARRAY",
                        items=genai.types.Schema(type="OBJECT", properties={}),
                        description="Data array. Only needed if use_last_query is false.",
                    ),
                    "max_rows": genai.types.Schema(
                        type="INTEGER",
                        description="Limit the number of rows shown. Useful for top-N tables.",
                    ),
                },
                required=["block_type"],
            ),
        ),
    ]
)
