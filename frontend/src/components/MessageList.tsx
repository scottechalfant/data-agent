import { useEffect, useRef, useMemo } from "react";
import Markdown from "react-markdown";
import type { Message } from "../types/api";
import { DataTable } from "./DataTable";
import { Chart } from "./Chart";
import { LogicPanel } from "./LogicPanel";
import { computeColumnScales, type Scale } from "../utils/format";

interface MessageListProps {
  messages: Message[];
  loading: boolean;
}

/**
 * When a message has both charts and table data, compute unified scales
 * from the combined data so numbers format the same in both.
 */
function useSharedScales(msg: Message): Record<string, Scale> | undefined {
  return useMemo(() => {
    if (!msg.charts?.length || !msg.data?.length) return undefined;

    // Collect all data points from charts and the table
    const allData: Record<string, unknown>[] = [...msg.data];
    for (const chart of msg.charts) {
      for (const row of chart.data) {
        allData.push(row as Record<string, unknown>);
      }
    }

    return computeColumnScales(allData);
  }, [msg.charts, msg.data]);
}

function AssistantMessage({ msg }: { msg: Message }) {
  const sharedScales = useSharedScales(msg);

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
      {msg.charts &&
        msg.charts.length > 0 &&
        msg.charts.map((chart, ci) => (
          <Chart key={ci} spec={chart} scaleOverrides={sharedScales} />
        ))}
      {msg.data && msg.data.length > 0 && (
        <DataTable data={msg.data} scaleOverrides={sharedScales} />
      )}
      {msg.steps && msg.steps.length > 0 && (
        <LogicPanel steps={msg.steps} />
      )}
    </>
  );
}

export function MessageList({ messages, loading }: MessageListProps) {
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
            <AssistantMessage msg={msg} />
          ) : (
            <p style={{ margin: 0 }}>{msg.content}</p>
          )}
        </div>
      ))}

      {loading && (
        <div style={{ padding: "12px 16px", color: "#888" }}>
          Analyzing...
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
