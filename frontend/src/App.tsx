import { useState } from "react";
import { useChat } from "./hooks/useChat";
import { MessageList } from "./components/MessageList";
import { ChatInput } from "./components/ChatInput";
import { TrendReports } from "./components/TrendReports";

type Tab = "chat" | "reports";

export default function App() {
  const [tab, setTab] = useState<Tab>("chat");
  const { messages, loading, sendMessage, reset } = useChat();

  return (
    <div
      style={{
        maxWidth: 900,
        margin: "0 auto",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        padding: "0 16px",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 0",
          borderBottom: "1px solid #ddd",
        }}
      >
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>
          RTIC Data Agent
        </h1>
        <div style={{ display: "flex", gap: 8 }}>
          <TabButton
            active={tab === "chat"}
            onClick={() => setTab("chat")}
            label="Chat"
          />
          <TabButton
            active={tab === "reports"}
            onClick={() => setTab("reports")}
            label="Reports"
          />
          {tab === "chat" && (
            <button
              onClick={reset}
              style={{
                padding: "4px 12px",
                borderRadius: 4,
                border: "1px solid #ccc",
                background: "#fff",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              New Chat
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      {tab === "chat" ? (
        <>
          <MessageList messages={messages} loading={loading} />
          <ChatInput onSend={sendMessage} disabled={loading} />
        </>
      ) : (
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 0" }}>
          <TrendReports />
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "4px 14px",
        borderRadius: 4,
        border: "1px solid #ccc",
        background: active ? "#1976d2" : "#fff",
        color: active ? "#fff" : "#333",
        fontSize: 13,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}
