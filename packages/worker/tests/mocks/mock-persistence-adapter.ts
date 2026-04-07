// tests/mocks/mock-persistence-adapter.ts — In-memory mock for PersistenceAdapter.

import { jest } from '@jest/globals';
import type { QueueMessage, QueueName } from '@buddy/shared';

export interface InMemorySession {
  threadKey: string;
  sessionId?: string;
  cost: number;
  planPath?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface QueuedMessage {
  id: string;
  queue: QueueName;
  threadKey: string;
  payload: Record<string, unknown>;
}

export interface MockPersistenceAdapter {
  // In-memory state
  sessions: Map<string, InMemorySession>;
  queue: QueuedMessage[];

  // Test convenience method
  upsertSession(threadKey: string, data: Partial<Omit<InMemorySession, 'threadKey' | 'createdAt' | 'updatedAt'>>): Promise<void>;

  // Connection
  isConnected: boolean;
  connect: jest.Mock<Promise<void>, []>;
  close: jest.Mock<Promise<void>, []>;

  // Notification handling
  onNotification: jest.Mock<void, [any]>;
  handleNotification: jest.Mock<void, [string, Record<string, unknown>]>;

  // Queue operations
  pull: jest.Mock<Promise<QueueMessage[]>, [QueueName, string]>;
  enqueue: jest.Mock<Promise<string>, [QueueName, string, Record<string, unknown>]>;
  ack: jest.Mock<Promise<void>, [QueueName, string]>;
  nack: jest.Mock<Promise<void>, [QueueName, string]>;

  // Session operations
  getSessionId: jest.Mock<Promise<string | null>, [string, string]>;
  setSessionId: jest.Mock<Promise<void>, [string, string, string]>;
  addCost: jest.Mock<Promise<number>, [string, string, number]>;
  getCost: jest.Mock<Promise<number>, [string, string]>;
  setPlanFilePath: jest.Mock<Promise<void>, [string, string, string]>;
  getPlanFilePath: jest.Mock<Promise<string | undefined>, [string, string]>;
  setLogFile: jest.Mock<Promise<void>, [string, string, string]>;
  getLogFile: jest.Mock<Promise<string | undefined>, [string, string]>;
  setFilesDir: jest.Mock<Promise<void>, [string, string, string]>;
  getFilesDir: jest.Mock<Promise<string | undefined>, [string, string]>;
  getLatestForChannel: jest.Mock<Promise<{ threadTs: string; sessionId: string } | undefined>, [string]>;
  deleteSession: jest.Mock<Promise<boolean>, [string, string]>;

  // Cleanup
  cleanup: jest.Mock<Promise<void>, []>;
  startCleanupInterval: jest.Mock<void, []>;
  stopCleanupInterval: jest.Mock<void, []>;
}

function now(): string {
  return new Date().toISOString();
}

function getOrCreateSession(sessions: Map<string, InMemorySession>, threadKey: string): InMemorySession {
  let session = sessions.get(threadKey);
  if (!session) {
    session = { threadKey, cost: 0, createdAt: now(), updatedAt: now() };
    sessions.set(threadKey, session);
  }
  return session;
}

let messageIdCounter = 0;

export function mockPersistenceAdapter(): MockPersistenceAdapter {
  const sessions = new Map<string, InMemorySession>();
  const queue: QueuedMessage[] = [];

  const upsertSession = async (
    threadKey: string,
    data: Partial<Omit<InMemorySession, 'threadKey' | 'createdAt' | 'updatedAt'>>,
  ): Promise<void> => {
    const session = getOrCreateSession(sessions, threadKey);
    if (data.sessionId !== undefined) session.sessionId = data.sessionId;
    if (data.cost !== undefined) session.cost = data.cost;
    if (data.planPath !== undefined) session.planPath = data.planPath;
    if (data.metadata !== undefined) {
      session.metadata = { ...session.metadata, ...data.metadata };
    }
    session.updatedAt = now();
  };

  const adapter: MockPersistenceAdapter = {
    sessions,
    queue,

    upsertSession,

    isConnected: true,
    connect: jest.fn(async () => {}),
    close: jest.fn(async () => {}),

    onNotification: jest.fn((_handler: any) => {}),
    handleNotification: jest.fn((_method: string, _params: Record<string, unknown>) => {}),

    pull: jest.fn(async (_queueName: QueueName, threadKey: string) => {
      const messages = queue
        .filter((m) => m.threadKey === threadKey)
        .map((m) => ({
          id: m.id,
          queue: m.queue,
          threadKey: m.threadKey,
          status: 'pending' as const,
          payload: m.payload,
          createdAt: now(),
          updatedAt: now(),
        }));
      return messages;
    }),

    enqueue: jest.fn(async (queueName: QueueName, threadKey: string, message: Record<string, unknown>) => {
      const id = String(++messageIdCounter);
      queue.push({ id, queue: queueName, threadKey, payload: message });
      return id;
    }),

    ack: jest.fn(async (_queueName: QueueName, id: string) => {
      const idx = queue.findIndex((m) => m.id === id);
      if (idx !== -1) queue.splice(idx, 1);
    }),

    nack: jest.fn(async (_queueName: QueueName, _id: string) => {}),

    getSessionId: jest.fn(async (channel: string, threadTs: string) => {
      const threadKey = `${channel}:${threadTs}`;
      const session = sessions.get(threadKey);
      return session?.sessionId ?? null;
    }),

    setSessionId: jest.fn(async (channel: string, threadTs: string, sessionId: string) => {
      await upsertSession(`${channel}:${threadTs}`, { sessionId });
    }),

    addCost: jest.fn(async (channel: string, threadTs: string, costUsd: number) => {
      const threadKey = `${channel}:${threadTs}`;
      const session = getOrCreateSession(sessions, threadKey);
      session.cost = (session.cost ?? 0) + costUsd;
      session.updatedAt = now();
      return session.cost;
    }),

    getCost: jest.fn(async (channel: string, threadTs: string) => {
      const session = sessions.get(`${channel}:${threadTs}`);
      return session?.cost ?? 0;
    }),

    setPlanFilePath: jest.fn(async (channel: string, threadTs: string, path: string) => {
      await upsertSession(`${channel}:${threadTs}`, { planPath: path });
    }),

    getPlanFilePath: jest.fn(async (channel: string, threadTs: string) => {
      const session = sessions.get(`${channel}:${threadTs}`);
      return session?.planPath;
    }),

    setLogFile: jest.fn(async (channel: string, threadTs: string, path: string) => {
      const session = getOrCreateSession(sessions, `${channel}:${threadTs}`);
      session.metadata = { ...session.metadata, logFile: path };
      session.updatedAt = now();
    }),

    getLogFile: jest.fn(async (channel: string, threadTs: string) => {
      const session = sessions.get(`${channel}:${threadTs}`);
      return session?.metadata?.logFile as string | undefined;
    }),

    setFilesDir: jest.fn(async (channel: string, threadTs: string, dir: string) => {
      const session = getOrCreateSession(sessions, `${channel}:${threadTs}`);
      session.metadata = { ...session.metadata, filesDir: dir };
      session.updatedAt = now();
    }),

    getFilesDir: jest.fn(async (channel: string, threadTs: string) => {
      const session = sessions.get(`${channel}:${threadTs}`);
      return session?.metadata?.filesDir as string | undefined;
    }),

    getLatestForChannel: jest.fn(async (channel: string) => {
      const SESSION_TTL_MS = 4 * 60 * 60 * 1000;
      const nowMs = Date.now();
      let best: { threadTs: string; sessionId: string; updatedAt: number } | undefined;

      for (const session of sessions.values()) {
        if (!session.threadKey.startsWith(`${channel}:`)) continue;
        const updatedAt = new Date(session.updatedAt).getTime();
        if (nowMs - updatedAt > SESSION_TTL_MS) continue;
        if (!session.sessionId) continue;
        if (!best || updatedAt > best.updatedAt) {
          const threadTs = session.threadKey.slice(channel.length + 1);
          best = { threadTs, sessionId: session.sessionId, updatedAt };
        }
      }

      return best ? { threadTs: best.threadTs, sessionId: best.sessionId } : undefined;
    }),

    deleteSession: jest.fn(async (channel: string, threadTs: string) => {
      const threadKey = `${channel}:${threadTs}`;
      if (sessions.has(threadKey)) {
        sessions.delete(threadKey);
        return true;
      }
      return false;
    }),

    cleanup: jest.fn(async () => {}),
    startCleanupInterval: jest.fn(() => {}),
    stopCleanupInterval: jest.fn(() => {}),
  };

  return adapter;
}
