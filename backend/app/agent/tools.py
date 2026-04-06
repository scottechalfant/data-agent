"""BigQuery tools exposed to the Gemini agent via function calling."""

from google import genai
from google.cloud import bigquery

from app.config import settings

_bq_client: bigquery.Client | None = None


def get_bq_client() -> bigquery.Client:
    global _bq_client
    if _bq_client is None:
        _bq_client = bigquery.Client(project=settings.google_cloud_project)
    return _bq_client


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------

def run_query(sql: str) -> dict:
    """Execute a read-only SQL query against BigQuery and return results."""
    normalized = sql.strip().rstrip(";").upper()
    if not normalized.startswith("SELECT") and not normalized.startswith("WITH"):
        return {"error": "Only SELECT queries are allowed."}

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
            return {
                "rows": rows,
                "truncated": True,
                "total_rows": result.total_rows,
                "message": f"Results truncated to {settings.bq_max_rows} rows.",
            }
        return {"rows": rows, "total_rows": len(rows)}
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


def create_chart(
    chart_type: str,
    title: str,
    x_key: str,
    y_keys: list[str],
    data: list[dict],
    x_label: str = "",
    y_label: str = "",
) -> dict:
    """Create a chart specification to be rendered in the UI."""
    valid_types = ("line", "bar", "pie")
    if chart_type not in valid_types:
        return {"error": f"Invalid chart_type '{chart_type}'. Must be one of: {valid_types}"}

    if not data:
        return {"error": "No data provided for chart."}

    # Validate keys exist in data
    sample = data[0]
    missing = [k for k in [x_key] + y_keys if k not in sample]
    if missing:
        return {
            "error": f"Keys not found in data: {missing}. Available keys: {list(sample.keys())}"
        }

    return {
        "chart": {
            "type": chart_type,
            "title": title,
            "x_key": x_key,
            "y_keys": y_keys,
            "x_label": x_label,
            "y_label": y_label,
            "data": data,
        }
    }


# ---------------------------------------------------------------------------
# Tool dispatch map — agent core uses this to execute function calls
# ---------------------------------------------------------------------------

TOOL_DISPATCH = {
    "run_query": run_query,
    "get_table_schema": get_table_schema,
    "list_tables": list_tables,
    "get_current_date": get_current_date,
    "save_memory": save_memory,
    "read_knowledge_file": read_knowledge_file,
    "create_chart": create_chart,
}


# ---------------------------------------------------------------------------
# Gemini function declarations — describes the tools to the model
# ---------------------------------------------------------------------------

TOOL_DECLARATIONS = genai.types.Tool(
    function_declarations=[
        genai.types.FunctionDeclaration(
            name="read_knowledge_file",
            description="Load the full content of a knowledge documentation file. The system prompt lists available files with summaries — use those summaries to decide which file(s) to load before writing queries.",
            parameters=genai.types.Schema(
                type="OBJECT",
                properties={
                    "filename": genai.types.Schema(
                        type="STRING",
                        description="Exact filename to load (e.g., 'datamodel.md'). See the Knowledge Base section in your instructions for available files.",
                    ),
                },
                required=["filename"],
            ),
        ),
        genai.types.FunctionDeclaration(
            name="save_memory",
            description="Save important information to persistent memory. Use this when the user says 'remember this' or similar, or when you discover something worth remembering — business rules, data quirks, user preferences, corrections to your assumptions, or insights that would help in future conversations.",
            parameters=genai.types.Schema(
                type="OBJECT",
                properties={
                    "memory": genai.types.Schema(
                        type="STRING",
                        description="A concise, self-contained statement of what to remember. Include enough context that it's useful without the original conversation.",
                    ),
                },
                required=["memory"],
            ),
        ),
        genai.types.FunctionDeclaration(
            name="run_query",
            description="Execute a read-only SQL query against BigQuery. Returns rows as JSON. Use this in Step 2 after reviewing documentation. Always include WHERE clauses to limit data scanned.",
            parameters=genai.types.Schema(
                type="OBJECT",
                properties={
                    "sql": genai.types.Schema(
                        type="STRING",
                        description="The SQL SELECT query to execute against BigQuery.",
                    ),
                },
                required=["sql"],
            ),
        ),
        genai.types.FunctionDeclaration(
            name="get_table_schema",
            description="Get the column names, types, and descriptions for a BigQuery table or view. Use this in Step 1 if the knowledge base doesn't have enough detail about a table's structure.",
            parameters=genai.types.Schema(
                type="OBJECT",
                properties={
                    "dataset": genai.types.Schema(
                        type="STRING",
                        description="The BigQuery dataset name (e.g., 'analytics', 'inventory', 'replen').",
                    ),
                    "table": genai.types.Schema(
                        type="STRING",
                        description="The table or view name within the dataset.",
                    ),
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
                    "dataset": genai.types.Schema(
                        type="STRING",
                        description="The BigQuery dataset name to list tables from.",
                    ),
                },
                required=["dataset"],
            ),
        ),
        genai.types.FunctionDeclaration(
            name="get_current_date",
            description="Get the current date and time in Central Time (the business timezone). Use this to build date filters for queries.",
            parameters=genai.types.Schema(
                type="OBJECT",
                properties={},
            ),
        ),
        genai.types.FunctionDeclaration(
            name="create_chart",
            description="Create a chart to visualize data for the user. Call this in Step 4 when a visualization would help. The chart is rendered in the UI alongside your text response.",
            parameters=genai.types.Schema(
                type="OBJECT",
                properties={
                    "chart_type": genai.types.Schema(
                        type="STRING",
                        description="Chart type: 'line' (trends over time), 'bar' (category comparisons), or 'pie' (part-of-whole).",
                        enum=["line", "bar", "pie"],
                    ),
                    "title": genai.types.Schema(
                        type="STRING",
                        description="Chart title displayed above the visualization.",
                    ),
                    "x_key": genai.types.Schema(
                        type="STRING",
                        description="Key in the data objects to use for the x-axis (or pie labels).",
                    ),
                    "y_keys": genai.types.Schema(
                        type="ARRAY",
                        items=genai.types.Schema(type="STRING"),
                        description="Keys in the data objects to use for y-axis values (or pie values). Multiple keys create multiple series on line/bar charts.",
                    ),
                    "data": genai.types.Schema(
                        type="ARRAY",
                        items=genai.types.Schema(
                            type="OBJECT",
                            properties={},
                        ),
                        description="Array of data objects to chart. Each object must contain the x_key and all y_keys.",
                    ),
                    "x_label": genai.types.Schema(
                        type="STRING",
                        description="Label for the x-axis.",
                    ),
                    "y_label": genai.types.Schema(
                        type="STRING",
                        description="Label for the y-axis.",
                    ),
                },
                required=["chart_type", "title", "x_key", "y_keys", "data"],
            ),
        ),
    ]
)
