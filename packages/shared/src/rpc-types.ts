// packages/shared/src/rpc-types.ts

// ---- JSON-RPC 2.0 base protocol ----

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// Standard JSON-RPC error codes
export const RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return 'method' in msg && 'id' in msg;
}

export function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return 'method' in msg && !('id' in msg);
}

export function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return 'id' in msg && !('method' in msg);
}

// ---- Domain types ----

export type QueueName = 'inbound' | 'outbound' | 'inbound-lite';
export type QueueStatus = 'pending' | 'delivered' | 'completed' | 'deadlettered';
export type ProcessType = 'gateway' | 'worker' | 'persistence' | 'lite';

export interface QueueMessage {
  id: string;
  queue: QueueName;
  threadKey: string;
  status: QueueStatus;
  payload: Record<string, unknown>;
  retryCount: number;
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRecord {
  threadKey: string;
  sessionId?: string;
  cost: number;
  planPath?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ProcessEntry {
  type: ProcessType;
  threadKey: string;
  pid: number;
  socketPath: string;
  registeredAt: string;
  purpose: string;
}

export interface ThreadQueueMetrics {
  pending: number;
  delivered: number;
  oldest_unfinished_age_sec: number;
}

export interface QueueHealthMetrics {
  total_pending: number;
  total_delivered: number;
  by_thread: Record<string, ThreadQueueMetrics>;
}

export interface PersistenceHealth {
  status: 'ok' | 'degraded';
  uptime: number;
  queues: {
    inbound: QueueHealthMetrics;
    outbound: QueueHealthMetrics;
    'inbound-lite': QueueHealthMetrics;
  };
}

export interface WorkerHealth {
  status: 'ok';
  uptime: number;
  thread_key: string;
  last_activity_sec: number;
  awaiting_user_input: boolean;
  /** Name of the tool currently executing, or null if idle between tools. */
  active_tool: string | null;
  // Execution details (present when a session is running)
  execution?: {
    model: string;
    cost_usd: number;
    tool_count: number;
    files_changed: number;
    duration_sec: number;
    session_id?: string;
  };
}

// ---- Handshake ----

export interface IdentifyParams {
  type: 'gateway' | 'worker' | 'lite';
  threadKey?: string;
}

// ---- Typed RPC method param/result interfaces ----

// Queue methods
export interface QueueEnqueueParams { queue: QueueName; message: Record<string, unknown>; threadKey: string }
export interface QueueEnqueueResult { id: string }
export interface QueueAckParams { queue: QueueName; id: string }
export interface QueueNackParams { queue: QueueName; id: string }
export interface QueueDeadletterParams { queue: QueueName; id: string; reason: string }

// Session methods
export interface SessionGetParams { threadKey: string }
export interface SessionGetResult { session: SessionRecord | null }
export interface SessionUpsertParams { threadKey: string; data: Partial<Omit<SessionRecord, 'threadKey' | 'createdAt' | 'updatedAt'>> }
export interface SessionDeleteParams { threadKey: string }
export interface SessionListResult { sessions: SessionRecord[] }

// Registry methods
export interface RegistryRegisterParams { type: ProcessType; threadKey?: string; pid: number; socketPath: string }
export interface RegistryDeregisterParams { type: ProcessType; threadKey?: string }
export interface RegistryListParams { type?: ProcessType }
export interface RegistryListResult { processes: ProcessEntry[] }

// Health
export type HealthPingResult = PersistenceHealth;

// Push delivery types
export interface SubscribeParams { queue: QueueName; threadKey?: string }
export interface SubscribeResult { ok: boolean }
export interface DeliverMessageParams { message: QueueMessage }
export interface DeliverMessageResult { accepted: boolean }

// Gateway methods (worker → gateway)
export interface SlackApiCallParams { method: string; args: Record<string, unknown> }
export interface SlackApiCallResult { result: unknown }
// Worker control methods (gateway → worker)
export interface WorkerInteractiveResponseParams { callbackId: string; action: unknown }
export type WorkerHealthPingResult = WorkerHealth;
