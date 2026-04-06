import { useState, useRef, useEffect } from "react";

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled: boolean;
}

export function ChatInput({ onSend, disabled }: ChatInputProps) {
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!disabled && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [disabled]);

  const handleSubmit = () => {
    const trimmed = input.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        padding: "12px 0",
        borderTop: "1px solid #ddd",
      }}
    >
      <textarea
        ref={textareaRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Ask about sales, inventory, trends..."
        disabled={disabled}
        rows={2}
        style={{
          flex: 1,
          padding: 10,
          borderRadius: 6,
          border: "1px solid #ccc",
          fontSize: 14,
          resize: "vertical",
          fontFamily: "inherit",
        }}
      />
      <button
        onClick={handleSubmit}
        disabled={disabled || !input.trim()}
        style={{
          padding: "0 20px",
          borderRadius: 6,
          border: "none",
          background: disabled || !input.trim() ? "#ccc" : "#1976d2",
          color: "#fff",
          fontSize: 14,
          cursor: disabled ? "default" : "pointer",
          alignSelf: "flex-end",
          height: 40,
        }}
      >
        Send
      </button>
    </div>
  );
}
