export interface WorkerConfig {
  model: string;
  permissionMode: string;
  allowedTools?: string[];
  systemPromptAppend?: string;
  mcpServers: Record<string, McpServerConfig>;
  projectDir?: string;
  settingSources?: string[];
  anthropicApiKey?: string;
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface QueuedMessage {
  id: string;
  prompt: string;
  files?: FileAttachment[];
  userId?: string;
  userName?: string;
  teamId?: string;
  timestamp: number;
  /** Original Slack message timestamp (e.g. "1710123456.789012") — used for reactions */
  messageTs?: string;
  /** Slack response_url for updating ephemeral messages in-place */
  responseUrl?: string;
  /** Queue entry ID injected by gateway — used for ACK/NACK */
  _queueId?: string;
}

export interface FileAttachment {
  name: string;
  content: string; // base64 or text
  mimetype: string;
}

export interface PromptDisplay {
  tool?: string;
  command?: string;
  title?: string;
  description?: string;
  options?: PromptOption[];
  /** Label for "Always allow" button, e.g. "Bash(git add:*)". Present when SDK provides suggestions. */
  alwaysAllowLabel?: string;
  /** Batch permission: multiple tools in a single prompt. */
  tools?: Array<{ tool: string; description: string }>;
  /** AskUserQuestion: array of questions with headers, text, and options. */
  questions?: Array<{ header: string; question: string; options: Array<{ label: string; value: string }> }>;
  /** Plan review: pre-built Slack blocks for the plan content + approve/reject buttons. */
  planBlocks?: object[];
  /** Plan review: when block count exceeds 50, content is split across messages. */
  planSplitMessages?: object[][];
}

export interface PromptOption {
  label: string;
  value: string;
  description?: string;
}

export interface QueueEntry {
  id: string;
  threadKey: string;
  payload: unknown;
  status: 'pending' | 'delivered' | 'ack' | 'nack' | 'deadlettered';
  timestamp: number;
  deliveredAt?: number;
  attempts: number;
  lastError?: string;
  deadletterReason?: string;
}

export type WorkerState = 'starting' | 'idle' | 'busy';
