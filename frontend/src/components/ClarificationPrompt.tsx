import { useState } from "react";
import type { ClarificationData } from "../types/api";

interface ClarificationPromptProps {
  clarification: ClarificationData;
  onRespond: (answer: string) => void;
  disabled: boolean;
}

export function ClarificationPrompt({
  clarification,
  onRespond,
  disabled,
}: ClarificationPromptProps) {
  const [freeText, setFreeText] = useState("");

  if (clarification.response_type === "multiple_choice") {
    return (
      <div style={{ marginTop: 8 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {clarification.options.map((option) => (
            <button
              key={option}
              onClick={() => onRespond(option)}
              disabled={disabled}
              style={{
                padding: "6px 14px",
                borderRadius: 6,
                border: "1px solid #1976d2",
                background: "#fff",
                color: "#1976d2",
                fontSize: 13,
                cursor: disabled ? "default" : "pointer",
                opacity: disabled ? 0.6 : 1,
                transition: "background 0.15s, color 0.15s",
              }}
              onMouseEnter={(e) => {
                if (!disabled) {
                  e.currentTarget.style.background = "#1976d2";
                  e.currentTarget.style.color = "#fff";
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "#fff";
                e.currentTarget.style.color = "#1976d2";
              }}
            >
              {option}
            </button>
          ))}
        </div>
      </div>
    );
  }

  // Free text response
  return (
    <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
      <input
        type="text"
        value={freeText}
        onChange={(e) => setFreeText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && freeText.trim() && !disabled) {
            onRespond(freeText.trim());
            setFreeText("");
          }
        }}
        placeholder="Type your answer..."
        disabled={disabled}
        style={{
          flex: 1,
          padding: "6px 10px",
          borderRadius: 6,
          border: "1px solid #ccc",
          fontSize: 13,
        }}
      />
      <button
        onClick={() => {
          if (freeText.trim()) {
            onRespond(freeText.trim());
            setFreeText("");
          }
        }}
        disabled={disabled || !freeText.trim()}
        style={{
          padding: "6px 14px",
          borderRadius: 6,
          border: "none",
          background: disabled || !freeText.trim() ? "#ccc" : "#1976d2",
          color: "#fff",
          fontSize: 13,
          cursor: disabled ? "default" : "pointer",
        }}
      >
        Answer
      </button>
    </div>
  );
}
