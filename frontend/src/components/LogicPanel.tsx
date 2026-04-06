import { useState } from "react";
import type { StepLog } from "../types/api";

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

function StepDetail({ step }: { step: StepLog }) {
  const [expanded, setExpanded] = useState(false);
  const color = STEP_COLORS[step.description] ?? "#455a64";

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
          }}
        >
          {step.description}
        </span>
        <span style={{ fontSize: 12, color: "#333" }}>
          {step.tool ? (
            <>
              <code style={{ fontSize: 11, background: "#e8e8e8", padding: "1px 4px", borderRadius: 2 }}>
                {step.tool}
              </code>
            </>
          ) : (
            "Final response"
          )}
        </span>
        <span style={{ fontSize: 11, color: "#999", marginLeft: "auto" }}>
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
                Input
              </div>
              {step.tool === "run_query" && step.tool_input.sql ? (
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
                  {String(step.tool_input.sql)}
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
