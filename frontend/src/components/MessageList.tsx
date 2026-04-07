import { useEffect, useRef, useMemo, useState } from "react";
import Markdown from "react-markdown";
import type { Message, HierarchyTableSpec } from "../types/api";
import { DataTable } from "./DataTable";
import { Chart } from "./Chart";
import { LogicPanel } from "./LogicPanel";
import { ClarificationPrompt } from "./ClarificationPrompt";
import { HierarchyTable } from "./HierarchyTable";
import { computeColumnScales, type Scale } from "../utils/format";

/**
 * Auto-detect ROLLUP data in flat query results.
 * If multiple leading columns have NULL patterns suggesting hierarchy levels,
 * convert to a HierarchyTableSpec.
 */
function detectHierarchyData(
  data: Record<string, unknown>[]
): HierarchyTableSpec | null {
  if (!data || data.length < 5) return null;

  const columns = Object.keys(data[0]);
  if (columns.length < 3) return null;

  // Columns ending in _id or containing "number" are identifiers, not hierarchy
  const isIdColumn = (col: string) => {
    const lower = col.toLowerCase();
    return lower.endsWith("_id") || lower.includes("number") ||
           lower.includes("zip") || lower.includes("upc");
  };

  const nullCounts: Record<string, number> = {};
  for (const col of columns) {
    nullCounts[col] = data.filter(
      (row) => row[col] === null || row[col] === undefined || row[col] === ""
    ).length;
  }

  const hierarchyKeys: string[] = [];
  const valueKeys: string[] = [];

  for (const col of columns) {
    // Skip ID columns entirely — they're never hierarchy levels
    if (isIdColumn(col)) continue;

    const nonNullValues = data
      .map((r) => r[col])
      .filter((v) => v !== null && v !== undefined && v !== "");

    const numericCount = nonNullValues.filter((v) => typeof v === "number").length;
    const stringCount = nonNullValues.filter((v) => typeof v === "string").length;

    if (numericCount > data.length * 0.5) {
      valueKeys.push(col);
    } else if (
      stringCount > 0 &&
      stringCount === nonNullValues.length &&  // ALL non-null values must be strings
      nullCounts[col] > 0 &&
      nullCounts[col] < data.length
    ) {
      hierarchyKeys.push(col);
    }
  }

  // Need exactly 2-3 hierarchy levels and at least 1 value column
  if (hierarchyKeys.length < 2 || hierarchyKeys.length > 4 || valueKeys.length < 1) return null;

  // Sort by null count ascending (fewer nulls = higher in hierarchy)
  hierarchyKeys.sort((a, b) => nullCounts[a] - nullCounts[b]);

  // Verify progressive null pattern
  for (let i = 1; i < hierarchyKeys.length; i++) {
    if (nullCounts[hierarchyKeys[i]] <= nullCounts[hierarchyKeys[i - 1]]) {
      return null;
    }
  }

  // Must have a grand total row (all hierarchy keys null)
  const hasGrandTotal = data.some((row) =>
    hierarchyKeys.every((k) => row[k] === null || row[k] === undefined || row[k] === "")
  );
  if (!hasGrandTotal) return null;

  // Subtotal rows should be a small fraction of total rows (not more than 30%)
  const subtotalCount = data.filter((row) =>
    hierarchyKeys.some((k) => row[k] === null || row[k] === undefined || row[k] === "")
  ).length;
  if (subtotalCount > data.length * 0.3) return null;

  return {
    hierarchy_keys: hierarchyKeys,
    value_keys: valueKeys,
    data,
  };
}

interface MessageListProps {
  messages: Message[];
  loading: boolean;
  status?: string | null;
  plan?: string | null;
  startedAt?: number | null;
  onCancel?: () => void;
  onSend?: (text: string) => void;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = Math.round(secs % 60);
  return `${mins}m ${remSecs}s`;
}

function ElapsedTimer({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState(Date.now() - startedAt);

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Date.now() - startedAt);
    }, 100);
    return () => clearInterval(interval);
  }, [startedAt]);

  return <span>{formatDuration(elapsed)}</span>;
}

const metaStyle: React.CSSProperties = {
  fontSize: 10,
  color: "#999",
  marginTop: 4,
};

function useSharedScales(msg: Message): Record<string, Scale> | undefined {
  return useMemo(() => {
    if (!msg.charts?.length || !msg.data?.length) return undefined;
    const allData: Record<string, unknown>[] = [...msg.data];
    for (const chart of msg.charts) {
      for (const row of chart.data) {
        allData.push(row as Record<string, unknown>);
      }
    }
    return computeColumnScales(allData);
  }, [msg.charts, msg.data]);
}

function AssistantMessage({
  msg,
  isLast,
  loading,
  onSend,
}: {
  msg: Message;
  isLast: boolean;
  loading: boolean;
  onSend?: (text: string) => void;
}) {
  const sharedScales = useSharedScales(msg);

  // Auto-detect hierarchy data in flat query results
  const autoHierarchy = useMemo(
    () => (msg.data && !msg.hierarchyTables?.length ? detectHierarchyData(msg.data) : null),
    [msg.data, msg.hierarchyTables]
  );

  return (
    <>
      <Markdown
        components={{
          table: ({ children }) => (
            <div style={{ overflowX: "auto", marginTop: 8 }}>
              <table
                style={{
                  borderCollapse: "collapse",
                  fontSize: 13,
                  width: "100%",
                }}
              >
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th
              style={{
                borderBottom: "2px solid #ddd",
                padding: "6px 10px",
                textAlign: "left",
                whiteSpace: "nowrap",
                background: "#f5f5f5",
                fontWeight: 600,
              }}
            >
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td
              style={{
                borderBottom: "1px solid #eee",
                padding: "4px 10px",
                whiteSpace: "nowrap",
              }}
            >
              {children}
            </td>
          ),
          tr: ({ children }) => (
            <tr style={{ background: "#fff" }}>{children}</tr>
          ),
        }}
      >
        {msg.content}
      </Markdown>
      {msg.clarification && isLast && !loading && onSend && (
        <ClarificationPrompt
          clarification={msg.clarification}
          onRespond={onSend}
          disabled={loading}
        />
      )}
      {msg.charts &&
        msg.charts.length > 0 &&
        msg.charts.map((chart, ci) => (
          <Chart key={ci} spec={chart} scaleOverrides={sharedScales} />
        ))}
      {msg.hierarchyTables && msg.hierarchyTables.length > 0 ? (
        msg.hierarchyTables.map((ht, hi) => (
          <HierarchyTable key={hi} spec={ht} />
        ))
      ) : msg.data && msg.data.length > 0 ? (
        autoHierarchy ? (
          <HierarchyTable spec={autoHierarchy} />
        ) : (
          <DataTable data={msg.data} scaleOverrides={sharedScales} message={msg} />
        )
      ) : null}
      {msg.steps && msg.steps.length > 0 && (
        <LogicPanel steps={msg.steps} />
      )}
      {msg.durationMs != null && (
        <div style={metaStyle}>
          Completed in {formatDuration(msg.durationMs)}
        </div>
      )}
    </>
  );
}

export function MessageList({
  messages,
  loading,
  status,
  plan,
  startedAt,
  onCancel,
  onSend,
}: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "16px 0" }}>
      {messages.length === 0 && (
        <div style={{ textAlign: "center", color: "#888", marginTop: 80 }}>
          <h2 style={{ fontWeight: 400 }}>RTIC Data Agent</h2>
          <p>
            Ask a question about sales, inventory, forecasts, or any business
            data.
          </p>
        </div>
      )}

      {messages.map((msg, i) => (
        <div
          key={i}
          style={{
            margin: "8px 0",
            padding: "12px 16px",
            borderRadius: 8,
            background: msg.role === "user" ? "#e3f2fd" : "#f5f5f5",
            maxWidth: msg.role === "user" ? "70%" : "100%",
            marginLeft: msg.role === "user" ? "auto" : 0,
          }}
        >
          {msg.role === "assistant" ? (
            <AssistantMessage
              msg={msg}
              isLast={i === messages.length - 1}
              loading={loading}
              onSend={onSend}
            />
          ) : (
            <>
              <p style={{ margin: 0 }}>{msg.content}</p>
              {msg.timestamp && (
                <div style={metaStyle}>{formatTime(msg.timestamp)}</div>
              )}
            </>
          )}
        </div>
      ))}

      {loading && (
        <div
          style={{
            padding: "12px 16px",
            background: "#f5f5f5",
            borderRadius: 8,
            margin: "8px 0",
          }}
        >
          {plan && (
            <div
              style={{
                fontSize: 13,
                color: "#333",
                marginBottom: 8,
                fontStyle: "italic",
              }}
            >
              {plan}
            </div>
          )}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                color: "#666",
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: "#1976d2",
                  animation: "pulse 1.2s ease-in-out infinite",
                }}
              />
              {status || "Thinking..."}
              {startedAt && (
                <span style={{ fontSize: 11, color: "#999", marginLeft: 4 }}>
                  <ElapsedTimer startedAt={startedAt} />
                </span>
              )}
            </div>
            {onCancel && (
              <button
                onClick={onCancel}
                style={{
                  padding: "3px 10px",
                  borderRadius: 4,
                  border: "1px solid #ccc",
                  background: "#fff",
                  fontSize: 12,
                  color: "#888",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
