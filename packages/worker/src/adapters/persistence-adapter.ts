// src/adapters/persistence-adapter.ts — Wraps all persistence RPC calls.
// Absorbs SessionManager (src/session-manager.ts) functionality plus queue operations.

import { rmSync } from 'node:fs';
import type { RpcClient, SessionRecord, QueueMessage, QueueName } from '@buddy/shared';
import type { Logger } from '../logger.js';

const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours -- files dir cleanup
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

const CONNECT_BASE_DELAY_MS = 500;
const CONNECT_MAX_DELAY_MS = 5000;
const CONNECT_MAX_RETRIES = 10;

export class PersistenceAdapter {
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly client: RpcClient,
    private readonly logger: Logger,
  ) {}

  // ── Connection management ─────────────────────────────────────────

  get isConnected(): boolean {
    return this.client.isConnected;
  }

  /**
   * Connect to the persistence server with exponential backoff retry.
   * Base delay: 500ms, cap: 5s, max retries: 10.
   */
  async connect(): Promise<void> {
    let delay = CONNECT_BASE_DELAY_MS;

    for (let attempt = 0; attempt <= CONNECT_MAX_RETRIES; attempt++) {
      try {
        await this.client.connect();
        this.logger.info('Connected to persistence server');
        return;
      } catch (err) {
        if (attempt === CONNECT_MAX_RETRIES) {
          this.logger.error('Failed to connect to persistence after max retries', {
            attempts: attempt + 1,
            error: String(err),
          });
          throw err;
        }
        this.logger.warn('Persistence connect failed, retrying', {
          attempt: attempt + 1,
          nextDelayMs: delay,
          error: String(err),
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, CONNECT_MAX_DELAY_MS);
      }
    }
  }

  async close(): Promise<void> {
    this.stopCleanupInterval();
    await this.client.close();
  }

  // ── Queue operations ──────────────────────────────────────────────

  async enqueue(queue: QueueName, threadKey: string, message: Record<string, unknown>): Promise<string> {
    const { id } = await this.client.call('queue.enqueue', { queue, threadKey, message }) as { id: string };
    return id;
  }

  async ack(queue: QueueName, id: string): Promise<void> {
    await this.client.call('queue.ack', { queue, id });
  }

  async nack(queue: QueueName, id: string): Promise<void> {
    await this.client.call('queue.nack', { queue, id });
  }

  // ── Session operations ────────────────────────────────────────────

  async getSessionId(channel: string, threadTs: string): Promise<string | null> {
    const threadKey = `${channel}:${threadTs}`;
    const { session } = await this.client.call('session.get', { threadKey }) as { session: SessionRecord | null };
    return session?.sessionId ?? null;
  }

  async setSessionId(channel: string, threadTs: string, sessionId: string): Promise<void> {
    const threadKey = `${channel}:${threadTs}`;
    await this.client.call('session.upsert', { threadKey, data: { sessionId } });
  }

  async addCost(channel: string, threadTs: string, costUsd: number): Promise<number> {
    const threadKey = `${channel}:${threadTs}`;
    const { session } = await this.client.call('session.get', { threadKey }) as { session: SessionRecord | null };
    const newCost = (session?.cost ?? 0) + costUsd;
    await this.client.call('session.upsert', { threadKey, data: { cost: newCost } });
    return newCost;
  }

  async getCost(channel: string, threadTs: string): Promise<number> {
    const threadKey = `${channel}:${threadTs}`;
    const { session } = await this.client.call('session.get', { threadKey }) as { session: SessionRecord | null };
    return session?.cost ?? 0;
  }

  async setPlanFilePath(channel: string, threadTs: string, path: string): Promise<void> {
    const threadKey = `${channel}:${threadTs}`;
    await this.client.call('session.upsert', { threadKey, data: { planPath: path } });
  }

  async getPlanFilePath(channel: string, threadTs: string): Promise<string | undefined> {
    const threadKey = `${channel}:${threadTs}`;
    const { session } = await this.client.call('session.get', { threadKey }) as { session: SessionRecord | null };
    return session?.planPath;
  }

  async setLogFile(channel: string, threadTs: string, path: string): Promise<void> {
    const threadKey = `${channel}:${threadTs}`;
    await this.client.call('session.upsert', {
      threadKey,
      data: { metadata: { logFile: path } },
    });
  }

  async getLogFile(channel: string, threadTs: string): Promise<string | undefined> {
    const threadKey = `${channel}:${threadTs}`;
    const { session } = await this.client.call('session.get', { threadKey }) as { session: SessionRecord | null };
    return session?.metadata?.logFile as string | undefined;
  }

  async setFilesDir(channel: string, threadTs: string, dir: string): Promise<void> {
    const threadKey = `${channel}:${threadTs}`;
    await this.client.call('session.upsert', {
      threadKey,
      data: { metadata: { filesDir: dir } },
    });
  }

  async getFilesDir(channel: string, threadTs: string): Promise<string | undefined> {
    const threadKey = `${channel}:${threadTs}`;
    const { session } = await this.client.call('session.get', { threadKey }) as { session: SessionRecord | null };
    return session?.metadata?.filesDir as string | undefined;
  }

  async getLatestForChannel(
    channel: string,
  ): Promise<{ threadTs: string; sessionId: string } | undefined> {
    const { sessions } = await this.client.call('session.list', {}) as { sessions: SessionRecord[] };
    const now = Date.now();
    let best: { threadTs: string; sessionId: string; updatedAt: number } | undefined;

    for (const session of sessions) {
      if (!session.threadKey.startsWith(`${channel}:`)) continue;
      const updatedAt = new Date(session.updatedAt).getTime();
      if (now - updatedAt > SESSION_TTL_MS) continue;
      if (!session.sessionId) continue;
      if (!best || updatedAt > best.updatedAt) {
        const threadTs = session.threadKey.slice(channel.length + 1);
        best = { threadTs, sessionId: session.sessionId, updatedAt };
      }
    }

    return best ? { threadTs: best.threadTs, sessionId: best.sessionId } : undefined;
  }

  async deleteSession(channel: string, threadTs: string): Promise<boolean> {
    const threadKey = `${channel}:${threadTs}`;
    // Clean up files dir before deleting
    const { session } = await this.client.call('session.get', { threadKey }) as { session: SessionRecord | null };
    if (session?.metadata?.filesDir) {
      try {
        rmSync(session.metadata.filesDir as string, { recursive: true, force: true });
      } catch { /* ignore cleanup errors */ }
    }
    try {
      await this.client.call('session.delete', { threadKey });
      return true;
    } catch {
      return false;
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────

  /**
   * Iterate all sessions and remove filesDir from disk for those past the 4hr TTL.
   */
  async cleanup(): Promise<void> {
    const { sessions } = await this.client.call('session.list', {}) as { sessions: SessionRecord[] };
    const now = Date.now();

    for (const session of sessions) {
      const updatedAt = new Date(session.updatedAt).getTime();
      const age = now - updatedAt;
      if (age > SESSION_TTL_MS && session.metadata?.filesDir) {
        try {
          rmSync(session.metadata.filesDir as string, { recursive: true, force: true });
        } catch { /* ignore cleanup errors */ }
        await this.client.call('session.upsert', {
          threadKey: session.threadKey,
          data: { metadata: { ...session.metadata, filesDir: undefined } },
        });
      }
    }
  }

  startCleanupInterval(): void {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  stopCleanupInterval(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
