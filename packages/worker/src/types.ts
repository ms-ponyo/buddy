// src/types.ts — All interfaces, type aliases, and enums for the buddy worker.
// This is the leaf of the dependency graph — everything imports from here.
// NO mutable state. NO Map instances. Interfaces and type aliases only.

// Re-export SDK types that are used throughout the worker
export type {
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  PermissionUpdateDestination,
  HookJSONOutput,
  CanUseTool,
} from '@anthropic-ai/claude-agent-sdk';

// ── Worker Config ────────────────────────────────────────────────────

/** Worker-level config, loaded from environment. */
export interface BuddyConfig {
  claudeModel: string;
  dispatchModel: string;
  permissionMode: string;  // PermissionMode from SDK, kept as string for env parsing
  permissionDestination: string;
  previewMode: 'off' | 'destructive' | 'moderate';
  logLevel: string;
  logFile: string;
  projectDir: string;
  slackBotToken: string;
  slackUserToken?: string;
  allowedUserIds: string[];
  allowedChannelIds: string[];
  adminUserIds: string[];
  triggerEmoji: string;
  projectMappingsFile: string;
  mcpServers: Record<string, McpServerConfig>;
  enabledMcpServers: string[];
  plugins: Array<{ type: 'local'; path: string }>;
  socketPath: string;
  persistenceSocket: string;
  gatewaySocket: string;
}

/** MCP server connection config. */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

// ── Execution Tracking ───────────────────────────────────────────────

/** Tracks a single active SDK invocation. */
export interface ActiveExecution {
  sessionId?: string;
  execLog: ExecEntry[];
  channel: string;
  threadTs: string;
  toolCount: number;
  filesChanged: Set<string>;
  lastIntent: string;
  statusTs: string;
  isBackground: boolean;
  interrupted: boolean;
  compacting?: boolean;
  model: string;
  costUsd: number;
  createdAt: number;
  lastActivityAt: number;
  finalMarkdown?: string;
  usage?: UsageInfo;
}

/** Result from a single SDK invocation. */
export interface ClaudeResult {
  result: string;
  isError: boolean;
  sessionId: string;
  costUsd: number;
  interrupted?: boolean;
  usage: UsageInfo;
}

/** Token usage information for an invocation. */
export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextWindowPercent: number;
  numTurns: number;
}

// ── Execution Log ────────────────────────────────────────────────────

/** A single entry in the execution log. */
export type ExecEntry =
  | { type: 'user_message'; content: string }
  | { type: 'text'; content: string }
  | { type: 'tool_use'; name: string; input: Record<string, unknown>; id: string }
  | { type: 'tool_result'; name: string; id: string; result: string }
  | { type: 'status_change'; message: string };

// ── Messages ─────────────────────────────────────────────────────────

/** Message pulled from persistence queue, ready for processing. */
export interface BufferedMessage {
  prompt: string;
  messageTs: string;
  userId?: string;
  teamId?: string;
  files?: FileAttachment[];
}

/** File attachment from Slack. */
export interface FileAttachment {
  name: string;
  content: string;  // base64 or text
  mimetype: string;
}

/** Slack file reference (URL-based, before download). */
export interface SlackFile {
  id: string;
  url: string;
  name: string;
  size: number;
}

// ── Todo Items ───────────────────────────────────────────────────────

/** A single todo item tracked during execution. */
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

// ── Tool Risk Classification ─────────────────────────────────────────

/** Risk level for a tool invocation. */
export type ToolRisk = 'destructive' | 'moderate' | 'info';

// ── Permission Mode ──────────────────────────────────────────────────

/** Per-thread permission mode override. */
export type ThreadPermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk' | 'plan' | 'auto';

// ── Permission Prompts ───────────────────────────────────────────────

/** Options passed when requesting permission for a tool use. */
export interface PermissionOpts {
  risk: ToolRisk;
  channel: string;
  threadTs: string;
  suggestions?: import('@anthropic-ai/claude-agent-sdk').PermissionUpdate[];
}

/** Pending permission request awaiting user response. */
export interface PendingPermission {
  resolve: (result: import('@anthropic-ai/claude-agent-sdk').HookJSONOutput) => void;
  messageTs?: string;
  previewTs?: string;
  suggestions?: import('@anthropic-ai/claude-agent-sdk').PermissionUpdate[];
  originalInput: Record<string, unknown>;
  toolName: string;
  channel: string;
  threadTs: string;
}

// ── AskUserQuestion ──────────────────────────────────────────────────

/** A single option in an ask-user-question prompt. */
export interface AskUserQuestionOption {
  label: string;
  description: string;
  markdown?: string;
  preview?: string;
}

/** A single question item in an ask-user-question prompt. */
export interface AskUserQuestionItem {
  question: string;
  header: string;
  options: AskUserQuestionOption[];
  multiSelect: boolean;
}

/** Input for the AskUserQuestion hook. */
export interface AskUserQuestionInput {
  questions: AskUserQuestionItem[];
}

/** Output from the AskUserQuestion hook. */
export interface AskUserQuestionOutput {
  answers: Record<string, string>;
}

/** Pending question awaiting user response. */
export interface PendingQuestion {
  resolve: (output: AskUserQuestionOutput) => void;
  input: AskUserQuestionInput;
  answers: Record<string, string>;
  answeredCount: number;
  totalQuestions: number;
  messageTs?: string;
  channel: string;
  threadTs: string;
  waitingForOther?: number;
}

// ── Plan Review ──────────────────────────────────────────────────────

/** Result of a plan review prompt. */
export interface PlanReviewResult {
  approved: boolean;
  feedback?: string;
}

/** Pending plan review awaiting user response. */
export interface PendingPlanReview {
  resolve: (result: import('@anthropic-ai/claude-agent-sdk').HookJSONOutput) => void;
  messageTs?: string;
  channel: string;
  threadTs: string;
}

// ── Interactive Bridge ───────────────────────────────────────────────

/** Result from an interactive bridge command execution. */
export interface BridgeResult {
  handled: boolean;
  output?: string;
  error?: string;
}

/** Pending interactive session awaiting user response. */
export interface PendingInteractive {
  resolve: (result: import('@anthropic-ai/claude-agent-sdk').PermissionResult) => void;
  messageTs?: string;
  channel: string;
  threadTs: string;
  command: string;
  lastOutputUpdate: number;
  outputSoFar: string;
  userInputTimeout?: ReturnType<typeof setTimeout>;
}

// ── Session & Invocation ─────────────────────────────────────────────

/** Async input queue interface for SDK user messages. */
export interface AsyncInputQueue<T> {
  enqueue(item: T): boolean;
  [Symbol.asyncIterator](): AsyncIterator<T>;
  close(): void;
}

/** SDK user message shape (matches Claude Agent SDK multi-turn input). */
export interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

/** Callbacks from ClaudeSessionService to the orchestration layer. */
export interface SessionCallbacks {
  onSessionInit(sessionId: string): void;
  onAssistantText(text: string): void;
  onToolUse(toolName: string, input: Record<string, unknown>, toolUseId: string): void;
  onToolResult(toolName: string, toolUseId: string, result: string): void;
  onToolProgress(toolName: string, elapsedSeconds: number, toolUseId: string): void;
  onStreamDelta(textDelta: string): void;
  onThinkingDelta(textDelta: string): void;
  onStatusChange(status: 'compacting' | null): void;
  onImageContent(imageData: Buffer, mediaType: string, toolName?: string): void;
  onTurnResult(result: ClaudeResult): boolean;
}

/** Parameters for invoking a Claude session. */
export interface InvokeParams {
  queue: AsyncInputQueue<SDKUserMessage>;
  config: BuddyConfig;
  sessionId?: string | null;
  callbacks: SessionCallbacks;
  mcpServers?: Record<string, unknown>;
  hooks?: Record<string, unknown>;
  canUseTool?: import('@anthropic-ai/claude-agent-sdk').CanUseTool;
  systemPromptAppend?: string;
  extraOptions?: Record<string, unknown>;
  projectDir?: string;
}

// ── Bot Commands ─────────────────────────────────────────────────────

/** A parsed bot command. */
export interface ParsedCommand {
  command: string;
  args: string;
}

/** Result of executing a bot command. */
export type CommandResult = 'handled' | 'dispatch' | 'main' | string;

// ── Message Context ──────────────────────────────────────────────────

/** Context for a message being processed. */
export interface MessageContext {
  channel: string;
  threadTs: string;
  messageTs: string;
  userId?: string;
  teamId?: string;
}

// ── Multi-Select ─────────────────────────────────────────────────────

/** An option in a multi-select component. */
export interface MultiSelectOption {
  label: string;
  value: string;
  description?: string;
}

// ── Queue Types ──────────────────────────────────────────────────────

/** Message queued for delivery to a worker. */
export interface QueuedMessage {
  id: string;
  prompt: string;
  files?: FileAttachment[];
  userId?: string;
  userName?: string;
  teamId?: string;
  timestamp: number;
  messageTs?: string;
  responseUrl?: string;
  _queueId?: string;
}

// ── Project Mapping ──────────────────────────────────────────────────

/** Maps a Slack channel to a project directory. */
export interface ProjectMapping {
  channelId: string;
  projectDir: string;
  label?: string;
}

// ── Prompt Display ───────────────────────────────────────────────────

/** Display metadata for a permission prompt. */
export interface PromptDisplay {
  tool?: string;
  command?: string;
  title?: string;
  description?: string;
  options?: PromptOption[];
}

/** A single option in a prompt display. */
export interface PromptOption {
  label: string;
  value: string;
  description?: string;
}

// ── Worker State ─────────────────────────────────────────────────────

/** State of a worker process. */
export type WorkerState = 'starting' | 'idle' | 'busy';

// ── Constants ────────────────────────────────────────────────────────

/** Interactive user input timeout: 5 minutes. */
export const INTERACTIVE_USER_TIMEOUT_MS = 5 * 60 * 1000;

/** Throttle for Slack message updates during interactive streaming. */
export const INTERACTIVE_OUTPUT_THROTTLE_MS = 1500;
