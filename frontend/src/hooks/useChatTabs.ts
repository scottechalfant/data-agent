import { useState, useCallback, useRef } from "react";
import type { Message, ChatResponse, ClarificationData, HierarchyTableSpec } from "../types/api";

const API_BASE = import.meta.env.DEV ? "http://localhost:8080/api" : "/api";
const POLL_INTERVAL = 500; // ms

let nextTabId = 1;

export type ModelChoice = "gemini-2.5-flash" | "gemini-2.5-pro";

export interface ChatTab {
  id: number;
  title: string;
  messages: Message[];
  conversationId: string | null;
  loading: boolean;
  status: string | null;
  plan: string | null;
  startedAt: number | null;
  model: ModelChoice;
}

function createTab(): ChatTab {
  return {
    id: nextTabId++,
    title: "New Chat",
    messages: [],
    conversationId: null,
    loading: false,
    status: null,
    plan: null,
    startedAt: null,
    model: "gemini-2.5-flash",
  };
}

export function useChatTabs() {
  const [tabs, setTabs] = useState<ChatTab[]>([createTab()]);
  const [activeTabId, setActiveTabId] = useState(tabs[0].id);

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // Track active task IDs for cancellation
  const taskIdsRef = useRef<Map<number, string>>(new Map());

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

  const updateTab = useCallback(
    (tabId: number, updater: (tab: ChatTab) => ChatTab) => {
      setTabs((prev) => {
        const next = prev.map((t) => (t.id === tabId ? updater(t) : t));
        tabsRef.current = next;
        return next;
      });
    },
    []
  );

  const newTab = useCallback(() => {
    const tab = createTab();
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  }, []);

  const closeTab = useCallback(
    (tabId: number) => {
      setTabs((prev) => {
        const remaining = prev.filter((t) => t.id !== tabId);
        if (remaining.length === 0) {
          const fresh = createTab();
          setActiveTabId(fresh.id);
          return [fresh];
        }
        if (activeTabId === tabId) {
          const idx = prev.findIndex((t) => t.id === tabId);
          const newActive = remaining[Math.min(idx, remaining.length - 1)];
          setActiveTabId(newActive.id);
        }
        return remaining;
      });
      taskIdsRef.current.delete(tabId);
    },
    [activeTabId]
  );

  const cancel = useCallback(
    async (tabId: number) => {
      const taskId = taskIdsRef.current.get(tabId);
      if (taskId) {
        try {
          await fetch(`${API_BASE}/chat/cancel`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ task_id: taskId }),
          });
        } catch { /* ignore */ }
        taskIdsRef.current.delete(tabId);
      }
      updateTab(tabId, (t) => ({
        ...t,
        loading: false,
        status: null,
        plan: null,
        startedAt: null,
        messages: [...t.messages, { role: "assistant" as const, content: "Cancelled." }],
      }));
    },
    [updateTab]
  );

  const sendMessage = useCallback(
    async (tabId: number, text: string) => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab) return;

      const convId = tab.conversationId;
      const startTime = Date.now();

      updateTab(tabId, (t) => ({
        ...t,
        loading: true,
        status: "Starting...",
        plan: null,
        startedAt: startTime,
        title: t.messages.length === 0 ? text.slice(0, 40) : t.title,
        messages: [...t.messages, { role: "user" as const, content: text, timestamp: startTime }],
      }));

      try {
        // Start the task
        const startRes = await fetch(`${API_BASE}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text,
            conversation_id: convId,
            model: tab.model,
          }),
        });

        if (!startRes.ok) {
          const err = await startRes.text();
          throw new Error(err);
        }

        const { task_id, conversation_id } = await startRes.json();
        taskIdsRef.current.set(tabId, task_id);
        updateTab(tabId, (t) => ({ ...t, conversationId: conversation_id }));

        // Poll for results
        while (true) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL));

          // Check if cancelled
          if (!taskIdsRef.current.has(tabId)) break;

          const pollRes = await fetch(`${API_BASE}/chat/task/${task_id}`);
          if (!pollRes.ok) {
            throw new Error(`Poll failed: ${pollRes.status}`);
          }

          const poll = await pollRes.json();

          // Update status and plan
          updateTab(tabId, (t) => ({
            ...t,
            status: poll.status === "complete" ? "Preparing response..." : poll.status,
            plan: poll.plan ?? t.plan,
          }));

          if (poll.status === "complete" && poll.result) {
            const result = poll.result;
            taskIdsRef.current.delete(tabId);

            if (result.type === "clarification") {
              const clarification: ClarificationData = {
                question: result.question,
                response_type: result.response_type,
                options: result.options || [],
                conversation_id: result.conversation_id,
              };
              updateTab(tabId, (t) => ({
                ...t,
                conversationId: result.conversation_id,
                messages: [
                  ...t.messages,
                  {
                    role: "assistant" as const,
                    content: result.question,
                    clarification,
                    timestamp: Date.now(),
                    durationMs: Date.now() - startTime,
                  },
                ],
              }));
            } else {
              updateTab(tabId, (t) => ({
                ...t,
                conversationId: result.conversation_id,
                messages: [
                  ...t.messages,
                  {
                    role: "assistant" as const,
                    content: result.message,
                    data: result.data ?? undefined,
                    charts: result.charts ?? undefined,
                    hierarchyTables: result.hierarchy_tables ?? undefined,
                    steps: result.steps ?? undefined,
                    toolCalls: result.tool_calls_made,
                    timestamp: Date.now(),
                    durationMs: Date.now() - startTime,
                  },
                ],
              }));
            }
            break;
          }

          if (poll.status === "error") {
            taskIdsRef.current.delete(tabId);
            throw new Error(poll.error || "Agent error");
          }

          if (poll.status === "cancelled") {
            taskIdsRef.current.delete(tabId);
            break;
          }
        }
      } catch (err) {
        console.error("Chat error:", err);
        updateTab(tabId, (t) => ({
          ...t,
          messages: [
            ...t.messages,
            {
              role: "assistant" as const,
              content: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
            },
          ],
        }));
      } finally {
        updateTab(tabId, (t) => ({
          ...t,
          loading: false,
          status: null,
          plan: null,
          startedAt: null,
        }));
        taskIdsRef.current.delete(tabId);
      }
    },
    [updateTab]
  );

  const setModel = useCallback(
    (tabId: number, model: ModelChoice) => {
      updateTab(tabId, (t) => ({ ...t, model }));
    },
    [updateTab]
  );

  return {
    tabs,
    activeTab,
    activeTabId,
    setActiveTabId,
    newTab,
    closeTab,
    sendMessage,
    cancel,
    setModel,
  };
}
