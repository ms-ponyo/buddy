import { STREAM_SIZE_LIMIT, STREAM_TASK_LIMIT, STREAM_ROTATE_MS, type StreamType } from '@buddy/shared';

// ── Public interfaces ────────────────────────────────────────────────

export interface StreamerHandle {
  append(payload: { chunks: unknown[] }): Promise<{ ts?: string }>;
  stop(finalPlan?: Record<string, unknown>): Promise<void>;
}

export interface StreamFactoryResult {
  streamer: StreamerHandle;
  ts: string;
}

export interface StreamBufferLogger {
  info: (...args: any[]) => void;
  debug: (...args: any[]) => void;
}

export interface StreamBufferOptions {
  streamType: StreamType;
  channel: string;
  threadTs: string;
  userId: string;
  streamer: StreamerHandle;
  streamFactory: (channel: string, threadTs: string, userId: string, streamType: string) => Promise<StreamFactoryResult>;
  rateLimitAcquire?: () => Promise<void>;
  deleteMessage?: (channel: string, ts: string) => Promise<void>;
  onError?: (error: Error, context: string) => void;
  logger?: StreamBufferLogger;
}

// ── Recoverable error patterns ───────────────────────────────────────

const OVERFLOW_ERRORS = ['msg_too_long', 'not_in_streaming_state', 'message_not_found'];

function isOverflowError(err: Error): boolean {
  return OVERFLOW_ERRORS.some((pattern) => err.message?.includes(pattern));
}

// ── StreamBuffer ─────────────────────────────────────────────────────

/**
 * Per-stream state manager for the gateway.
 *
 * Handles buffering, drain, overflow detection, and transparent restart
 * (new message) when Slack stream limits or the rotation interval is reached.
 */
export class StreamBuffer {
  // ── Config (immutable after construction) ────────────────────────
  private readonly streamType: StreamType;
  private readonly channel: string;
  private readonly threadTs: string;
  private readonly userId: string;
  private readonly streamFactory: StreamBufferOptions['streamFactory'];
  private readonly rateLimitAcquire: () => Promise<void>;
  private readonly deleteMessage?: (channel: string, ts: string) => Promise<void>;
  private readonly onError: (error: Error, context: string) => void;
  private readonly logger: StreamBufferLogger;

  // ── Mutable stream state ─────────────────────────────────────────
  private streamer: StreamerHandle;
  private _slackTs: string;
  private pending: unknown[] = [];
  private stopped = false;

  // ── Tracking state ───────────────────────────────────────────────
  private byteCount = 0;
  private taskIdSet = new Set<string>();
  private createdAt = Date.now();
  private planTitle = 'Working';
  private _hadMeaningfulContent = false;
  private _contentSinceRotation = false;

  /** Cumulative snapshot of all task states — used for completion on rotation (all streams) and full recovery (todo streams) */
  private taskSnapshot = new Map<string, unknown>();

  constructor(opts: StreamBufferOptions) {
    this.streamType = opts.streamType;
    this.channel = opts.channel;
    this.threadTs = opts.threadTs;
    this.userId = opts.userId;
    this.streamer = opts.streamer;
    this._slackTs = ''; // Will be set by caller or after first drain
    this.streamFactory = opts.streamFactory;
    this.rateLimitAcquire = opts.rateLimitAcquire ?? (async () => {});
    this.deleteMessage = opts.deleteMessage;
    this.onError = opts.onError ?? (() => {});
    this.logger = opts.logger ?? { info: () => {}, debug: () => {} };
  }

  // ── Public getters ───────────────────────────────────────────────

  get slackTs(): string {
    return this._slackTs;
  }

  get hadMeaningfulContent(): boolean {
    return this._hadMeaningfulContent;
  }

  // ── Buffering ────────────────────────────────────────────────────

  /**
   * Add chunks to the pending buffer.
   * No-op when stopped.
   */
  append(chunks: unknown[]): void {
    if (this.stopped) return;
    this._contentSinceRotation = true;
    this.pending.push(...chunks);
  }

  // ── Drain ────────────────────────────────────────────────────────

  /**
   * Flush pending buffer to Slack via `streamer.append()`.
   *
   * - Splices pending chunks out BEFORE the async call.
   * - If the Slack call fails with an overflow/dead-stream error, pushes
   *   chunks back to pending and triggers `transparentRestart()`.
   * - Appends a `plan_update` chunk to every batch to force Slack flush.
   * - Tracks byte count, task IDs, meaningful content, and plan title.
   */
  async drain(): Promise<void> {
    if (this.stopped || this.pending.length === 0) return;

    // Splice out the batch BEFORE the async call
    const batch = this.pending.splice(0);

    // ── Pre-scan: extract metadata from batch ────────────────────
    const newTaskIds = new Set<string>();
    for (const chunk of batch) {
      const c = chunk as Record<string, unknown>;
      if (c.type === 'task_update' && typeof c.id === 'string') {
        newTaskIds.add(c.id);
      }
      if (c.type === 'plan_update' && typeof c.title === 'string') {
        this.planTitle = c.title;
      }
    }

    // ── Pre-flight overflow check ────────────────────────────────
    const batchSize = JSON.stringify(batch).length;
    const uniqueNewIds = new Set([...newTaskIds].filter((id) => !this.taskIdSet.has(id)));

    if (
      this.byteCount + batchSize > STREAM_SIZE_LIMIT ||
      this.taskIdSet.size + uniqueNewIds.size > STREAM_TASK_LIMIT
    ) {
      // Push batch back and restart first
      this.pending.unshift(...batch);
      await this.transparentRestart();
      // Re-drain on the new stream (recursive, but batch is back in pending)
      await this.drain();
      return;
    }

    // ── Build the payload with trailing plan_update ──────────────
    const payload = [...batch, { type: 'plan_update', title: this.planTitle }];

    try {
      await this.rateLimitAcquire();
      const result = await this.streamer.append({ chunks: payload });

      // ── Post-drain tracking ──────────────────────────────────
      this.byteCount += batchSize;

      for (const id of newTaskIds) {
        this.taskIdSet.add(id);
      }

      // Track meaningful content + task snapshot (all stream types)
      for (const chunk of batch) {
        const c = chunk as Record<string, unknown>;
        // Any non-metadata chunk counts as meaningful (text, tool_use, etc.)
        if (c.type !== 'plan_update') {
          this._hadMeaningfulContent = true;
        }
        if (c.type === 'task_update' && typeof c.id === 'string') {
          this.taskSnapshot.set(c.id, { ...c });
        }
      }

      // Capture slackTs if returned
      if (result?.ts) {
        this._slackTs = result.ts;
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));

      if (isOverflowError(error)) {
        // Push failed batch back to pending
        this.pending.unshift(...batch);
        await this.transparentRestart();
        // Don't re-drain here — the chunks are back in pending for the next drain call
      } else {
        this.onError(error, `drain:${this.streamType}`);
      }
    }
  }

  // ── Transparent restart ──────────────────────────────────────────

  /**
   * Rotate to a new Slack stream without the caller noticing.
   *
   * 1. Stop old stream (best effort)
   * 2. Create new stream via streamFactory
   * 3. Reset counters
   * 4. Prepend recovery payload:
   *    - todo streams: plan_update + full task snapshot
   *    - other streams: plan_update only (pending has the delta)
   */
  private async transparentRestart(): Promise<void> {
    const oldSlackTs = this._slackTs;
    const shouldDeleteOld = this.streamType === 'todo' && this.deleteMessage && oldSlackTs;
    // Delete empty main stream messages to avoid visible blank messages in the thread
    const shouldDeleteEmptyOld = this.streamType !== 'todo' && this.deleteMessage && oldSlackTs && !this._hadMeaningfulContent;

    if (!shouldDeleteOld && !shouldDeleteEmptyOld) {
      // For non-todo streams with content: complete all task cards so they don't appear stuck.
      // Strip delta fields (output/details/sources) to avoid re-appending content
      // that Slack already rendered from earlier chunks.
      const completionChunks: unknown[] = [];
      for (const [, chunk] of this.taskSnapshot) {
        const c = chunk as Record<string, unknown>;
        if (c.status !== 'complete') {
          const { output, details, sources, ...rest } = c;
          completionChunks.push({ ...rest, status: 'complete' });
        }
      }
      if (completionChunks.length > 0) {
        try {
          await this.streamer.append({ chunks: completionChunks });
        } catch {
          // Best effort — old stream may already be dead
        }
      }
    }

    // Stop old stream (best effort)
    try {
      await this.streamer.stop({});
    } catch {
      // Best effort
    }

    // Delete old message if it was a todo stream or an empty main stream
    if (shouldDeleteOld || shouldDeleteEmptyOld) {
      try {
        await this.deleteMessage!(this.channel, oldSlackTs);
        this.logger.info(shouldDeleteOld ? 'deleted old todo stream message on rotation' : 'deleted empty stream message on rotation', {
          threadTs: this.threadTs,
          slackTs: oldSlackTs,
        });
      } catch {
        // Best effort — message may already be gone
      }
    }

    // 3. Build recovery payload BEFORE resetting (needs snapshot)
    const recovery: unknown[] = [{ type: 'plan_update', title: this.planTitle }];
    if (this.streamType === 'todo' && this.taskSnapshot.size > 0) {
      recovery.push(...this.taskSnapshot.values());
    }

    // 4. Create new stream
    const { streamer, ts } = await this.streamFactory(this.channel, this.threadTs, this.userId, this.streamType);
    this.streamer = streamer;
    this._slackTs = ts;

    // 5. Reset counters
    this.byteCount = 0;
    this.taskIdSet.clear();
    this.taskSnapshot.clear();
    this.createdAt = Date.now();
    this._contentSinceRotation = false;
    this._hadMeaningfulContent = false;

    this.logger.info('stream rotated to new message', {
      threadTs: this.threadTs,
      streamType: this.streamType,
      oldSlackTs,
      newSlackTs: ts,
    });

    // 6. Prepend recovery payload
    this.pending.unshift(...recovery);
  }

  // ── Rotation ────────────────────────────────────────────────────

  /**
   * If the stream has been idle longer than STREAM_ROTATE_MS, restart
   * with a new Slack message to avoid the ~5 min timeout.
   *
   * Main streams recover with delta (only pending chunks).
   * Todo streams recover with the full task snapshot.
   */
  async checkRotation(): Promise<void> {
    if (this.stopped) return;
    if (this.pending.length > 0) return;

    const elapsed = Date.now() - this.createdAt;
    if (elapsed < STREAM_ROTATE_MS) return;

    // No content appended since last rotation — don't create an empty message.
    // If content arrives later, the overflow handler will restart the stream.
    if (!this._contentSinceRotation) {
      this.logger.debug('stream rotation skipped (no content since last rotation)', {
        threadTs: this.threadTs,
        streamType: this.streamType,
        elapsedSec: Math.round(elapsed / 1000),
      });
      return;
    }

    this.logger.info('stream rotation triggered', {
      threadTs: this.threadTs,
      streamType: this.streamType,
      elapsedSec: Math.round(elapsed / 1000),
      slackTs: this._slackTs,
    });

    await this.transparentRestart();
    await this.drain();
  }

  // ── Stop ─────────────────────────────────────────────────────────

  /**
   * Gracefully stop the stream: drain remaining chunks, complete task cards, then stop.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    this.logger.debug('stream buffer stopping', {
      threadTs: this.threadTs,
      streamType: this.streamType,
      slackTs: this._slackTs,
      ageSec: Math.round((Date.now() - this.createdAt) / 1000),
    });

    // Drain any remaining pending chunks
    if (this.pending.length > 0) {
      this.stopped = false;
      await this.drain();
      this.stopped = true;
    }

    // Complete all non-complete task cards so they don't appear stuck.
    // Strip delta fields (output/details/sources) to avoid re-appending content
    // that Slack already rendered from earlier chunks.
    const completionChunks: unknown[] = [];
    for (const [, chunk] of this.taskSnapshot) {
      const c = chunk as Record<string, unknown>;
      if (c.status !== 'complete') {
        const { output, details, sources, ...rest } = c;
        completionChunks.push({ ...rest, status: 'complete' });
      }
    }
    if (completionChunks.length > 0) {
      try {
        await this.streamer.append({ chunks: completionChunks });
      } catch {
        // Best effort — stream may already be dead
      }
    }

    try {
      await this.streamer.stop({});
    } catch {
      // Best effort
    }
  }
}
