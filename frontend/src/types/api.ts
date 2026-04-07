export interface ChatRequest {
  message: string;
  conversation_id?: string;
  model?: string;
}

export interface ColumnDef {
  key: string;
  label: string;
  format: "text" | "id" | "currency" | "number" | "percent" | "percent_change" | "bps_change";
  align?: "left" | "right";
}

export interface ContentBlock {
  type: "text" | "chart" | "table" | "hierarchy_table";

  // text
  content?: string;

  // chart
  chart_type?: string;
  chart_title?: string;
  x_key?: string;
  y_keys?: string[];
  x_label?: string;
  y_label?: string;
  data?: Record<string, unknown>[];

  // table
  columns?: ColumnDef[];
  rows?: Record<string, unknown>[];
  caption?: string;

  // hierarchy_table
  hierarchy_keys?: string[];
  // uses columns + data
}

export interface StepLog {
  step: number;
  description: string;
  tool?: string | null;
  tool_input?: Record<string, unknown> | null;
  tool_output_summary?: string | null;
  reasoning?: string | null;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface ChatResponse {
  conversation_id: string;
  blocks?: ContentBlock[];
  steps?: StepLog[];
  tool_calls_made: string[];
  token_usage?: TokenUsage;
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

export interface HierarchyTableSpec {
  hierarchy_keys: string[];
  value_keys: string[];
  data: Record<string, unknown>[];
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
  blocks?: ContentBlock[];
  steps?: StepLog[];
  toolCalls?: string[];
  clarification?: ClarificationData;
  tokenUsage?: TokenUsage;
  timestamp?: number;
  durationMs?: number;
}
