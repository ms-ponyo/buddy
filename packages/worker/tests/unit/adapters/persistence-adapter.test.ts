// tests/unit/adapters/persistence-adapter.test.ts
import { jest } from '@jest/globals';
import { PersistenceAdapter } from '../../../src/adapters/persistence-adapter.js';

describe('PersistenceAdapter', () => {
  let adapter: PersistenceAdapter;
  let mockClient: {
    call: jest.Mock;
    notify: jest.Mock;
    isConnected: boolean;
    connect: jest.Mock;
    close: jest.Mock;
  };
  let mockLogger: { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock };

  beforeEach(() => {
    mockClient = {
      call: jest.fn<() => Promise<unknown>>(),
      notify: jest.fn(),
      isConnected: true,
      connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    adapter = new PersistenceAdapter(mockClient as any, mockLogger as any);
  });

  afterEach(() => {
    adapter.stopCleanupInterval();
  });

  // ── Queue operations ──────────────────────────────────────────────

  describe('enqueue', () => {
    it('delegates to queue.enqueue RPC', async () => {
      mockClient.call.mockResolvedValue({ id: 'q1' });
      const result = await adapter.enqueue('outbound', 'C123:ts', { type: 'postMessage', text: 'hi' });
      expect(mockClient.call).toHaveBeenCalledWith('queue.enqueue', {
        queue: 'outbound',
        threadKey: 'C123:ts',
        message: { type: 'postMessage', text: 'hi' },
      });
      expect(result).toBe('q1');
    });
  });

  describe('ack', () => {
    it('delegates to queue.ack RPC', async () => {
      mockClient.call.mockResolvedValue(undefined);
      await adapter.ack('inbound', 'msg1');
      expect(mockClient.call).toHaveBeenCalledWith('queue.ack', { queue: 'inbound', id: 'msg1' });
    });
  });

  describe('nack', () => {
    it('delegates to queue.nack RPC', async () => {
      mockClient.call.mockResolvedValue(undefined);
      await adapter.nack('inbound', 'msg1');
      expect(mockClient.call).toHaveBeenCalledWith('queue.nack', { queue: 'inbound', id: 'msg1' });
    });
  });

  // ── Session operations ────────────────────────────────────────────

  describe('getSessionId', () => {
    it('returns sessionId when session exists', async () => {
      mockClient.call.mockResolvedValue({ session: { sessionId: 'sess1', cost: 0 } });
      const id = await adapter.getSessionId('C123', 'ts');
      expect(mockClient.call).toHaveBeenCalledWith('session.get', { threadKey: 'C123:ts' });
      expect(id).toBe('sess1');
    });

    it('returns null when no session', async () => {
      mockClient.call.mockResolvedValue({ session: null });
      const id = await adapter.getSessionId('C123', 'ts');
      expect(id).toBeNull();
    });

    it('returns null when session has no sessionId', async () => {
      mockClient.call.mockResolvedValue({ session: { cost: 0 } });
      const id = await adapter.getSessionId('C123', 'ts');
      expect(id).toBeNull();
    });
  });

  describe('setSessionId', () => {
    it('delegates to session.upsert RPC', async () => {
      mockClient.call.mockResolvedValue(undefined);
      await adapter.setSessionId('C123', 'ts', 'sess1');
      expect(mockClient.call).toHaveBeenCalledWith('session.upsert', {
        threadKey: 'C123:ts',
        data: { sessionId: 'sess1' },
      });
    });
  });

  describe('addCost', () => {
    it('does read-modify-write', async () => {
      mockClient.call
        .mockResolvedValueOnce({ session: { cost: 1.5 } })   // get
        .mockResolvedValueOnce(undefined);                      // upsert
      const newCost = await adapter.addCost('C123', 'ts', 0.5);
      expect(newCost).toBe(2.0);
      expect(mockClient.call).toHaveBeenNthCalledWith(1, 'session.get', { threadKey: 'C123:ts' });
      expect(mockClient.call).toHaveBeenNthCalledWith(2, 'session.upsert', {
        threadKey: 'C123:ts',
        data: { cost: 2.0 },
      });
    });

    it('starts from 0 when no session exists', async () => {
      mockClient.call
        .mockResolvedValueOnce({ session: null })
        .mockResolvedValueOnce(undefined);
      const newCost = await adapter.addCost('C123', 'ts', 0.3);
      expect(newCost).toBe(0.3);
    });
  });

  describe('getCost', () => {
    it('returns cost from session', async () => {
      mockClient.call.mockResolvedValue({ session: { cost: 2.5 } });
      const cost = await adapter.getCost('C123', 'ts');
      expect(cost).toBe(2.5);
    });

    it('returns 0 when no session', async () => {
      mockClient.call.mockResolvedValue({ session: null });
      const cost = await adapter.getCost('C123', 'ts');
      expect(cost).toBe(0);
    });
  });

  describe('setPlanFilePath / getPlanFilePath', () => {
    it('sets plan file path', async () => {
      mockClient.call.mockResolvedValue(undefined);
      await adapter.setPlanFilePath('C123', 'ts', '/tmp/plan.md');
      expect(mockClient.call).toHaveBeenCalledWith('session.upsert', {
        threadKey: 'C123:ts',
        data: { planPath: '/tmp/plan.md' },
      });
    });

    it('gets plan file path', async () => {
      mockClient.call.mockResolvedValue({ session: { planPath: '/tmp/plan.md', cost: 0 } });
      const path = await adapter.getPlanFilePath('C123', 'ts');
      expect(path).toBe('/tmp/plan.md');
    });

    it('returns undefined when no session', async () => {
      mockClient.call.mockResolvedValue({ session: null });
      const path = await adapter.getPlanFilePath('C123', 'ts');
      expect(path).toBeUndefined();
    });
  });

  describe('setLogFile / getLogFile', () => {
    it('sets log file via metadata', async () => {
      mockClient.call.mockResolvedValue(undefined);
      await adapter.setLogFile('C123', 'ts', '/tmp/log.txt');
      expect(mockClient.call).toHaveBeenCalledWith('session.upsert', {
        threadKey: 'C123:ts',
        data: { metadata: { logFile: '/tmp/log.txt' } },
      });
    });

    it('gets log file from metadata', async () => {
      mockClient.call.mockResolvedValue({ session: { cost: 0, metadata: { logFile: '/tmp/log.txt' } } });
      const path = await adapter.getLogFile('C123', 'ts');
      expect(path).toBe('/tmp/log.txt');
    });

    it('returns undefined when no metadata', async () => {
      mockClient.call.mockResolvedValue({ session: { cost: 0 } });
      const path = await adapter.getLogFile('C123', 'ts');
      expect(path).toBeUndefined();
    });
  });

  describe('setFilesDir / getFilesDir', () => {
    it('sets files dir via metadata', async () => {
      mockClient.call.mockResolvedValue(undefined);
      await adapter.setFilesDir('C123', 'ts', '/tmp/files');
      expect(mockClient.call).toHaveBeenCalledWith('session.upsert', {
        threadKey: 'C123:ts',
        data: { metadata: { filesDir: '/tmp/files' } },
      });
    });

    it('gets files dir from metadata', async () => {
      mockClient.call.mockResolvedValue({ session: { cost: 0, metadata: { filesDir: '/tmp/files' } } });
      const path = await adapter.getFilesDir('C123', 'ts');
      expect(path).toBe('/tmp/files');
    });
  });

  describe('getLatestForChannel', () => {
    it('returns most recent active session for channel', async () => {
      const now = new Date().toISOString();
      mockClient.call.mockResolvedValue({
        sessions: [
          { threadKey: 'C123:ts1', sessionId: 'sess1', cost: 0, updatedAt: new Date(Date.now() - 1000).toISOString() },
          { threadKey: 'C123:ts2', sessionId: 'sess2', cost: 0, updatedAt: now },
          { threadKey: 'C456:ts3', sessionId: 'sess3', cost: 0, updatedAt: now },
        ],
      });
      const result = await adapter.getLatestForChannel('C123');
      expect(result).toEqual({ threadTs: 'ts2', sessionId: 'sess2' });
    });

    it('returns undefined when no sessions for channel', async () => {
      mockClient.call.mockResolvedValue({ sessions: [] });
      const result = await adapter.getLatestForChannel('C123');
      expect(result).toBeUndefined();
    });

    it('excludes sessions past TTL', async () => {
      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
      mockClient.call.mockResolvedValue({
        sessions: [
          { threadKey: 'C123:ts1', sessionId: 'sess1', cost: 0, updatedAt: fiveHoursAgo },
        ],
      });
      const result = await adapter.getLatestForChannel('C123');
      expect(result).toBeUndefined();
    });
  });

  describe('deleteSession', () => {
    it('cleans up filesDir and deletes session', async () => {
      mockClient.call
        .mockResolvedValueOnce({ session: { threadKey: 'C123:ts', cost: 0, metadata: { filesDir: '/tmp/files' } } })
        .mockResolvedValueOnce(undefined); // delete
      const result = await adapter.deleteSession('C123', 'ts');
      expect(result).toBe(true);
      expect(mockClient.call).toHaveBeenCalledWith('session.delete', { threadKey: 'C123:ts' });
    });

    it('returns false when delete throws', async () => {
      mockClient.call
        .mockResolvedValueOnce({ session: null })
        .mockRejectedValueOnce(new Error('fail'));
      const result = await adapter.deleteSession('C123', 'ts');
      expect(result).toBe(false);
    });
  });

  // ── Cleanup ───────────────────────────────────────────────────────

  describe('cleanup', () => {
    it('removes filesDir for sessions past TTL', async () => {
      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
      const recent = new Date().toISOString();
      mockClient.call.mockResolvedValue({
        sessions: [
          { threadKey: 'C123:ts1', cost: 0, metadata: { filesDir: '/tmp/old' }, updatedAt: fiveHoursAgo },
          { threadKey: 'C123:ts2', cost: 0, metadata: { filesDir: '/tmp/new' }, updatedAt: recent },
        ],
      });
      await adapter.cleanup();
      // Should only upsert the stale session to clear filesDir
      expect(mockClient.call).toHaveBeenCalledWith('session.upsert', {
        threadKey: 'C123:ts1',
        data: { metadata: { filesDir: undefined } },
      });
      // Should NOT clear the recent one
      const upsertCalls = mockClient.call.mock.calls.filter(
        (c) => c[0] === 'session.upsert',
      );
      expect(upsertCalls).toHaveLength(1);
    });

    it('skips sessions without filesDir', async () => {
      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
      mockClient.call.mockResolvedValue({
        sessions: [
          { threadKey: 'C123:ts1', cost: 0, updatedAt: fiveHoursAgo },
        ],
      });
      await adapter.cleanup();
      // Only the list call, no upsert
      expect(mockClient.call).toHaveBeenCalledTimes(1);
    });
  });

  describe('startCleanupInterval / stopCleanupInterval', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('starts periodic cleanup', () => {
      mockClient.call.mockResolvedValue({ sessions: [] });
      adapter.startCleanupInterval();
      // Advance 30 minutes
      jest.advanceTimersByTime(30 * 60 * 1000);
      expect(mockClient.call).toHaveBeenCalledWith('session.list', {});
    });

    it('stopCleanupInterval stops the timer', () => {
      mockClient.call.mockResolvedValue({ sessions: [] });
      adapter.startCleanupInterval();
      adapter.stopCleanupInterval();
      jest.advanceTimersByTime(30 * 60 * 1000);
      expect(mockClient.call).not.toHaveBeenCalled();
    });
  });

  // ── Connect with retry ────────────────────────────────────────────

  describe('connect', () => {
    it('connects on first attempt', async () => {
      mockClient.connect.mockResolvedValue(undefined);
      await adapter.connect();
      expect(mockClient.connect).toHaveBeenCalledTimes(1);
    });

    it('retries with exponential backoff on failure', async () => {
      jest.useFakeTimers();
      mockClient.connect
        .mockRejectedValueOnce(new Error('fail1'))
        .mockRejectedValueOnce(new Error('fail2'))
        .mockResolvedValueOnce(undefined);

      const connectPromise = adapter.connect();

      // First retry after 500ms
      await jest.advanceTimersByTimeAsync(500);
      // Second retry after 1000ms
      await jest.advanceTimersByTimeAsync(1000);

      await connectPromise;
      expect(mockClient.connect).toHaveBeenCalledTimes(3);
      jest.useRealTimers();
    });

    it('gives up after max retries', async () => {
      jest.useFakeTimers();
      const connectError = new Error('fail');
      mockClient.connect.mockRejectedValue(connectError);

      const connectPromise = adapter.connect().catch((e: Error) => e);

      // Advance through all retries (500, 1000, 2000, 4000, 5000, 5000, 5000, 5000, 5000, 5000)
      for (let i = 0; i < 10; i++) {
        await jest.advanceTimersByTimeAsync(5000);
      }

      const result = await connectPromise;
      expect(result).toBeInstanceOf(Error);
      // 1 initial + 10 retries = 11 total
      expect(mockClient.connect).toHaveBeenCalledTimes(11);
      jest.useRealTimers();
    });
  });

  // ── close ─────────────────────────────────────────────────────────

  describe('close', () => {
    it('stops cleanup interval and closes client', async () => {
      adapter.startCleanupInterval();
      await adapter.close();
      expect(mockClient.close).toHaveBeenCalledTimes(1);
    });
  });

  // ── isConnected ───────────────────────────────────────────────────

  describe('isConnected', () => {
    it('delegates to client.isConnected', () => {
      expect(adapter.isConnected).toBe(true);
      mockClient.isConnected = false;
      expect(adapter.isConnected).toBe(false);
    });
  });
});
