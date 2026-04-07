import type { StreamMessage, StreamChunk } from '@buddy/shared';
import { StreamBuffer, type StreamFactoryResult } from './stream-buffer.js';

// ── Public interfaces ────────────────────────────────────────────────

export interface StreamRouterDeps {
  createStream: (channel: string, threadTs: string, userId: string, streamType: string) => Promise<StreamFactoryResult>;
  rateLimitAcquire: () => Promise<void>;
  deleteMessage: (channel: string, ts: string) => Promise<void>;
  logger: {
    info: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
    debug: (...args: any[]) => void;
  };
}

interface ThreadInfo {
  channel: string;
  userId: string;
}

// ── Rotation interval (30s) ─────────────────────────────────────────

const ROTATION_CHECK_MS = 30_000;

// ── StreamRouter ─────────────────────────────────────────────────────

/**
 * Routes stream messages to the correct StreamBuffer.
 * Manages per-thread multi-stream state (one StreamBuffer per streamType per thread).
 */
export class StreamRouter {
  private readonly deps: StreamRouterDeps;

  /** Per-thread cached info (channel + userId) from stream_start */
  private readonly threadInfo = new Map<string, ThreadInfo>();

  /** Per-thread, per-streamType StreamBuffer instances */
  private readonly streams = new Map<string, Map<string, StreamBuffer>>();

  /** Rotation check interval handle */
  private rotationInterval: ReturnType<typeof setInterval>;

  constructor(deps: StreamRouterDeps) {
    this.deps = deps;
    this.rotationInterval = setInterval(() => this.checkAllRotations(), ROTATION_CHECK_MS);
  }

  // ── Main entry point ──────────────────────────────────────────────

  async handle(msg: StreamMessage): Promise<void> {
    switch (msg.type) {
      case 'stream_start':
        await this.handleStart(msg);
        break;
      case 'stream_chunk':
        await this.handleChunk(msg);
        break;
      case 'stream_pause':
        await this.stopAllForThread(msg.threadTs, msg.channel, false, msg.streamTypes);
        break;
      case 'stream_stop':
        await this.stopAllForThread(msg.threadTs, msg.channel, true, msg.streamTypes);
        break;
    }
  }

  // ── stream_start ──────────────────────────────────────────────────

  private async handleStart(msg: StreamMessage & { type: 'stream_start' }): Promise<void> {
    this.threadInfo.set(msg.threadTs, {
      channel: msg.channel,
      userId: msg.userId,
    });

    // Eagerly create 'main' buffer so the rotation timer starts from stream_start,
    // not from the first chunk (which may arrive much later for long-running tasks).
    let threadStreams = this.streams.get(msg.threadTs);
    if (!threadStreams) {
      threadStreams = new Map();
      this.streams.set(msg.threadTs, threadStreams);
    }

    if (!threadStreams.has('main')) {
      const buffer = await this.createBuffer(msg.channel, msg.threadTs, msg.userId, 'main');
      threadStreams.set('main', buffer);
      this.deps.logger.info('stream_start: created main buffer (rotation timer started)', {
        threadTs: msg.threadTs,
        slackTs: buffer.slackTs,
      });
    } else {
      this.deps.logger.debug('stream_start: main buffer already exists', {
        threadTs: msg.threadTs,
      });
    }
  }

  // ── stream_chunk ──────────────────────────────────────────────────

  private async handleChunk(msg: StreamChunk): Promise<void> {
    const { threadTs, streamType, chunks, channel, userId } = msg;

    // Cache thread info if not already present (implicit start via chunk)
    if (!this.threadInfo.has(threadTs)) {
      this.threadInfo.set(threadTs, { channel, userId });
    }

    // Ensure we have a thread-level map
    let threadStreams = this.streams.get(threadTs);
    if (!threadStreams) {
      threadStreams = new Map();
      this.streams.set(threadTs, threadStreams);
    }

    // Get or create the StreamBuffer for this streamType
    let buffer = threadStreams.get(streamType);
    if (!buffer) {
      buffer = await this.createBuffer(channel, threadTs, userId, streamType);
      threadStreams.set(streamType, buffer);
    }

    // Append chunks and drain
    buffer.append(chunks);
    await buffer.drain();
  }

  // ── Buffer creation ───────────────────────────────────────────────

  private async createBuffer(
    channel: string,
    threadTs: string,
    userId: string,
    streamType: string,
  ): Promise<StreamBuffer> {
    const result = await this.deps.createStream(channel, threadTs, userId, streamType);

    const buffer = new StreamBuffer({
      streamType,
      channel,
      threadTs,
      userId,
      streamer: result.streamer,
      streamFactory: (ch, ts, uid, st) => this.deps.createStream(ch, ts, uid, st),
      rateLimitAcquire: () => this.deps.rateLimitAcquire(),
      deleteMessage: (ch, ts) => this.deps.deleteMessage(ch, ts),
      onError: (error, context) => {
        this.deps.logger.error('StreamBuffer error', { error: error.message, context, threadTs, streamType });
      },
      logger: this.deps.logger,
    });

    // Set the Slack message timestamp from the factory result
    (buffer as any)._slackTs = result.ts;

    this.deps.logger.debug('created StreamBuffer', { threadTs, streamType, slackTs: result.ts });
    return buffer;
  }

  // ── Stop all streams for a thread ─────────────────────────────────

  private async stopAllForThread(
    threadTs: string,
    channel: string,
    cleanup: boolean,
    streamTypes?: string[],
  ): Promise<void> {
    const threadStreams = this.streams.get(threadTs);
    if (!threadStreams) {
      if (cleanup && !streamTypes) {
        this.threadInfo.delete(threadTs);
      }
      return;
    }

    const filter = streamTypes?.length ? new Set(streamTypes) : null;

    for (const [streamType, buffer] of threadStreams) {
      if (filter && !filter.has(streamType)) continue;

      this.deps.logger.debug('stream_stop: stopping buffer', {
        threadTs, streamType, slackTs: buffer.slackTs, cleanup,
      });

      try {
        await buffer.stop();
      } catch (err) {
        this.deps.logger.error('error stopping stream', {
          threadTs,
          streamType,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Delete empty Slack messages on cleanup (stream_stop)
      if (cleanup && !buffer.hadMeaningfulContent && buffer.slackTs) {
        try {
          await this.deps.deleteMessage(channel, buffer.slackTs);
          this.deps.logger.info('deleted empty stream message', { threadTs, streamType, slackTs: buffer.slackTs });
        } catch (err) {
          this.deps.logger.warn('failed to delete empty stream message', {
            threadTs,
            streamType,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      threadStreams.delete(streamType);
    }

    // Only clean up thread-level state if ALL streams are gone
    if (threadStreams.size === 0) {
      this.streams.delete(threadTs);
      if (cleanup) {
        this.threadInfo.delete(threadTs);
      }
    }
  }

  // ── Rotation checker ──────────────────────────────────────────────

  private checkAllRotations(): void {
    for (const [threadTs, threadStreams] of this.streams) {
      for (const [streamType, buffer] of threadStreams) {
        buffer.checkRotation().catch((err) => {
          this.deps.logger.error('rotation check failed', {
            threadTs,
            streamType,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────

  /**
   * Stop the rotation interval and stop all active streams.
   */
  close(): void {
    clearInterval(this.rotationInterval);

    // Stop all streams (fire and forget — close is synchronous for API simplicity)
    for (const [threadTs, threadStreams] of this.streams) {
      for (const [_streamType, buffer] of threadStreams) {
        buffer.stop().catch((err) => {
          this.deps.logger.error('error stopping stream during close', {
            threadTs,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }

    this.streams.clear();
    this.threadInfo.clear();
  }
}
