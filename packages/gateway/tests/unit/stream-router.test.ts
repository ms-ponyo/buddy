import { jest } from '@jest/globals';
import type { StreamMessage } from '@buddy/shared';
import type { StreamFactoryResult, StreamerHandle } from '../../src/stream-buffer.js';
import type { StreamRouterDeps } from '../../src/stream-router.js';

// Dynamically import (ESM)
let StreamRouter: typeof import('../../src/stream-router.js').StreamRouter;

beforeAll(async () => {
  const mod = await import('../../src/stream-router.js');
  StreamRouter = mod.StreamRouter;
});

// ── Helpers ──────────────────────────────────────────────────────────

function mockStreamer(): StreamerHandle & {
  appendCalls: Array<{ chunks: unknown[] }>;
  stopCalls: Array<Record<string, unknown> | undefined>;
} {
  const handle = {
    appendCalls: [] as Array<{ chunks: unknown[] }>,
    stopCalls: [] as Array<Record<string, unknown> | undefined>,
    append: jest.fn<StreamerHandle['append']>(async (payload) => {
      handle.appendCalls.push(payload);
      return { ts: '1234.5678' };
    }),
    stop: jest.fn<StreamerHandle['stop']>(async (_finalPlan?) => {}),
  };
  return handle;
}

function createDeps(overrides: Partial<StreamRouterDeps> = {}): StreamRouterDeps & {
  createStreamMock: jest.Mock<(channel: string, threadTs: string, userId: string, streamType: string) => Promise<StreamFactoryResult>>;
  deleteMessageMock: jest.Mock<(channel: string, ts: string) => Promise<void>>;
  rateLimitAcquireMock: jest.Mock<() => Promise<void>>;
} {
  const createStreamMock = jest.fn<(channel: string, threadTs: string, userId: string, streamType: string) => Promise<StreamFactoryResult>>()
    .mockImplementation(async () => {
      const streamer = mockStreamer();
      return { streamer, ts: `ts-${Date.now()}` };
    });
  const deleteMessageMock = jest.fn<(channel: string, ts: string) => Promise<void>>().mockResolvedValue(undefined);
  const rateLimitAcquireMock = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

  const deps: StreamRouterDeps = {
    createStream: overrides.createStream ?? createStreamMock,
    rateLimitAcquire: overrides.rateLimitAcquire ?? rateLimitAcquireMock,
    deleteMessage: overrides.deleteMessage ?? deleteMessageMock,
    logger: overrides.logger ?? {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    },
  };

  return {
    ...deps,
    createStreamMock: (deps.createStream === createStreamMock) ? createStreamMock : overrides.createStream as any,
    deleteMessageMock: (deps.deleteMessage === deleteMessageMock) ? deleteMessageMock : overrides.deleteMessage as any,
    rateLimitAcquireMock: (deps.rateLimitAcquire === rateLimitAcquireMock) ? rateLimitAcquireMock : overrides.rateLimitAcquire as any,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('StreamRouter', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  // 1. stream_start caches thread info
  describe('stream_start', () => {
    it('caches thread info (channel + userId)', async () => {
      const deps = createDeps();
      const router = new StreamRouter(deps);

      const msg: StreamMessage = {
        type: 'stream_start',
        channel: 'C123',
        threadTs: '111.222',
        userId: 'U456',
      };
      await router.handle(msg);

      // No StreamBuffer should be created yet — just cached thread info
      expect(deps.createStreamMock).not.toHaveBeenCalled();

      router.close();
    });
  });

  // 2. First stream_chunk creates StreamBuffer (implicit start)
  describe('stream_chunk — implicit start', () => {
    it('creates a StreamBuffer on first chunk, calls deps.createStream', async () => {
      const deps = createDeps();
      const router = new StreamRouter(deps);

      const msg: StreamMessage = {
        type: 'stream_chunk',
        channel: 'C123',
        threadTs: '111.222',
        userId: 'U456',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 't1', title: 'Hello', status: 'in_progress' }],
      };
      await router.handle(msg);

      expect(deps.createStreamMock).toHaveBeenCalledTimes(1);
      expect(deps.createStreamMock).toHaveBeenCalledWith('C123', '111.222', 'U456', 'main');

      router.close();
    });
  });

  // 3. Second stream_chunk routes to existing StreamBuffer
  describe('stream_chunk — existing buffer', () => {
    it('routes to existing StreamBuffer without calling createStream again', async () => {
      const deps = createDeps();
      const router = new StreamRouter(deps);

      const msg1: StreamMessage = {
        type: 'stream_chunk',
        channel: 'C123',
        threadTs: '111.222',
        userId: 'U456',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 't1', title: 'First', status: 'in_progress' }],
      };
      await router.handle(msg1);

      const msg2: StreamMessage = {
        type: 'stream_chunk',
        channel: 'C123',
        threadTs: '111.222',
        userId: 'U456',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 't2', title: 'Second', status: 'in_progress' }],
      };
      await router.handle(msg2);

      // createStream should have been called only once
      expect(deps.createStreamMock).toHaveBeenCalledTimes(1);

      router.close();
    });
  });

  // 4. Multiple stream types per thread create separate StreamBuffers
  describe('stream_chunk — multiple stream types', () => {
    it('creates separate StreamBuffers for different stream types', async () => {
      const deps = createDeps();
      const router = new StreamRouter(deps);

      const msgMain: StreamMessage = {
        type: 'stream_chunk',
        channel: 'C123',
        threadTs: '111.222',
        userId: 'U456',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 'm1', title: 'Main', status: 'in_progress' }],
      };
      await router.handle(msgMain);

      const msgTodo: StreamMessage = {
        type: 'stream_chunk',
        channel: 'C123',
        threadTs: '111.222',
        userId: 'U456',
        streamType: 'todo',
        chunks: [{ type: 'task_update', id: 'd1', title: 'Todo', status: 'in_progress' }],
      };
      await router.handle(msgTodo);

      // createStream should have been called twice (once per stream type)
      expect(deps.createStreamMock).toHaveBeenCalledTimes(2);

      router.close();
    });
  });

  // 5. stream_stop stops all streams for thread, cleans up state
  describe('stream_stop', () => {
    it('stops all streams for the thread and cleans up state', async () => {
      const streamer = mockStreamer();
      const deps = createDeps({
        createStream: jest.fn<(channel: string, threadTs: string, userId: string, streamType: string) => Promise<StreamFactoryResult>>()
          .mockResolvedValue({ streamer, ts: 'ts-stop-test' }),
      });
      const router = new StreamRouter(deps);

      // Start a stream
      const chunk: StreamMessage = {
        type: 'stream_chunk',
        channel: 'C123',
        threadTs: '111.222',
        userId: 'U456',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 's1', title: 'Work', status: 'in_progress' }],
      };
      await router.handle(chunk);

      // Stop all streams for the thread
      const stop: StreamMessage = {
        type: 'stream_stop',
        channel: 'C123',
        threadTs: '111.222',
      };
      await router.handle(stop);

      // Streamer.stop should have been called
      expect(streamer.stop).toHaveBeenCalled();

      router.close();
    });
  });

  // 6. After stream_stop, new stream_chunk creates fresh StreamBuffer
  describe('stream_stop then new chunk', () => {
    it('creates a fresh StreamBuffer after stop', async () => {
      const deps = createDeps();
      const router = new StreamRouter(deps);

      // First chunk
      const chunk1: StreamMessage = {
        type: 'stream_chunk',
        channel: 'C123',
        threadTs: '111.222',
        userId: 'U456',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 'r1', title: 'First run', status: 'in_progress' }],
      };
      await router.handle(chunk1);
      expect(deps.createStreamMock).toHaveBeenCalledTimes(1);

      // Stop
      const stop: StreamMessage = {
        type: 'stream_stop',
        channel: 'C123',
        threadTs: '111.222',
      };
      await router.handle(stop);

      // New chunk after stop should create a new StreamBuffer
      const chunk2: StreamMessage = {
        type: 'stream_chunk',
        channel: 'C123',
        threadTs: '111.222',
        userId: 'U456',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 'r2', title: 'Second run', status: 'in_progress' }],
      };
      await router.handle(chunk2);
      expect(deps.createStreamMock).toHaveBeenCalledTimes(2);

      router.close();
    });
  });

  // 7. stream_pause stops all streams but future chunks would create new ones
  describe('stream_pause', () => {
    it('stops all streams but allows future chunks to create new buffers', async () => {
      const streamer = mockStreamer();
      const callCount = { n: 0 };
      const createStream = jest.fn<(channel: string, threadTs: string, userId: string, streamType: string) => Promise<StreamFactoryResult>>()
        .mockImplementation(async () => {
          callCount.n++;
          if (callCount.n === 1) return { streamer, ts: 'ts-pause-1' };
          return { streamer: mockStreamer(), ts: 'ts-pause-2' };
        });
      const deps = createDeps({ createStream });
      const router = new StreamRouter(deps);

      // Start a stream
      const chunk: StreamMessage = {
        type: 'stream_chunk',
        channel: 'C123',
        threadTs: '111.222',
        userId: 'U456',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 'p1', title: 'Before pause', status: 'in_progress' }],
      };
      await router.handle(chunk);

      // Pause
      const pause: StreamMessage = {
        type: 'stream_pause',
        channel: 'C123',
        threadTs: '111.222',
      };
      await router.handle(pause);

      expect(streamer.stop).toHaveBeenCalled();

      // New chunk after pause should create a new StreamBuffer
      const chunk2: StreamMessage = {
        type: 'stream_chunk',
        channel: 'C123',
        threadTs: '111.222',
        userId: 'U456',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 'p2', title: 'After pause', status: 'in_progress' }],
      };
      await router.handle(chunk2);
      expect(createStream).toHaveBeenCalledTimes(2);

      router.close();
    });
  });

  // 8. Delete empty stream messages on stop
  describe('delete empty stream on stop', () => {
    it('calls deleteMessage when hadMeaningfulContent is false', async () => {
      const streamer = mockStreamer();
      // Make append not return meaningful content (no task_updates)
      streamer.append.mockResolvedValue({ ts: 'ts-empty' });

      const deps = createDeps({
        createStream: jest.fn<(channel: string, threadTs: string, userId: string, streamType: string) => Promise<StreamFactoryResult>>()
          .mockResolvedValue({ streamer, ts: 'ts-empty' }),
      });
      const router = new StreamRouter(deps);

      // Send a chunk with only a plan_update (no task_update, so no meaningful content)
      const chunk: StreamMessage = {
        type: 'stream_chunk',
        channel: 'C123',
        threadTs: '111.222',
        userId: 'U456',
        streamType: 'main',
        chunks: [{ type: 'plan_update', title: 'Working' }],
      };
      await router.handle(chunk);

      // Stop — since hadMeaningfulContent is false, should delete
      const stop: StreamMessage = {
        type: 'stream_stop',
        channel: 'C123',
        threadTs: '111.222',
      };
      await router.handle(stop);

      expect(deps.deleteMessageMock).toHaveBeenCalledWith('C123', 'ts-empty');

      router.close();
    });

    it('does NOT call deleteMessage when hadMeaningfulContent is true', async () => {
      const streamer = mockStreamer();
      streamer.append.mockResolvedValue({ ts: 'ts-real' });

      const deps = createDeps({
        createStream: jest.fn<(channel: string, threadTs: string, userId: string, streamType: string) => Promise<StreamFactoryResult>>()
          .mockResolvedValue({ streamer, ts: 'ts-real' }),
      });
      const router = new StreamRouter(deps);

      // Send a chunk with real content
      const chunk: StreamMessage = {
        type: 'stream_chunk',
        channel: 'C123',
        threadTs: '111.222',
        userId: 'U456',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 'real-1', title: 'Real work', status: 'in_progress' }],
      };
      await router.handle(chunk);

      // Stop — since hadMeaningfulContent is true, should NOT delete
      const stop: StreamMessage = {
        type: 'stream_stop',
        channel: 'C123',
        threadTs: '111.222',
      };
      await router.handle(stop);

      expect(deps.deleteMessageMock).not.toHaveBeenCalled();

      router.close();
    });
  });

  // 9. close() cleans up all state and rotation interval
  describe('close()', () => {
    it('cleans up all state and stops the rotation interval', async () => {
      jest.useFakeTimers();

      const streamer = mockStreamer();
      const deps = createDeps({
        createStream: jest.fn<(channel: string, threadTs: string, userId: string, streamType: string) => Promise<StreamFactoryResult>>()
          .mockResolvedValue({ streamer, ts: 'ts-close-test' }),
      });
      const router = new StreamRouter(deps);

      // Create a stream
      const chunk: StreamMessage = {
        type: 'stream_chunk',
        channel: 'C123',
        threadTs: '111.222',
        userId: 'U456',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 'c1', title: 'Close test', status: 'in_progress' }],
      };
      await router.handle(chunk);

      // Close the router
      router.close();

      // Streamer should have been stopped
      expect(streamer.stop).toHaveBeenCalled();

      jest.useRealTimers();
    });

    it('handles stop errors gracefully during close', async () => {
      const streamer = mockStreamer();
      const deps = createDeps({
        createStream: jest.fn<(channel: string, threadTs: string, userId: string, streamType: string) => Promise<StreamFactoryResult>>()
          .mockResolvedValue({ streamer, ts: 'ts-close-err' }),
      });
      const router = new StreamRouter(deps);

      // Create a stream
      await router.handle({
        type: 'stream_chunk',
        channel: 'C123',
        threadTs: '111.222',
        userId: 'U456',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 'ce1', title: 'Close error', status: 'in_progress' }],
      } satisfies StreamMessage);

      // Replace buffer.stop() with a throwing implementation to trigger the catch in close()
      const buffer = (router as any).streams.get('111.222')?.get('main');
      const originalStop = buffer.stop.bind(buffer);
      buffer.stop = async () => { throw new Error('stop failed during close'); };

      // close() should not throw even if buffer.stop() rejects
      expect(() => router.close()).not.toThrow();

      // Wait for async stop to settle
      await new Promise((r) => setTimeout(r, 50));
      expect((deps.logger as any).error).toHaveBeenCalledWith(
        'error stopping stream during close',
        expect.objectContaining({ threadTs: '111.222' }),
      );
    });
  });

  // 10. stream_stop on non-existent thread with cleanup
  describe('stream_stop on empty thread', () => {
    it('cleans up threadInfo when stopping a thread with no active streams', async () => {
      const deps = createDeps();
      const router = new StreamRouter(deps);

      // Cache thread info via stream_start
      await router.handle({
        type: 'stream_start',
        channel: 'C-empty',
        threadTs: 'T-empty',
        userId: 'U-empty',
      } satisfies StreamMessage);

      // Verify thread info is cached
      expect((router as any).threadInfo.has('T-empty')).toBe(true);

      // stream_stop with no active streams — should clean up threadInfo
      await router.handle({
        type: 'stream_stop',
        channel: 'C-empty',
        threadTs: 'T-empty',
      } satisfies StreamMessage);

      expect((router as any).threadInfo.has('T-empty')).toBe(false);

      router.close();
    });

    it('is safe to stop a thread that was never started', async () => {
      const deps = createDeps();
      const router = new StreamRouter(deps);

      // Stop a thread that was never started — should not throw
      await router.handle({
        type: 'stream_stop',
        channel: 'C-never',
        threadTs: 'T-never',
      } satisfies StreamMessage);

      expect(deps.createStreamMock).not.toHaveBeenCalled();

      router.close();
    });
  });

  // 11. buffer.stop() throwing during stopAllForThread
  describe('stop error handling in stopAllForThread', () => {
    it('logs error when buffer.stop() throws and continues', async () => {
      const streamer = mockStreamer();
      const deps = createDeps({
        createStream: jest.fn<(channel: string, threadTs: string, userId: string, streamType: string) => Promise<StreamFactoryResult>>()
          .mockResolvedValue({ streamer, ts: 'ts-stop-err' }),
      });
      const router = new StreamRouter(deps);

      // Create a stream
      await router.handle({
        type: 'stream_chunk',
        channel: 'C-se',
        threadTs: 'T-se',
        userId: 'U-se',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 'se1', title: 'Stop error', status: 'in_progress' }],
      } satisfies StreamMessage);

      // Replace buffer.stop() with a throwing impl to trigger the router's catch
      const buffer = (router as any).streams.get('T-se')?.get('main');
      buffer.stop = async () => { throw new Error('stop_failed'); };

      // stream_stop — buffer.stop() will throw, but should be caught
      await router.handle({
        type: 'stream_stop',
        channel: 'C-se',
        threadTs: 'T-se',
      } satisfies StreamMessage);

      expect((deps.logger as any).error).toHaveBeenCalledWith(
        'error stopping stream',
        expect.objectContaining({ threadTs: 'T-se', streamType: 'main' }),
      );

      // Thread should still be cleaned up despite error
      expect((router as any).streams.has('T-se')).toBe(false);

      router.close();
    });
  });

  // 12. deleteMessage failure during stop
  describe('deleteMessage failure', () => {
    it('logs warning when deleteMessage throws on empty stream cleanup', async () => {
      const streamer = mockStreamer();
      const deleteMessageMock = jest.fn<(channel: string, ts: string) => Promise<void>>()
        .mockRejectedValue(new Error('delete_failed'));
      const deps = createDeps({
        createStream: jest.fn<(channel: string, threadTs: string, userId: string, streamType: string) => Promise<StreamFactoryResult>>()
          .mockResolvedValue({ streamer, ts: 'ts-del-err' }),
        deleteMessage: deleteMessageMock,
      });
      const router = new StreamRouter(deps);

      // Create a stream with only non-meaningful content (plan_update)
      await router.handle({
        type: 'stream_chunk',
        channel: 'C-del',
        threadTs: 'T-del',
        userId: 'U-del',
        streamType: 'main',
        chunks: [{ type: 'plan_update', title: 'Working' }],
      } satisfies StreamMessage);

      // stream_stop — should try to delete but handle failure
      await router.handle({
        type: 'stream_stop',
        channel: 'C-del',
        threadTs: 'T-del',
      } satisfies StreamMessage);

      // slackTs is '1234.5678' from the mock streamer's append return value (updates during drain)
      expect(deleteMessageMock).toHaveBeenCalledWith('C-del', '1234.5678');
      expect((deps.logger as any).warn).toHaveBeenCalledWith(
        'failed to delete empty stream message',
        expect.objectContaining({ threadTs: 'T-del' }),
      );

      router.close();
    });
  });

  // 13. onError callback propagation from StreamBuffer
  describe('onError propagation', () => {
    it('StreamBuffer onError calls logger.error on the router', async () => {
      const streamer = mockStreamer();
      // First append succeeds (creates buffer), second fails with non-recoverable error
      streamer.append
        .mockResolvedValueOnce({ ts: '1234.5678' })
        .mockRejectedValueOnce(new Error('unexpected_slack_error'));

      const deps = createDeps({
        createStream: jest.fn<(channel: string, threadTs: string, userId: string, streamType: string) => Promise<StreamFactoryResult>>()
          .mockResolvedValue({ streamer, ts: 'ts-onerr' }),
      });
      const router = new StreamRouter(deps);

      // First chunk — creates buffer
      await router.handle({
        type: 'stream_chunk',
        channel: 'C-oe',
        threadTs: 'T-oe',
        userId: 'U-oe',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 'oe1', title: 'First', status: 'in_progress' }],
      } satisfies StreamMessage);

      // Second chunk — triggers the non-recoverable error
      await router.handle({
        type: 'stream_chunk',
        channel: 'C-oe',
        threadTs: 'T-oe',
        userId: 'U-oe',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 'oe2', title: 'Error', status: 'in_progress' }],
      } satisfies StreamMessage);

      expect((deps.logger as any).error).toHaveBeenCalledWith(
        'StreamBuffer error',
        expect.objectContaining({
          error: 'unexpected_slack_error',
          context: expect.stringContaining('drain'),
          threadTs: 'T-oe',
          streamType: 'main',
        }),
      );

      router.close();
    });
  });

  // 14. Rotation interval fires checkAllRotations
  describe('rotation interval', () => {
    it('calls checkRotation on active buffers when interval fires', async () => {
      const streamer = mockStreamer();
      const deps = createDeps({
        createStream: jest.fn<(channel: string, threadTs: string, userId: string, streamType: string) => Promise<StreamFactoryResult>>()
          .mockResolvedValue({ streamer, ts: 'ts-rot' }),
      });
      const router = new StreamRouter(deps);

      // Create a stream
      await router.handle({
        type: 'stream_chunk',
        channel: 'C-rot',
        threadTs: 'T-rot',
        userId: 'U-rot',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 'rot1', title: 'Rot test', status: 'in_progress' }],
      } satisfies StreamMessage);

      // Directly invoke checkAllRotations (private, but accessible for testing)
      // after making the buffer due for rotation
      const buffer = (router as any).streams.get('T-rot')?.get('main');
      (buffer as any).createdAt = Date.now() - 5 * 60 * 1000;

      // Call checkAllRotations directly (simulates what the interval does)
      (router as any).checkAllRotations();

      // Wait for async rotation to settle
      await new Promise((r) => setTimeout(r, 50));

      // Buffer should have had checkRotation called, which triggers a transparent restart
      // (createdAt gets reset on restart)
      expect((buffer as any).createdAt).toBeGreaterThan(Date.now() - 1000);

      router.close();
    });

    it('handles rotation check errors gracefully', async () => {
      const streamer = mockStreamer();
      const deps = createDeps({
        createStream: jest.fn<(channel: string, threadTs: string, userId: string, streamType: string) => Promise<StreamFactoryResult>>()
          .mockResolvedValue({ streamer, ts: 'ts-rot-err' }),
      });
      const router = new StreamRouter(deps);

      // Create a stream
      await router.handle({
        type: 'stream_chunk',
        channel: 'C-re',
        threadTs: 'T-re',
        userId: 'U-re',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 're1', title: 'RotErr', status: 'in_progress' }],
      } satisfies StreamMessage);

      // Replace buffer.checkRotation with a throwing impl
      const buffer = (router as any).streams.get('T-re')?.get('main');
      buffer.checkRotation = async () => { throw new Error('rotation_failed'); };

      // Call checkAllRotations directly — should catch the error
      (router as any).checkAllRotations();

      // Wait for async error handling to settle
      await new Promise((r) => setTimeout(r, 50));

      expect((deps.logger as any).error).toHaveBeenCalledWith(
        'rotation check failed',
        expect.objectContaining({ error: 'rotation_failed' }),
      );

      router.close();
    });
  });

  // 15. stream_pause cleans up streams but preserves threadInfo
  describe('stream_pause preserves threadInfo', () => {
    it('preserves threadInfo after pause (unlike stream_stop)', async () => {
      const deps = createDeps();
      const router = new StreamRouter(deps);

      // Cache thread info
      await router.handle({
        type: 'stream_start',
        channel: 'C-pi',
        threadTs: 'T-pi',
        userId: 'U-pi',
      } satisfies StreamMessage);

      // Create a stream
      await router.handle({
        type: 'stream_chunk',
        channel: 'C-pi',
        threadTs: 'T-pi',
        userId: 'U-pi',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 'pi1', title: 'Pause info', status: 'in_progress' }],
      } satisfies StreamMessage);

      // Pause — should stop streams but keep threadInfo
      await router.handle({
        type: 'stream_pause',
        channel: 'C-pi',
        threadTs: 'T-pi',
      } satisfies StreamMessage);

      // threadInfo preserved
      expect((router as any).threadInfo.has('T-pi')).toBe(true);
      // streams cleaned up
      expect((router as any).streams.has('T-pi')).toBe(false);

      router.close();
    });
  });

  // 16. Selective stream_stop — only stops specified stream types
  describe('selective stream_stop', () => {
    it('stops only the specified streamTypes, leaves others alive', async () => {
      const mainStreamer = mockStreamer();
      const todoStreamer = mockStreamer();
      let callCount = 0;
      const createStream = jest.fn<(channel: string, threadTs: string, userId: string, streamType: string) => Promise<StreamFactoryResult>>()
        .mockImplementation(async (_ch, _ts, _uid, st) => {
          callCount++;
          if (st === 'main') return { streamer: mainStreamer, ts: 'ts-main' };
          return { streamer: todoStreamer, ts: 'ts-todo' };
        });
      const deps = createDeps({ createStream });
      const router = new StreamRouter(deps);

      // Create main and todo streams
      await router.handle({
        type: 'stream_chunk', channel: 'C1', threadTs: 'T1', userId: 'U1',
        streamType: 'main', chunks: [{ type: 'task_update', id: 'm1', title: 'Main', status: 'in_progress' }],
      } satisfies StreamMessage);
      await router.handle({
        type: 'stream_chunk', channel: 'C1', threadTs: 'T1', userId: 'U1',
        streamType: 'todo', chunks: [{ type: 'task_update', id: 't1', title: 'Todo', status: 'in_progress' }],
      } satisfies StreamMessage);

      // Selective stop — only main
      await router.handle({
        type: 'stream_stop', channel: 'C1', threadTs: 'T1', streamTypes: ['main'],
      } as StreamMessage);

      // main stopped, todo untouched
      expect(mainStreamer.stop).toHaveBeenCalled();
      expect(todoStreamer.stop).not.toHaveBeenCalled();

      // Thread-level maps still exist (todo is alive)
      expect((router as any).streams.has('T1')).toBe(true);
      expect((router as any).streams.get('T1').has('todo')).toBe(true);
      expect((router as any).streams.get('T1').has('main')).toBe(false);

      // threadInfo preserved
      expect((router as any).threadInfo.has('T1')).toBe(true);

      router.close();
    });
  });

  // 17. Unfiltered stream_stop still stops everything (backward compat)
  describe('unfiltered stream_stop backward compat', () => {
    it('stops all streams when streamTypes is omitted', async () => {
      const mainStreamer = mockStreamer();
      const todoStreamer = mockStreamer();
      const createStream = jest.fn<(channel: string, threadTs: string, userId: string, streamType: string) => Promise<StreamFactoryResult>>()
        .mockImplementation(async (_ch, _ts, _uid, st) => {
          if (st === 'main') return { streamer: mainStreamer, ts: 'ts-main' };
          return { streamer: todoStreamer, ts: 'ts-todo' };
        });
      const deps = createDeps({ createStream });
      const router = new StreamRouter(deps);

      await router.handle({
        type: 'stream_chunk', channel: 'C1', threadTs: 'T1', userId: 'U1',
        streamType: 'main', chunks: [{ type: 'task_update', id: 'm1', title: 'M', status: 'in_progress' }],
      } satisfies StreamMessage);
      await router.handle({
        type: 'stream_chunk', channel: 'C1', threadTs: 'T1', userId: 'U1',
        streamType: 'todo', chunks: [{ type: 'task_update', id: 't1', title: 'T', status: 'in_progress' }],
      } satisfies StreamMessage);

      // Unfiltered stop
      await router.handle({
        type: 'stream_stop', channel: 'C1', threadTs: 'T1',
      } satisfies StreamMessage);

      expect(mainStreamer.stop).toHaveBeenCalled();
      expect(todoStreamer.stop).toHaveBeenCalled();
      expect((router as any).streams.has('T1')).toBe(false);
      expect((router as any).threadInfo.has('T1')).toBe(false);

      router.close();
    });
  });

  // 18. Selective stream_pause
  describe('selective stream_pause', () => {
    it('pauses only the specified streamTypes', async () => {
      const mainStreamer = mockStreamer();
      const todoStreamer = mockStreamer();
      const createStream = jest.fn<(channel: string, threadTs: string, userId: string, streamType: string) => Promise<StreamFactoryResult>>()
        .mockImplementation(async (_ch, _ts, _uid, st) => {
          if (st === 'main') return { streamer: mainStreamer, ts: 'ts-main' };
          return { streamer: todoStreamer, ts: 'ts-todo' };
        });
      const deps = createDeps({ createStream });
      const router = new StreamRouter(deps);

      await router.handle({
        type: 'stream_chunk', channel: 'C1', threadTs: 'T1', userId: 'U1',
        streamType: 'main', chunks: [{ type: 'task_update', id: 'm1', title: 'M', status: 'in_progress' }],
      } satisfies StreamMessage);
      await router.handle({
        type: 'stream_chunk', channel: 'C1', threadTs: 'T1', userId: 'U1',
        streamType: 'todo', chunks: [{ type: 'task_update', id: 't1', title: 'T', status: 'in_progress' }],
      } satisfies StreamMessage);

      // Selective pause — only main
      await router.handle({
        type: 'stream_pause', channel: 'C1', threadTs: 'T1', streamTypes: ['main'],
      } as StreamMessage);

      expect(mainStreamer.stop).toHaveBeenCalled();
      expect(todoStreamer.stop).not.toHaveBeenCalled();

      // threadInfo preserved (pause never deletes it)
      expect((router as any).threadInfo.has('T1')).toBe(true);

      router.close();
    });
  });

  // 19. Sequential selective stops
  describe('sequential selective stops', () => {
    it('stops main first, then todo — full cleanup after both', async () => {
      const mainStreamer = mockStreamer();
      const todoStreamer = mockStreamer();
      const createStream = jest.fn<(channel: string, threadTs: string, userId: string, streamType: string) => Promise<StreamFactoryResult>>()
        .mockImplementation(async (_ch, _ts, _uid, st) => {
          if (st === 'main') return { streamer: mainStreamer, ts: 'ts-main' };
          return { streamer: todoStreamer, ts: 'ts-todo' };
        });
      const deps = createDeps({ createStream });
      const router = new StreamRouter(deps);

      await router.handle({
        type: 'stream_chunk', channel: 'C1', threadTs: 'T1', userId: 'U1',
        streamType: 'main', chunks: [{ type: 'task_update', id: 'm1', title: 'M', status: 'in_progress' }],
      } satisfies StreamMessage);
      await router.handle({
        type: 'stream_chunk', channel: 'C1', threadTs: 'T1', userId: 'U1',
        streamType: 'todo', chunks: [{ type: 'task_update', id: 't1', title: 'T', status: 'in_progress' }],
      } satisfies StreamMessage);

      // Stop main only
      await router.handle({
        type: 'stream_stop', channel: 'C1', threadTs: 'T1', streamTypes: ['main'],
      } as StreamMessage);
      expect((router as any).streams.has('T1')).toBe(true); // todo still alive

      // Stop todo
      await router.handle({
        type: 'stream_stop', channel: 'C1', threadTs: 'T1', streamTypes: ['todo'],
      } as StreamMessage);

      // Now everything is cleaned up
      expect((router as any).streams.has('T1')).toBe(false);
      expect((router as any).threadInfo.has('T1')).toBe(false);

      router.close();
    });
  });

  // 20. Selective stop for non-existent type is a no-op
  describe('selective stop for non-existent type', () => {
    it('does nothing when the target streamType has no buffer', async () => {
      const todoStreamer = mockStreamer();
      const createStream = jest.fn<(channel: string, threadTs: string, userId: string, streamType: string) => Promise<StreamFactoryResult>>()
        .mockResolvedValue({ streamer: todoStreamer, ts: 'ts-todo' });
      const deps = createDeps({ createStream });
      const router = new StreamRouter(deps);

      // Only create a todo stream
      await router.handle({
        type: 'stream_chunk', channel: 'C1', threadTs: 'T1', userId: 'U1',
        streamType: 'todo', chunks: [{ type: 'task_update', id: 't1', title: 'T', status: 'in_progress' }],
      } satisfies StreamMessage);

      // Stop main (doesn't exist)
      await router.handle({
        type: 'stream_stop', channel: 'C1', threadTs: 'T1', streamTypes: ['main'],
      } as StreamMessage);

      // todo untouched
      expect(todoStreamer.stop).not.toHaveBeenCalled();
      expect((router as any).streams.get('T1').has('todo')).toBe(true);

      router.close();
    });
  });

  // 21. Empty streamTypes array treated as stop-all
  describe('empty streamTypes array', () => {
    it('stops all streams when streamTypes is an empty array', async () => {
      const mainStreamer = mockStreamer();
      const todoStreamer = mockStreamer();
      const createStream = jest.fn<(channel: string, threadTs: string, userId: string, streamType: string) => Promise<StreamFactoryResult>>()
        .mockImplementation(async (_ch, _ts, _uid, st) => {
          if (st === 'main') return { streamer: mainStreamer, ts: 'ts-main' };
          return { streamer: todoStreamer, ts: 'ts-todo' };
        });
      const deps = createDeps({ createStream });
      const router = new StreamRouter(deps);

      await router.handle({
        type: 'stream_chunk', channel: 'C1', threadTs: 'T1', userId: 'U1',
        streamType: 'main', chunks: [{ type: 'task_update', id: 'm1', title: 'M', status: 'in_progress' }],
      } satisfies StreamMessage);
      await router.handle({
        type: 'stream_chunk', channel: 'C1', threadTs: 'T1', userId: 'U1',
        streamType: 'todo', chunks: [{ type: 'task_update', id: 't1', title: 'T', status: 'in_progress' }],
      } satisfies StreamMessage);

      // Empty array — same as omitting streamTypes
      await router.handle({
        type: 'stream_stop', channel: 'C1', threadTs: 'T1', streamTypes: [],
      } as StreamMessage);

      expect(mainStreamer.stop).toHaveBeenCalled();
      expect(todoStreamer.stop).toHaveBeenCalled();
      expect((router as any).streams.has('T1')).toBe(false);
      expect((router as any).threadInfo.has('T1')).toBe(false);

      router.close();
    });
  });

  // 22. Full lifecycle with selective stop
  describe('full lifecycle with selective stop', () => {
    it('todo survives selective main stop, new main created, full stop cleans all', async () => {
      const mainStreamer1 = mockStreamer();
      const todoStreamer = mockStreamer();
      const mainStreamer2 = mockStreamer();
      let callCount = 0;
      const createStream = jest.fn<(channel: string, threadTs: string, userId: string, streamType: string) => Promise<StreamFactoryResult>>()
        .mockImplementation(async (_ch, _ts, _uid, st) => {
          callCount++;
          if (st === 'todo') return { streamer: todoStreamer, ts: 'ts-todo' };
          if (callCount <= 2) return { streamer: mainStreamer1, ts: 'ts-main-1' };
          return { streamer: mainStreamer2, ts: 'ts-main-2' };
        });
      const deps = createDeps({ createStream });
      const router = new StreamRouter(deps);

      // Phase 1: stream_start + chunks for both main and todo
      await router.handle({
        type: 'stream_start', channel: 'C1', threadTs: 'T1', userId: 'U1',
      } satisfies StreamMessage);
      await router.handle({
        type: 'stream_chunk', channel: 'C1', threadTs: 'T1', userId: 'U1',
        streamType: 'main', chunks: [{ type: 'task_update', id: 'm1', title: 'Main1', status: 'in_progress' }],
      } satisfies StreamMessage);
      await router.handle({
        type: 'stream_chunk', channel: 'C1', threadTs: 'T1', userId: 'U1',
        streamType: 'todo', chunks: [{ type: 'task_update', id: 't1', title: 'Todo1', status: 'in_progress' }],
      } satisfies StreamMessage);
      expect(createStream).toHaveBeenCalledTimes(2);

      // Phase 2: selective stop for main only
      await router.handle({
        type: 'stream_stop', channel: 'C1', threadTs: 'T1', streamTypes: ['main'],
      } as StreamMessage);
      expect(mainStreamer1.stop).toHaveBeenCalled();
      expect(todoStreamer.stop).not.toHaveBeenCalled();

      // Phase 3: new chunks for both — todo reuses existing buffer, main creates new
      await router.handle({
        type: 'stream_chunk', channel: 'C1', threadTs: 'T1', userId: 'U1',
        streamType: 'todo', chunks: [{ type: 'task_update', id: 't2', title: 'Todo2', status: 'completed' }],
      } satisfies StreamMessage);
      await router.handle({
        type: 'stream_chunk', channel: 'C1', threadTs: 'T1', userId: 'U1',
        streamType: 'main', chunks: [{ type: 'task_update', id: 'm2', title: 'Main2', status: 'in_progress' }],
      } satisfies StreamMessage);
      // todo reused (still 2 from before for todo), main created new (3 total)
      expect(createStream).toHaveBeenCalledTimes(3);

      // Phase 4: unfiltered stop cleans up everything
      await router.handle({
        type: 'stream_stop', channel: 'C1', threadTs: 'T1',
      } satisfies StreamMessage);
      expect(todoStreamer.stop).toHaveBeenCalled();
      expect(mainStreamer2.stop).toHaveBeenCalled();
      expect((router as any).streams.has('T1')).toBe(false);
      expect((router as any).threadInfo.has('T1')).toBe(false);

      router.close();
    });
  });
});
