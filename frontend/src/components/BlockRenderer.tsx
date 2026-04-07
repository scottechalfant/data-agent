import Markdown from "react-markdown";
import type { ContentBlock, ColumnDef, Message } from "../types/api";
import { Chart } from "./Chart";
import { HierarchyTable } from "./HierarchyTable";
import { formatValue, type FormatHint } from "../utils/format";
import { useState } from "react";

interface BlockRendererProps {
  blocks: ContentBlock[];
  message?: Message;
}

const TOTAL_LABELS = ["total", "all", "grand total", "sum", "overall"];

function isTotalsRow(row: Record<string, unknown>, columns: ColumnDef[]): boolean {
  for (const col of columns) {
    if (col.format === "text" || col.format === "id") {
      const val = row[col.key];
      if (typeof val === "string" && TOTAL_LABELS.includes(val.toLowerCase().trim())) {
        return true;
      }
    }
  }
  return false;
}

function colFormatToHint(fmt: string): FormatHint {
  const map: Record<string, FormatHint> = {
    text: "text",
    id: "text",
    currency: "currency",
    number: "number",
    percent: "percent",
    percent_change: "percent_change",
    bps_change: "bps_change",
  };
  return map[fmt] || "number";
}

function downloadCsv(columns: ColumnDef[], rows: Record<string, unknown>[]) {
  const toCsvValue = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map((c) => toCsvValue(c.label)).join(",");
  const body = rows.map((row) =>
    columns.map((c) => toCsvValue(row[c.key])).join(",")
  );
  const csv = [header, ...body].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `data_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

async function openInGoogleSheets(
  columns: ColumnDef[],
  rows: Record<string, unknown>[],
  message?: Message,
) {
  const API_BASE = import.meta.env.DEV ? "http://localhost:8080/api" : "/api";
  const fmtMap: Record<string, string> = {
    currency: '"$"#,##0',
    number: "#,##0",
    percent: "0.0%",
    percent_change: '+0.0%;-0.0%',
    bps_change: '+#,##0" bps";-#,##0" bps"',
  };

  const col_formats: Record<number, string> = {};
  columns.forEach((c, i) => {
    const fmt = fmtMap[c.format];
    if (fmt) col_formats[i] = fmt;
  });

  const notes: string[] = [];
  if (message?.content) {
    notes.push("Description:", message.content, "");
  }
  if (message?.steps) {
    const queries = message.steps
      .filter((s) => s.tool === "run_query" && s.tool_input?.sql)
      .map((s) => String(s.tool_input!.sql));
    if (queries.length > 0) {
      notes.push("SQL Queries:");
      queries.forEach((sql, i) => {
        if (queries.length > 1) notes.push(`--- Query ${i + 1} ---`);
        notes.push(sql, "");
      });
    }
  }

  const res = await fetch(`${API_BASE}/export/gsheet`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: `Data Export ${new Date().toISOString().slice(0, 10)}`,
      headers: columns.map((c) => c.label),
      rows: rows.map((row) => columns.map((c) => row[c.key] ?? "")),
      col_formats,
      notes: notes.length > 0 ? notes : undefined,
    }),
  });

  if (!res.ok) throw new Error(await res.text());
  const result = await res.json();
  window.open(result.url, "_blank");
}

function TextBlock({ content }: { content: string }) {
  return (
    <div style={{ fontSize: 13, lineHeight: 1.6 }}>
      <Markdown
        components={{
          p: ({ children }) => <p style={{ margin: "6px 0" }}>{children}</p>,
          ul: ({ children }) => <ul style={{ margin: "6px 0 12px", paddingLeft: 20 }}>{children}</ul>,
          ol: ({ children }) => <ol style={{ margin: "6px 0 12px", paddingLeft: 20 }}>{children}</ol>,
          li: ({ children }) => <li style={{ marginBottom: 4 }}>{children}</li>,
          h1: ({ children }) => <h1 style={{ fontSize: 16, fontWeight: 700, margin: "12px 0 6px" }}>{children}</h1>,
          h2: ({ children }) => <h2 style={{ fontSize: 15, fontWeight: 700, margin: "10px 0 6px" }}>{children}</h2>,
          h3: ({ children }) => <h3 style={{ fontSize: 14, fontWeight: 600, margin: "8px 0 4px" }}>{children}</h3>,
          table: ({ children }) => (
            <div style={{ overflowX: "auto", marginTop: 8 }}>
              <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th style={{ borderBottom: "2px solid #ddd", padding: "6px 10px", textAlign: "left", background: "#f5f5f5", fontWeight: 600 }}>
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td style={{ borderBottom: "1px solid #eee", padding: "4px 10px" }}>{children}</td>
          ),
          tr: ({ children }) => <tr style={{ background: "#fff" }}>{children}</tr>,
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}

type SortState = { key: string; dir: "asc" | "desc" } | null;

function sortRows(
  rows: Record<string, unknown>[],
  sort: SortState,
  columns: ColumnDef[],
): Record<string, unknown>[] {
  if (!sort) return rows;

  // Keep TOTAL row pinned at top
  const totalIdx = rows.findIndex((r, i) => i === 0 && isTotalsRow(r, columns));
  const totalRow = totalIdx === 0 ? rows[0] : null;
  const dataRows = totalRow ? rows.slice(1) : [...rows];

  dataRows.sort((a, b) => {
    const av = a[sort.key];
    const bv = b[sort.key];
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    if (typeof av === "number" && typeof bv === "number") {
      return sort.dir === "asc" ? av - bv : bv - av;
    }
    const as = String(av).toLowerCase();
    const bs = String(bv).toLowerCase();
    return sort.dir === "asc" ? as.localeCompare(bs) : bs.localeCompare(as);
  });

  return totalRow ? [totalRow, ...dataRows] : dataRows;
}

function SortIcon({ dir }: { dir: "asc" | "desc" | null }) {
  if (dir === "asc") return <span style={{ marginLeft: 4, fontSize: 10 }}>▲</span>;
  if (dir === "desc") return <span style={{ marginLeft: 4, fontSize: 10 }}>▼</span>;
  return <span style={{ marginLeft: 4, fontSize: 10, color: "#ccc" }}>⇅</span>;
}

function TableBlock({
  block,
  message,
}: {
  block: ContentBlock;
  message?: Message;
}) {
  const [sheetsLoading, setSheetsLoading] = useState(false);
  const [sort, setSort] = useState<SortState>(null);
  const columns = block.columns || [];
  const rawRows = block.rows || [];

  if (columns.length === 0 || rawRows.length === 0) return null;

  const rows = sortRows(rawRows, sort, columns);

  const handleSort = (key: string) => {
    setSort((prev) => {
      if (prev?.key === key) {
        if (prev.dir === "asc") return { key, dir: "desc" };
        if (prev.dir === "desc") return null; // third click resets
      }
      return { key, dir: "asc" };
    });
  };

  const buttonStyle: React.CSSProperties = {
    padding: "3px 10px", borderRadius: 4, border: "1px solid #ccc",
    background: "#fff", fontSize: 12, color: "#555", cursor: "pointer",
  };

  return (
    <div style={{ marginTop: 8 }}>
      {block.caption && (
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{block.caption}</div>
      )}
      <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
        <button style={buttonStyle} onClick={() => downloadCsv(columns, rawRows)}>
          Download CSV
        </button>
        <button
          style={{ ...buttonStyle, opacity: sheetsLoading ? 0.6 : 1 }}
          disabled={sheetsLoading}
          onClick={async () => {
            setSheetsLoading(true);
            try { await openInGoogleSheets(columns, rawRows, message); }
            catch { /* ignore */ }
            finally { setSheetsLoading(false); }
          }}
        >
          {sheetsLoading ? "Creating..." : "Open in Google Sheets"}
        </button>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 13, width: "100%" }}>
          <thead>
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  onClick={() => handleSort(col.key)}
                  style={{
                    borderBottom: "2px solid #ddd", padding: "6px 10px",
                    textAlign: col.format === "text" || col.format === "id" ? "left" : "right",
                    whiteSpace: "nowrap", background: "#f5f5f5",
                    cursor: "pointer", userSelect: "none",
                  }}
                >
                  {col.label}
                  <SortIcon dir={sort?.key === col.key ? sort.dir : null} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const isTotal = i === 0 && isTotalsRow(row, columns);
              return (
                <tr
                  key={i}
                  style={{
                    background: isTotal ? "#e8eaf6" : i % 2 === 0 ? "#fff" : "#fafafa",
                    fontWeight: isTotal ? 600 : 400,
                  }}
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      style={{
                        borderBottom: isTotal ? "2px solid #9fa8da" : "1px solid #eee",
                        padding: "4px 10px", whiteSpace: "nowrap",
                        textAlign: col.format === "text" || col.format === "id" ? "left" : "right",
                      }}
                    >
                      {formatValue(row[col.key], colFormatToHint(col.format))}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ChartBlock({ block }: { block: ContentBlock }) {
  if (!block.chart_type || !block.x_key || !block.y_keys || !block.data) return null;

  return (
    <Chart
      spec={{
        type: block.chart_type as any,
        title: block.chart_title || "",
        x_key: block.x_key,
        y_keys: block.y_keys,
        data: block.data,
        x_label: block.x_label || "",
        y_label: block.y_label || "",
      }}
    />
  );
}

function HierarchyBlock({ block }: { block: ContentBlock }) {
  if (!block.hierarchy_keys || !block.columns || !block.data) return null;

  return (
    <HierarchyTable
      spec={{
        hierarchy_keys: block.hierarchy_keys,
        value_keys: block.columns.map((c) => c.key),
        data: block.data,
      }}
    />
  );
}

export function BlockRenderer({ blocks, message }: BlockRendererProps) {
  return (
    <>
      {blocks.map((block, i) => {
        switch (block.type) {
          case "text":
            return <TextBlock key={i} content={block.content || ""} />;
          case "chart":
            return <ChartBlock key={i} block={block} />;
          case "table":
            return <TableBlock key={i} block={block} message={message} />;
          case "hierarchy_table":
            return <HierarchyBlock key={i} block={block} />;
          default:
            return null;
        }
      })}
    </>
  );
}
