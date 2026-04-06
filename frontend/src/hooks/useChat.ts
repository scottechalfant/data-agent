import { useState, useCallback } from "react";
import type { Message, ChatResponse } from "../types/api";

const API_BASE = "/api";

export function useChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const sendMessage = useCallback(
    async (text: string) => {
      const userMessage: Message = { role: "user", content: text };
      setMessages((prev) => [...prev, userMessage]);
      setLoading(true);

      try {
        const res = await fetch(`${API_BASE}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text,
            conversation_id: conversationId,
          }),
        });

        if (!res.ok) {
          const err = await res.text();
          throw new Error(err);
        }

        const data: ChatResponse = await res.json();
        setConversationId(data.conversation_id);

        const assistantMessage: Message = {
          role: "assistant",
          content: data.message,
          data: data.data ?? undefined,
          charts: data.charts ?? undefined,
          steps: data.steps ?? undefined,
          toolCalls: data.tool_calls_made,
        };
        setMessages((prev) => [...prev, assistantMessage]);
      } catch (err) {
        const errorMessage: Message = {
          role: "assistant",
          content: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
        };
        setMessages((prev) => [...prev, errorMessage]);
      } finally {
        setLoading(false);
      }
    },
    [conversationId]
  );

  const reset = useCallback(() => {
    setMessages([]);
    setConversationId(null);
  }, []);

  return { messages, loading, sendMessage, reset, conversationId };
}
