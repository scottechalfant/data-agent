import { useState, useRef, useEffect } from "react";

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled: boolean;
}

export function ChatInput({ onSend, disabled }: ChatInputProps) {
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!disabled && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [disabled]);

  const handleSubmit = () => {
    const trimmed = input.trim();
    if (!trimmed || disabled) return;
    setHistory((prev) => [...prev, trimmed]);
    setHistoryIndex(-1);
    onSend(trimmed);
    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
      return;
    }

    if (e.key === "ArrowUp") {
      const textarea = textareaRef.current;
      if (!textarea || history.length === 0) return;

      // Only activate if cursor is at the very start (home position)
      if (textarea.selectionStart !== 0 || textarea.selectionEnd !== 0) return;

      e.preventDefault();
      const newIndex =
        historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(newIndex);
      setInput(history[newIndex]);
    }

    if (e.key === "ArrowDown") {
      if (historyIndex === -1) return;

      e.preventDefault();
      if (historyIndex >= history.length - 1) {
        // Past the end — clear back to empty
        setHistoryIndex(-1);
        setInput("");
      } else {
        const newIndex = historyIndex + 1;
        setHistoryIndex(newIndex);
        setInput(history[newIndex]);
      }
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
        onChange={(e) => {
          setInput(e.target.value);
          setHistoryIndex(-1);
        }}
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
