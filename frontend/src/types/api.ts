export interface ChatRequest {
  message: string;
  conversation_id?: string;
}

export interface ChartSpec {
  type: "line" | "bar" | "pie";
  title: string;
  x_key: string;
  y_keys: string[];
  data: Record<string, unknown>[];
  x_label: string;
  y_label: string;
}

export interface StepLog {
  step: number;
  description: string;
  tool?: string | null;
  tool_input?: Record<string, unknown> | null;
  tool_output_summary?: string | null;
  reasoning?: string | null;
}

export interface ChatResponse {
  conversation_id: string;
  message: string;
  data?: Record<string, unknown>[];
  charts?: ChartSpec[];
  steps?: StepLog[];
  tool_calls_made: string[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  updated_at: string | null;
  created_at: string | null;
}

export interface TrendReport {
  id: string;
  type: string;
  message: string;
  tool_calls_made: string[];
  created_at: string;
}

export interface Message {
  role: "user" | "assistant";
  content: string;
  data?: Record<string, unknown>[];
  charts?: ChartSpec[];
  steps?: StepLog[];
  toolCalls?: string[];
}
