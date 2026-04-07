import { useEffect, useRef, useState } from "react";
import type { Message } from "../types/api";
import { BlockRenderer } from "./BlockRenderer";
import { LogicPanel } from "./LogicPanel";
import { ClarificationPrompt } from "./ClarificationPrompt";

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
  return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
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
  // Use block-based rendering if blocks are available
  const hasBlocks = msg.blocks && msg.blocks.length > 0;

  return (
    <>
      {hasBlocks ? (
        <BlockRenderer blocks={msg.blocks!} message={msg} />
      ) : (
        // Fallback for clarifications and legacy responses
        msg.content && <p style={{ margin: 0 }}>{msg.content}</p>
      )}
      {msg.clarification && isLast && !loading && onSend && (
        <ClarificationPrompt
          clarification={msg.clarification}
          onRespond={onSend}
          disabled={loading}
        />
      )}
      {msg.steps && msg.steps.length > 0 && (
        <LogicPanel steps={msg.steps} />
      )}
      {(msg.durationMs != null || msg.tokenUsage) && (
        <div style={metaStyle}>
          {msg.durationMs != null && `Completed in ${formatDuration(msg.durationMs)}`}
          {msg.durationMs != null && msg.tokenUsage && " · "}
          {msg.tokenUsage && `${msg.tokenUsage.input_tokens.toLocaleString()} in / ${msg.tokenUsage.output_tokens.toLocaleString()} out tokens`}
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
