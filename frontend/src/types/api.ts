export interface ChatRequest {
  message: string;
  conversation_id?: string;
}

export interface ChartSpec {
  type:
    | "line"
    | "bar"
    | "stacked_bar"
    | "horizontal_bar"
    | "area"
    | "stacked_area"
    | "pie"
    | "scatter"
    | "combo"
    | "heatmap"
    | "waterfall"
    | "funnel"
    | "treemap"
    | "radar";
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

export interface HierarchyTableSpec {
  hierarchy_keys: string[];
  value_keys: string[];
  data: Record<string, unknown>[];
}

export interface ChatResponse {
  conversation_id: string;
  message: string;
  data?: Record<string, unknown>[];
  charts?: ChartSpec[];
  hierarchy_tables?: HierarchyTableSpec[];
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

export interface ClarificationData {
  question: string;
  response_type: "free_text" | "multiple_choice";
  options: string[];
  conversation_id: string;
}

export interface Message {
  role: "user" | "assistant";
  content: string;
  data?: Record<string, unknown>[];
  charts?: ChartSpec[];
  steps?: StepLog[];
  toolCalls?: string[];
  clarification?: ClarificationData;
  hierarchyTables?: HierarchyTableSpec[];
  timestamp?: number;
  durationMs?: number;
}
