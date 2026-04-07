import { useState } from "react";
import type { Message } from "../types/api";
import {
  humanizeColumn,
  detectFormat,
  detectFormatFromMetric,
  detectMetricColumn,
  detectScale,
  formatValue,
  type FormatHint,
  type Scale,
} from "../utils/format";

interface DataTableProps {
  data: Record<string, unknown>[];
  scaleOverrides?: Record<string, Scale>;
  message?: Message;  // parent message for context (description, SQL queries)
}

const TOTAL_LABELS = ["total", "all", "grand total", "sum", "overall"];

function isTotalsRow(
  row: Record<string, unknown>,
  columns: string[]
): boolean {
  // Check if the first string column contains a totals-like label
  for (const col of columns) {
    const val = row[col];
    if (typeof val === "string") {
      return TOTAL_LABELS.includes(val.toLowerCase().trim());
    }
  }
  return false;
}

function toCsvValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function downloadCsv(columns: string[], data: Record<string, unknown>[]) {
  const header = columns.map((c) => toCsvValue(humanizeColumn(c))).join(",");
  const rows = data.map((row) =>
    columns.map((col) => toCsvValue(row[col])).join(",")
  );
  const csv = [header, ...rows].join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `data_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function formatHintToSheetFormat(hint: FormatHint): string | null {
  switch (hint) {
    case "currency": return '"$"#,##0';
    case "percent": return "0.0%";
    case "percent_change": return '+0.0%;-0.0%';
    case "bps_change": return '+#,##0" bps";-#,##0" bps"';
    case "number": return "#,##0";
    default: return null;
  }
}

async function openInGoogleSheets(
  columns: string[],
  columnFormats: { col: string; hint: FormatHint }[],
  data: Record<string, unknown>[],
  message?: Message,
): Promise<string> {
  const headers = columns.map(humanizeColumn);
  const rows = data.map((row) =>
    columns.map((col) => {
      const v = row[col];
      if (v === null || v === undefined) return "";
      return v;
    })
  );

  // Build column format map (0-based index → Sheets format pattern)
  const col_formats: Record<number, string> = {};
  columnFormats.forEach(({ col, hint }, _) => {
    const idx = columns.indexOf(col);
    const fmt = formatHintToSheetFormat(hint);
    if (idx >= 0 && fmt) {
      col_formats[idx] = fmt;
    }
  });

  // Build notes content
  const notes: string[] = [];
  if (message?.content) {
    notes.push("Description:");
    notes.push(message.content);
    notes.push("");
  }
  // Extract SQL queries from steps
  if (message?.steps) {
    const queries = message.steps
      .filter((s) => s.tool === "run_query" && s.tool_input?.sql)
      .map((s) => String(s.tool_input!.sql));
    if (queries.length > 0) {
      notes.push("SQL Queries:");
      queries.forEach((sql, i) => {
        if (queries.length > 1) notes.push(`--- Query ${i + 1} ---`);
        notes.push(sql);
        notes.push("");
      });
    }
  }
  if (message?.timestamp) {
    notes.push(`Generated: ${new Date(message.timestamp).toLocaleString()}`);
  }
  if (message?.durationMs) {
    notes.push(`Run time: ${(message.durationMs / 1000).toFixed(1)}s`);
  }

  const res = await fetch("/api/export/gsheet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: `Data Export ${new Date().toISOString().slice(0, 10)}`,
      headers,
      rows,
      col_formats,
      notes: notes.length > 0 ? notes : undefined,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(err);
  }

  const result = await res.json();
  return result.url;
}

const buttonStyle: React.CSSProperties = {
  padding: "3px 10px",
  borderRadius: 4,
  border: "1px solid #ccc",
  background: "#fff",
  fontSize: 12,
  color: "#555",
  cursor: "pointer",
};

export function DataTable({ data, scaleOverrides, message }: DataTableProps) {
  const [sheetsLoading, setSheetsLoading] = useState(false);
  const [sheetsError, setSheetsError] = useState<string | null>(null);

  if (data.length === 0) return null;

  const columns = Object.keys(data[0]);

  // Detect if this is a pivoted metric table
  const metricCol = detectMetricColumn(columns, data);

  const columnMeta = columns.map((col) => {
    const hint = detectFormat(col);
    const scale =
      scaleOverrides && col in scaleOverrides
        ? scaleOverrides[col]
        : hint === "currency" || hint === "number"
          ? detectScale(
              data
                .map((row) => row[col])
                .filter((v): v is number => typeof v === "number")
            )
          : undefined;
    return { col, hint, scale };
  });

  const handleGoogleSheets = async () => {
    setSheetsLoading(true);
    setSheetsError(null);
    try {
      const url = await openInGoogleSheets(columns, columnMeta, data, message);
      window.open(url, "_blank");
    } catch (e) {
      setSheetsError(e instanceof Error ? e.message : "Failed to create sheet");
    } finally {
      setSheetsLoading(false);
    }
  };

  return (
    <div style={{ marginTop: 8 }}>
      {/* Export buttons */}
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          marginBottom: 6,
        }}
      >
        <button
          style={buttonStyle}
          onClick={() => downloadCsv(columns, data)}
        >
          Download CSV
        </button>
        <button
          style={{
            ...buttonStyle,
            opacity: sheetsLoading ? 0.6 : 1,
            cursor: sheetsLoading ? "default" : "pointer",
          }}
          onClick={handleGoogleSheets}
          disabled={sheetsLoading}
        >
          {sheetsLoading ? "Creating..." : "Open in Google Sheets"}
        </button>
        {sheetsError && (
          <span style={{ fontSize: 11, color: "#c62828" }}>{sheetsError}</span>
        )}
      </div>

      {/* Table */}
      <div style={{ overflowX: "auto" }}>
        <table
          style={{
            borderCollapse: "collapse",
            fontSize: 13,
            width: "100%",
          }}
        >
          <thead>
            <tr>
              {columnMeta.map(({ col, scale }) => (
                <th
                  key={col}
                  style={{
                    borderBottom: "2px solid #ddd",
                    padding: "6px 10px",
                    textAlign: "left",
                    whiteSpace: "nowrap",
                    background: "#f5f5f5",
                  }}
                >
                  {humanizeColumn(col)}
                  {!metricCol && scale && scale.suffix ? ` (${scale.suffix})` : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.slice(0, 100).map((row, i) => {
              const isTotalRow = i === 0 && isTotalsRow(row, columns);
              return (
                <tr
                  key={i}
                  style={{
                    background: isTotalRow
                      ? "#e8eaf6"
                      : i % 2 === 0
                        ? "#fff"
                        : "#fafafa",
                    fontWeight: isTotalRow ? 600 : 400,
                    borderBottom: isTotalRow ? "2px solid #9fa8da" : undefined,
                  }}
                >
                  {columnMeta.map(({ col, hint, scale }) => {
                    // For pivoted metric tables, derive format from the metric label
                    const cellHint =
                      metricCol && col !== metricCol
                        ? detectFormatFromMetric(
                            String(row[metricCol] ?? ""),
                            col
                          )
                        : hint;
                    // Don't apply scale for pivoted tables (mixed types in same column)
                    const cellScale = metricCol ? undefined : scale;
                    return (
                      <td
                        key={col}
                        style={{
                          borderBottom: isTotalRow
                            ? "2px solid #9fa8da"
                            : "1px solid #eee",
                          padding: "4px 10px",
                          whiteSpace: "nowrap",
                          textAlign: typeof row[col] === "number" ? "right" : "left",
                        }}
                      >
                        {formatValue(row[col], cellHint, cellScale)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
        {data.length > 100 && (
          <p style={{ color: "#888", fontSize: 12, marginTop: 4 }}>
            Showing first 100 of {data.length} rows
          </p>
        )}
      </div>
    </div>
  );
}
