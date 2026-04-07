// packages/shared/src/stream-types.ts

// ── Constants (moved from worker's StreamManager) ────────────────────
export const STREAM_SIZE_LIMIT = 35_000;
export const STREAM_TASK_LIMIT = 48;
export const STREAM_ROTATE_MS = (4 * 60 + 30) * 1000; // 4m30s — new message before Slack's ~5m timeout

// ── Stream message types ─────────────────────────────────────────────
export type StreamType = 'main' | 'todo' | string; // string for future 'subagent:<id>'

export interface StreamStart {
  type: 'stream_start';
  channel: string;
  threadTs: string;
  userId: string;
}

export interface StreamChunk {
  type: 'stream_chunk';
  channel: string;
  threadTs: string;
  userId: string;
  streamType: StreamType;
  chunks: unknown[];
}

export interface StreamPause {
  type: 'stream_pause';
  channel: string;
  threadTs: string;
  streamTypes?: string[];   // only pause these types; omit = all
}

export interface StreamStop {
  type: 'stream_stop';
  channel: string;
  threadTs: string;
  streamTypes?: string[];   // only stop these types; omit = all
}

export type StreamMessage = StreamStart | StreamChunk | StreamPause | StreamStop;

const STREAM_TYPES = new Set(['stream_start', 'stream_chunk', 'stream_pause', 'stream_stop']);

export function isStreamMessage(payload: unknown): payload is StreamMessage {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    STREAM_TYPES.has((payload as Record<string, unknown>).type as string)
  );
}
