import { useState, useCallback } from "react";
import { useChatTabs, type ModelChoice } from "./hooks/useChatTabs";
import { MessageList } from "./components/MessageList";
import { ChatInput } from "./components/ChatInput";
import { TrendReports } from "./components/TrendReports";

type View = "chats" | "reports";

export default function App() {
  const [view, setView] = useState<View>("chats");
  const {
    tabs,
    activeTab,
    activeTabId,
    setActiveTabId,
    newTab,
    closeTab,
    sendMessage,
    cancel,
    setModel,
  } = useChatTabs();

  const handleSend = useCallback(
    (text: string) => sendMessage(activeTabId, text),
    [sendMessage, activeTabId]
  );

  const handleCancel = useCallback(
    () => cancel(activeTabId),
    [cancel, activeTabId]
  );

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
      {/* Top bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 0",
          borderBottom: "1px solid #ddd",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <img
            src="https://rticoutdoors.com/images/rtic/rebranded/RTIC_Logo.svg"
            alt="RTIC"
            style={{ height: 28 }}
          />
          <div>
            <h1 style={{ fontSize: 16, fontWeight: 600, margin: 0, lineHeight: 1.2 }}>
              Data Agent
            </h1>
            <p
              style={{
                margin: 0,
                fontSize: 10,
                color: "#999",
                lineHeight: 1.2,
              }}
            >
              AI-powered analysis - results may not be accurate
            </p>
          </div>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          {view === "chats" && (
            <ModelToggle
              model={activeTab.model}
              onChange={(m) => setModel(activeTabId, m)}
              disabled={activeTab.loading}
            />
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <ViewButton
              active={view === "chats"}
              onClick={() => setView("chats")}
              label="Chat"
            />
            <ViewButton
              active={view === "reports"}
              onClick={() => setView("reports")}
              label="Reports"
            />
          </div>
        </div>
      </div>

      {view === "chats" ? (
        <>
          {/* Chat tab bar */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 2,
              padding: "6px 0",
              borderBottom: "1px solid #eee",
              overflowX: "auto",
            }}
          >
            {tabs.map((tab) => (
              <div
                key={tab.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "4px 10px",
                  borderRadius: "6px 6px 0 0",
                  background: tab.id === activeTabId ? "#e3f2fd" : "#f5f5f5",
                  border:
                    tab.id === activeTabId
                      ? "1px solid #bbdefb"
                      : "1px solid transparent",
                  borderBottom: "none",
                  cursor: "pointer",
                  fontSize: 12,
                  whiteSpace: "nowrap",
                  maxWidth: 180,
                  minWidth: 0,
                }}
                onClick={() => setActiveTabId(tab.id)}
              >
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    color: tab.id === activeTabId ? "#1565c0" : "#555",
                    fontWeight: tab.id === activeTabId ? 600 : 400,
                  }}
                >
                  {tab.title}
                </span>
                {tab.loading && (
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: "#1976d2",
                      animation: "pulse 1.2s ease-in-out infinite",
                      flexShrink: 0,
                    }}
                  />
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                  style={{
                    background: "none",
                    border: "none",
                    padding: "0 2px",
                    fontSize: 14,
                    color: "#999",
                    cursor: "pointer",
                    lineHeight: 1,
                    flexShrink: 0,
                  }}
                  title="Close tab"
                >
                  ×
                </button>
              </div>
            ))}
            <button
              onClick={newTab}
              style={{
                background: "none",
                border: "1px solid #ccc",
                borderRadius: 4,
                padding: "2px 8px",
                fontSize: 14,
                color: "#666",
                cursor: "pointer",
                marginLeft: 4,
                flexShrink: 0,
              }}
              title="New Chat"
            >
              +
            </button>
          </div>

          {/* Active chat */}
          <MessageList
            messages={activeTab.messages}
            loading={activeTab.loading}
            status={activeTab.status}
            plan={activeTab.plan}
            startedAt={activeTab.startedAt}
            onCancel={handleCancel}
            onSend={handleSend}
          />
          <ChatInput onSend={handleSend} disabled={activeTab.loading} />
        </>
      ) : (
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 0" }}>
          <TrendReports />
        </div>
      )}
    </div>
  );
}

function ModelToggle({
  model,
  onChange,
  disabled,
}: {
  model: ModelChoice;
  onChange: (m: ModelChoice) => void;
  disabled: boolean;
}) {
  const options: { value: ModelChoice; label: string }[] = [
    { value: "gemini-2.5-flash", label: "Flash" },
    { value: "gemini-2.5-pro", label: "Pro" },
  ];

  return (
    <div
      style={{
        display: "flex",
        borderRadius: 5,
        border: "1px solid #ccc",
        overflow: "hidden",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {options.map((opt) => {
        const selected = model === opt.value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            disabled={disabled}
            style={{
              padding: "3px 10px",
              border: "none",
              background: selected ? "#1976d2" : "#fff",
              color: selected ? "#fff" : "#666",
              fontSize: 11,
              fontWeight: selected ? 600 : 400,
              cursor: disabled ? "default" : "pointer",
              borderRight: opt === options[0] ? "1px solid #ccc" : "none",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function ViewButton({
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
