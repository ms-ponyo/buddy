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
} {
  const handle = {
    appendCalls: [] as Array<{ chunks: unknown[] }>,
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
} {
  const createStreamMock = jest
    .fn<(channel: string, threadTs: string, userId: string, streamType: string) => Promise<StreamFactoryResult>>()
    .mockImplementation(async () => {
      const streamer = mockStreamer();
      return { streamer, ts: `ts-${Date.now()}-${Math.random()}` };
    });

  const deps: StreamRouterDeps = {
    createStream: overrides.createStream ?? createStreamMock,
    rateLimitAcquire: overrides.rateLimitAcquire ?? jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    deleteMessage:
      overrides.deleteMessage ?? jest.fn<(channel: string, ts: string) => Promise<void>>().mockResolvedValue(undefined),
    logger: overrides.logger ?? {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    },
  };

  return {
    ...deps,
    createStreamMock: (deps.createStream === createStreamMock
      ? createStreamMock
      : (overrides.createStream as any)),
  };
}

// ── Integration Tests ─────────────────────────────────────────────────

describe('stream lifecycle — integration', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  // ── Test 1: Full flow: start → main chunks → todo chunks → stop ──────

  describe('full flow: start → main chunks → todo chunks → stop', () => {
    it('creates two separate streams for main and todo, stops both on stream_stop', async () => {
      const mainStreamer = mockStreamer();
      const todoStreamer = mockStreamer();
      let callCount = 0;

      const createStreamMock = jest
        .fn<(channel: string, threadTs: string, userId: string, streamType: string) => Promise<StreamFactoryResult>>()
        .mockImplementation(async () => {
          callCount++;
          if (callCount === 1) return { streamer: mainStreamer, ts: 'ts-main' };
          return { streamer: todoStreamer, ts: 'ts-todo' };
        });

      const deps = createDeps({ createStream: createStreamMock });
      const router = new StreamRouter(deps);

      // 1. stream_start — caches thread info
      await router.handle({
        type: 'stream_start',
        channel: 'C-FULL',
        threadTs: 'tt-full',
        userId: 'U-FULL',
      } satisfies StreamMessage);

      // createStream should NOT have been called yet
      expect(createStreamMock).not.toHaveBeenCalled();

      // 2. stream_chunk for 'main'
      await router.handle({
        type: 'stream_chunk',
        channel: 'C-FULL',
        threadTs: 'tt-full',
        userId: 'U-FULL',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 'm1', title: 'Main work', status: 'in_progress' }],
      } satisfies StreamMessage);

      expect(createStreamMock).toHaveBeenCalledTimes(1);
      expect(mainStreamer.append).toHaveBeenCalledTimes(1);

      // 3. stream_chunk for 'todo'
      await router.handle({
        type: 'stream_chunk',
        channel: 'C-FULL',
        threadTs: 'tt-full',
        userId: 'U-FULL',
        streamType: 'todo',
        chunks: [{ type: 'task_update', id: 'd1', title: 'Todo item', status: 'in_progress' }],
      } satisfies StreamMessage);

      // Two separate streams created (one per streamType)
      expect(createStreamMock).toHaveBeenCalledTimes(2);
      expect(todoStreamer.append).toHaveBeenCalledTimes(1);

      // 4. stream_stop — both streams stopped
      await router.handle({
        type: 'stream_stop',
        channel: 'C-FULL',
        threadTs: 'tt-full',
      } satisfies StreamMessage);

      expect(mainStreamer.stop).toHaveBeenCalled();
      expect(todoStreamer.stop).toHaveBeenCalled();

      router.close();
    });
  });

  // ── Test 2: Overflow triggers transparent restart ─────────────────

  describe('overflow triggers transparent restart', () => {
    it('creates a new stream on msg_too_long and stops the old one', async () => {
      const firstStreamer = mockStreamer();
      const secondStreamer = mockStreamer();
      let callCount = 0;

      const createStreamMock = jest
        .fn<(channel: string, threadTs: string, userId: string, streamType: string) => Promise<StreamFactoryResult>>()
        .mockImplementation(async () => {
          callCount++;
          if (callCount === 1) return { streamer: firstStreamer, ts: 'ts-first' };
          return { streamer: secondStreamer, ts: 'ts-second' };
        });

      const deps = createDeps({ createStream: createStreamMock });
      const router = new StreamRouter(deps);

      // Send first chunk — creates the stream
      await router.handle({
        type: 'stream_chunk',
        channel: 'C-OVF',
        threadTs: 'tt-ovf',
        userId: 'U-OVF',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 'o1', title: 'First', status: 'in_progress' }],
      } satisfies StreamMessage);

      expect(createStreamMock).toHaveBeenCalledTimes(1);

      // Make next append fail with msg_too_long
      firstStreamer.append.mockRejectedValueOnce(new Error('msg_too_long'));

      // Send another chunk — triggers overflow/restart on the buffer's next drain
      await router.handle({
        type: 'stream_chunk',
        channel: 'C-OVF',
        threadTs: 'tt-ovf',
        userId: 'U-OVF',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 'o2', title: 'Overflow chunk', status: 'in_progress' }],
      } satisfies StreamMessage);

      // A new stream should have been created (transparent restart via streamFactory)
      expect(createStreamMock).toHaveBeenCalledTimes(2);
      // Old stream should have been stopped
      expect(firstStreamer.stop).toHaveBeenCalled();

      router.close();
    });
  });

  // ── Test 3: Implicit start (no explicit stream_start needed) ─────────

  describe('implicit start', () => {
    it('creates a stream when stream_chunk arrives without prior stream_start', async () => {
      const deps = createDeps();
      const router = new StreamRouter(deps);

      // No stream_start sent
      await router.handle({
        type: 'stream_chunk',
        channel: 'C-IMPL',
        threadTs: 'tt-impl',
        userId: 'U-IMPL',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 'i1', title: 'Implicit', status: 'in_progress' }],
      } satisfies StreamMessage);

      // createStream should have been called even without stream_start
      expect(deps.createStreamMock).toHaveBeenCalledTimes(1);
      expect(deps.createStreamMock).toHaveBeenCalledWith('C-IMPL', 'tt-impl', 'U-IMPL', 'main');

      router.close();
    });
  });

  // ── Test 4: stream_pause stops all streams ───────────────────────────

  describe('stream_pause stops all streams', () => {
    it('stops both main and todo streams, allows new chunks to create fresh streams', async () => {
      const mainStreamer = mockStreamer();
      const todoStreamer = mockStreamer();
      const newMainStreamer = mockStreamer();
      let callCount = 0;

      const createStreamMock = jest
        .fn<(channel: string, threadTs: string, userId: string, streamType: string) => Promise<StreamFactoryResult>>()
        .mockImplementation(async () => {
          callCount++;
          if (callCount === 1) return { streamer: mainStreamer, ts: 'ts-p-main' };
          if (callCount === 2) return { streamer: todoStreamer, ts: 'ts-p-todo' };
          return { streamer: newMainStreamer, ts: 'ts-p-main-2' };
        });

      const deps = createDeps({ createStream: createStreamMock });
      const router = new StreamRouter(deps);

      // Create two streams (main + todo)
      await router.handle({
        type: 'stream_chunk',
        channel: 'C-PAUSE',
        threadTs: 'tt-pause',
        userId: 'U-PAUSE',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 'pm1', title: 'Main before pause', status: 'in_progress' }],
      } satisfies StreamMessage);

      await router.handle({
        type: 'stream_chunk',
        channel: 'C-PAUSE',
        threadTs: 'tt-pause',
        userId: 'U-PAUSE',
        streamType: 'todo',
        chunks: [{ type: 'task_update', id: 'pt1', title: 'Todo before pause', status: 'in_progress' }],
      } satisfies StreamMessage);

      expect(createStreamMock).toHaveBeenCalledTimes(2);

      // Send stream_pause — both streams should be stopped
      await router.handle({
        type: 'stream_pause',
        channel: 'C-PAUSE',
        threadTs: 'tt-pause',
      } satisfies StreamMessage);

      expect(mainStreamer.stop).toHaveBeenCalled();
      expect(todoStreamer.stop).toHaveBeenCalled();

      // New chunk after pause should create a new stream
      await router.handle({
        type: 'stream_chunk',
        channel: 'C-PAUSE',
        threadTs: 'tt-pause',
        userId: 'U-PAUSE',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 'pm2', title: 'Main after pause', status: 'in_progress' }],
      } satisfies StreamMessage);

      expect(createStreamMock).toHaveBeenCalledTimes(3);
      expect(newMainStreamer.append).toHaveBeenCalled();

      router.close();
    });
  });

  // ── Test 5: Dead-stream recovery (not_in_streaming_state) ────────────

  describe('dead-stream recovery', () => {
    it('transparently restarts when append fails with not_in_streaming_state', async () => {
      const deadStreamer = mockStreamer();
      const freshStreamer = mockStreamer();
      let callCount = 0;

      const createStreamMock = jest
        .fn<(channel: string, threadTs: string, userId: string, streamType: string) => Promise<StreamFactoryResult>>()
        .mockImplementation(async () => {
          callCount++;
          if (callCount === 1) return { streamer: deadStreamer, ts: 'ts-dead' };
          return { streamer: freshStreamer, ts: 'ts-fresh' };
        });

      const deps = createDeps({ createStream: createStreamMock });
      const router = new StreamRouter(deps);

      // Create stream with first chunk
      await router.handle({
        type: 'stream_chunk',
        channel: 'C-DEAD',
        threadTs: 'tt-dead',
        userId: 'U-DEAD',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 'dr1', title: 'First', status: 'in_progress' }],
      } satisfies StreamMessage);

      expect(createStreamMock).toHaveBeenCalledTimes(1);

      // Make next append throw not_in_streaming_state
      deadStreamer.append.mockRejectedValueOnce(new Error('not_in_streaming_state'));

      // Send another chunk — should trigger dead-stream recovery
      await router.handle({
        type: 'stream_chunk',
        channel: 'C-DEAD',
        threadTs: 'tt-dead',
        userId: 'U-DEAD',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 'dr2', title: 'After dead stream', status: 'in_progress' }],
      } satisfies StreamMessage);

      // A new stream should have been created (transparent restart)
      expect(createStreamMock).toHaveBeenCalledTimes(2);
      // Old stream should have been stopped
      expect(deadStreamer.stop).toHaveBeenCalled();

      router.close();
    });
  });
});
