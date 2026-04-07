import { useState, useCallback, useRef } from "react";
import type { Message, ChatResponse, ClarificationData } from "../types/api";

const API_BASE = "/api";

export function useChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [plan, setPlan] = useState<string | null>(null);
  const requestIdRef = useRef<string | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);

  const cancel = useCallback(async () => {
    if (readerRef.current) {
      try { await readerRef.current.cancel(); } catch { /* ignore */ }
      readerRef.current = null;
    }
    if (requestIdRef.current) {
      try {
        await fetch(`${API_BASE}/chat/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ request_id: requestIdRef.current }),
        });
      } catch { /* ignore */ }
      requestIdRef.current = null;
    }
    setLoading(false);
    setStatus(null);
    setPlan(null);
    setMessages((prev) => [
      ...prev,
      { role: "assistant", content: "Cancelled." },
    ]);
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
      const userMessage: Message = { role: "user", content: text };
      setMessages((prev) => [...prev, userMessage]);
      setLoading(true);
      setStatus("Reviewing request...");
      setPlan(null);
      requestIdRef.current = null;

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

        const reader = res.body?.getReader();
        if (!reader) throw new Error("No response body");
        readerRef.current = reader;

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          let eventType = "";

          for (const line of lines) {
            if (line.startsWith("event: ")) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith("data: ")) {
              const dataStr = line.slice(6);

              try {
                const payload = JSON.parse(dataStr);

                switch (eventType) {
                  case "request_id":
                    requestIdRef.current = payload.request_id;
                    break;

                  case "plan":
                    setPlan(payload.plan);
                    break;

                  case "progress":
                    setStatus(payload.status);
                    break;

                  case "clarification": {
                    const clarification: ClarificationData = {
                      question: payload.question,
                      response_type: payload.response_type,
                      options: payload.options || [],
                      conversation_id: payload.conversation_id,
                    };
                    setConversationId(payload.conversation_id);
                    setMessages((prev) => [
                      ...prev,
                      {
                        role: "assistant",
                        content: payload.question,
                        clarification,
                      },
                    ]);
                    break;
                  }

                  case "result": {
                    const data = payload as ChatResponse;
                    setConversationId(data.conversation_id);
                    setMessages((prev) => [
                      ...prev,
                      {
                        role: "assistant",
                        content: data.message,
                        data: data.data ?? undefined,
                        charts: data.charts ?? undefined,
                        steps: data.steps ?? undefined,
                        toolCalls: data.tool_calls_made,
                      },
                    ]);
                    break;
                  }

                  case "cancelled":
                    break;

                  case "error":
                    throw new Error(payload.detail || "Unknown error");
                }
              } catch (e) {
                if (e instanceof Error && e.message !== "Unknown error" && eventType === "error") {
                  throw e;
                }
              }

              eventType = "";
            }
          }
        }

        readerRef.current = null;
      } catch (err) {
        if (readerRef.current !== null || requestIdRef.current !== null) {
          const errorMessage: Message = {
            role: "assistant",
            content: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
          };
          setMessages((prev) => [...prev, errorMessage]);
        }
      } finally {
        setLoading(false);
        setStatus(null);
        setPlan(null);
        readerRef.current = null;
        requestIdRef.current = null;
      }
    },
    [conversationId]
  );

  const reset = useCallback(() => {
    setMessages([]);
    setConversationId(null);
    setStatus(null);
    setPlan(null);
  }, []);

  return { messages, loading, status, plan, sendMessage, cancel, reset, conversationId };
}
