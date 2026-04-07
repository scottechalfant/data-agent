import { useState } from "react";
import type { StepLog } from "../types/api";

/**
 * Basic SQL formatter: uppercases keywords and ensures newlines before major clauses.
 */
function formatSql(sql: string): string {
  const keywords = [
    "SELECT", "FROM", "WHERE", "AND", "OR", "JOIN", "LEFT JOIN", "RIGHT JOIN",
    "INNER JOIN", "CROSS JOIN", "FULL JOIN", "ON", "GROUP BY", "ORDER BY",
    "HAVING", "LIMIT", "OFFSET", "UNION ALL", "UNION", "WITH", "AS",
    "CASE", "WHEN", "THEN", "ELSE", "END", "BETWEEN", "IN", "NOT",
    "IS NULL", "IS NOT NULL", "ASC", "DESC", "DISTINCT",
  ];

  // Normalize whitespace
  let formatted = sql.replace(/\s+/g, " ").trim();

  // Add newlines before major clauses
  const lineBreakBefore = [
    "SELECT", "FROM", "WHERE", "GROUP BY", "ORDER BY", "HAVING",
    "LIMIT", "UNION ALL", "UNION", "LEFT JOIN", "RIGHT JOIN",
    "INNER JOIN", "CROSS JOIN", "FULL JOIN", "JOIN", "WITH",
  ];

  for (const kw of lineBreakBefore) {
    const regex = new RegExp(`\\b(${kw})\\b`, "gi");
    formatted = formatted.replace(regex, `\n$1`);
  }

  // Indent continuation lines
  const lines = formatted.split("\n").filter((l) => l.trim());
  const indentAfter = new Set(["SELECT", "FROM", "WHERE", "GROUP BY", "ORDER BY", "HAVING", "WITH"]);

  const result: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const firstWord = trimmed.split(/\s/)[0].toUpperCase();
    if (indentAfter.has(firstWord) || firstWord.endsWith("JOIN")) {
      result.push(trimmed);
    } else {
      result.push("  " + trimmed);
    }
  }

  return result.join("\n");
}

interface LogicPanelProps {
  steps: StepLog[];
}

const STEP_COLORS: Record<string, string> = {
  Research: "#1565c0",
  Query: "#e65100",
  Visualize: "#2e7d32",
  Memory: "#6a1b9a",
  Respond: "#37474f",
  Tool: "#455a64",
};

function parseStepLabel(description: string): { label: string; detail: string } {
  const colonIdx = description.indexOf(": ");
  if (colonIdx > 0) {
    return {
      label: description.slice(0, colonIdx),
      detail: description.slice(colonIdx + 2),
    };
  }
  return { label: description, detail: "" };
}

function StepDetail({ step }: { step: StepLog }) {
  const [expanded, setExpanded] = useState(false);
  const { label, detail } = parseStepLabel(step.description);
  const color = STEP_COLORS[label] ?? "#455a64";

  return (
    <div style={{ marginBottom: 8 }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: "#fff",
            background: color,
            padding: "1px 6px",
            borderRadius: 3,
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          {label}
        </span>
        <span style={{ fontSize: 12, color: "#333", flex: 1, minWidth: 0 }}>
          {detail || (step.tool ? step.tool : "Final response")}
        </span>
        <span style={{ fontSize: 11, color: "#999", flexShrink: 0 }}>
          {expanded ? "Hide" : "Details"}
        </span>
      </div>

      {expanded && (
        <div
          style={{
            marginTop: 4,
            marginLeft: 16,
            padding: "8px 12px",
            background: "#fff",
            border: "1px solid #e0e0e0",
            borderRadius: 4,
            fontSize: 12,
          }}
        >
          {step.reasoning && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontWeight: 600, color: "#555", marginBottom: 2 }}>
                Reasoning
              </div>
              <div style={{ whiteSpace: "pre-wrap", color: "#333" }}>
                {step.reasoning}
              </div>
            </div>
          )}

          {step.tool_input && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontWeight: 600, color: "#555", marginBottom: 2 }}>
                {step.tool === "run_query" ? "SQL Query" : "Input"}
              </div>
              {step.tool === "run_query" && step.tool_input.sql ? (
                <pre
                  style={{
                    background: "#1e1e1e",
                    color: "#d4d4d4",
                    padding: 12,
                    borderRadius: 6,
                    overflow: "auto",
                    fontSize: 12,
                    lineHeight: 1.5,
                    margin: 0,
                    whiteSpace: "pre",
                    fontFamily: "'SF Mono', 'Fira Code', 'Consolas', monospace",
                  }}
                >
                  {formatSql(String(step.tool_input.sql))}
                </pre>
              ) : (
                <pre
                  style={{
                    background: "#f5f5f5",
                    padding: 8,
                    borderRadius: 4,
                    overflow: "auto",
                    fontSize: 11,
                    margin: 0,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {JSON.stringify(step.tool_input, null, 2)}
                </pre>
              )}
            </div>
          )}

          {step.tool_output_summary && (
            <div>
              <div style={{ fontWeight: 600, color: "#555", marginBottom: 2 }}>
                Result
              </div>
              <div
                style={{
                  whiteSpace: "pre-wrap",
                  color: "#333",
                  fontSize: 11,
                  wordBreak: "break-word",
                }}
              >
                {step.tool_output_summary}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function LogicPanel({ steps }: LogicPanelProps) {
  const [open, setOpen] = useState(false);

  if (steps.length === 0) return null;

  return (
    <div style={{ marginTop: 8 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: "none",
          border: "none",
          padding: 0,
          fontSize: 12,
          color: "#1976d2",
          cursor: "pointer",
          textDecoration: "underline",
        }}
      >
        {open ? "Hide logic" : `Show logic (${steps.length} steps)`}
      </button>

      {open && (
        <div
          style={{
            marginTop: 8,
            padding: 12,
            background: "#fafafa",
            border: "1px solid #e0e0e0",
            borderRadius: 6,
          }}
        >
          {steps.map((step) => (
            <StepDetail key={step.step} step={step} />
          ))}
        </div>
      )}
    </div>
  );
}
