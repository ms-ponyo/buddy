/**
 * Integration tests for concurrent multi-thread streaming scenarios.
 *
 * Tests advanced StreamRouter + StreamBuffer interactions:
 * - Multiple threads with interleaved operations
 * - Rapid sequential chunks building up state
 * - Back-to-back pause/resume cycles
 * - Pre-flight overflow triggering transparent restart
 * - Empty stream deletion on stop
 */
import { jest } from '@jest/globals';
import type { StreamMessage } from '@buddy/shared';
import { STREAM_SIZE_LIMIT, STREAM_TASK_LIMIT } from '@buddy/shared';
import type { StreamFactoryResult, StreamerHandle } from '../../src/stream-buffer.js';
import type { StreamRouterDeps } from '../../src/stream-router.js';

let StreamRouter: typeof import('../../src/stream-router.js').StreamRouter;

beforeAll(async () => {
  const mod = await import('../../src/stream-router.js');
  StreamRouter = mod.StreamRouter;
});

// ── Helpers ──────────────────────────────────────────────────────────

interface TrackedStreamer extends StreamerHandle {
  appendCalls: Array<{ chunks: unknown[] }>;
  label: string;
}

function mockStreamer(label: string): TrackedStreamer {
  const handle: TrackedStreamer = {
    label,
    appendCalls: [] as Array<{ chunks: unknown[] }>,
    append: jest.fn<StreamerHandle['append']>(async (payload) => {
      handle.appendCalls.push(payload);
      return { ts: `ts-${label}` };
    }),
    stop: jest.fn<StreamerHandle['stop']>(async () => {}),
  };
  return handle;
}

function createDeps(
  streamers: TrackedStreamer[],
): StreamRouterDeps & { streamers: TrackedStreamer[]; deleteMessage: jest.Mock } {
  let callCount = 0;
  const deleteMessage = jest.fn<(channel: string, ts: string) => Promise<void>>().mockResolvedValue(undefined);

  return {
    streamers,
    deleteMessage,
    createStream: jest.fn(async () => {
      const s = streamers[callCount] ?? mockStreamer(`overflow-${callCount}`);
      callCount++;
      return { streamer: s, ts: `ts-${s.label}` } as StreamFactoryResult;
    }),
    rateLimitAcquire: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('stream concurrent — integration', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  // ── Test 1: Three threads interleaved ──────────────────────────────

  it('three threads receive chunks in arbitrary order without cross-talk', async () => {
    const streamers = [
      mockStreamer('thread-A-main'),
      mockStreamer('thread-B-main'),
      mockStreamer('thread-C-main'),
    ];
    const deps = createDeps(streamers);
    const router = new StreamRouter(deps);

    // Interleave chunks for threads A, B, C
    const threads = [
      { channel: 'CA', threadTs: 'TA', userId: 'UA' },
      { channel: 'CB', threadTs: 'TB', userId: 'UB' },
      { channel: 'CC', threadTs: 'TC', userId: 'UC' },
    ];

    // Round 1: one chunk per thread
    for (let i = 0; i < 3; i++) {
      await router.handle({
        type: 'stream_chunk',
        ...threads[i],
        streamType: 'main',
        chunks: [{ type: 'task_update', id: `t${i}-1`, title: `Thread ${i} chunk 1`, status: 'in_progress' }],
      } satisfies StreamMessage);
    }

    // Each thread got its own stream
    expect(streamers[0].append).toHaveBeenCalled();
    expect(streamers[1].append).toHaveBeenCalled();
    expect(streamers[2].append).toHaveBeenCalled();

    // Round 2: more chunks in reverse order
    for (let i = 2; i >= 0; i--) {
      await router.handle({
        type: 'stream_chunk',
        ...threads[i],
        streamType: 'main',
        chunks: [{ type: 'task_update', id: `t${i}-2`, title: `Thread ${i} chunk 2`, status: 'in_progress' }],
      } satisfies StreamMessage);
    }

    // Verify each streamer got exactly its own chunks (2 drains each)
    // Each drain appends a plan_update, so each call has the data chunk + plan_update
    for (let i = 0; i < 3; i++) {
      expect(streamers[i].appendCalls).toHaveLength(2);
      // First drain should contain the thread's chunk
      const firstBatch = streamers[i].appendCalls[0].chunks;
      const hasThreadChunk = firstBatch.some(
        (c: any) => c.id === `t${i}-1`,
      );
      expect(hasThreadChunk).toBe(true);
    }

    // Stop only thread B
    await router.handle({
      type: 'stream_stop',
      channel: 'CB',
      threadTs: 'TB',
    } satisfies StreamMessage);

    expect(streamers[1].stop).toHaveBeenCalled();
    expect(streamers[0].stop).not.toHaveBeenCalled();
    expect(streamers[2].stop).not.toHaveBeenCalled();

    router.close();
  });

  // ── Test 2: Rapid sequential chunks accumulate correctly ──────────

  it('many rapid chunks are each drained individually', async () => {
    const mainStreamer = mockStreamer('rapid-main');
    const deps = createDeps([mainStreamer]);
    const router = new StreamRouter(deps);

    const N = 20;
    for (let i = 0; i < N; i++) {
      await router.handle({
        type: 'stream_chunk',
        channel: 'CR',
        threadTs: 'TR',
        userId: 'UR',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: `r${i}`, title: `Rapid ${i}`, status: 'in_progress' }],
      } satisfies StreamMessage);
    }

    // Each chunk triggers its own drain (since we await each handle)
    expect(mainStreamer.appendCalls).toHaveLength(N);

    // Verify all task IDs made it through
    const allIds = new Set<string>();
    for (const call of mainStreamer.appendCalls) {
      for (const chunk of call.chunks) {
        const c = chunk as Record<string, unknown>;
        if (c.type === 'task_update' && typeof c.id === 'string') {
          allIds.add(c.id);
        }
      }
    }
    for (let i = 0; i < N; i++) {
      expect(allIds.has(`r${i}`)).toBe(true);
    }

    router.close();
  });

  // ── Test 3: Back-to-back pause/resume cycles ──────────────────────

  it('multiple pause/resume cycles create fresh streams each time', async () => {
    const streamers = [
      mockStreamer('cycle-1'),
      mockStreamer('cycle-2'),
      mockStreamer('cycle-3'),
    ];
    const deps = createDeps(streamers);
    const router = new StreamRouter(deps);

    // Cycle 1: chunk → pause
    await router.handle({
      type: 'stream_chunk',
      channel: 'CC', threadTs: 'TC', userId: 'UC',
      streamType: 'main',
      chunks: [{ type: 'task_update', id: 'c1', title: 'Cycle 1', status: 'in_progress' }],
    } satisfies StreamMessage);
    await router.handle({ type: 'stream_pause', channel: 'CC', threadTs: 'TC' } satisfies StreamMessage);
    expect(streamers[0].stop).toHaveBeenCalled();

    // Cycle 2: chunk → pause
    await router.handle({
      type: 'stream_chunk',
      channel: 'CC', threadTs: 'TC', userId: 'UC',
      streamType: 'main',
      chunks: [{ type: 'task_update', id: 'c2', title: 'Cycle 2', status: 'in_progress' }],
    } satisfies StreamMessage);
    await router.handle({ type: 'stream_pause', channel: 'CC', threadTs: 'TC' } satisfies StreamMessage);
    expect(streamers[1].stop).toHaveBeenCalled();

    // Cycle 3: chunk → stop
    await router.handle({
      type: 'stream_chunk',
      channel: 'CC', threadTs: 'TC', userId: 'UC',
      streamType: 'main',
      chunks: [{ type: 'task_update', id: 'c3', title: 'Cycle 3', status: 'in_progress' }],
    } satisfies StreamMessage);
    await router.handle({ type: 'stream_stop', channel: 'CC', threadTs: 'TC' } satisfies StreamMessage);
    expect(streamers[2].stop).toHaveBeenCalled();

    // 3 separate streams were created
    expect(deps.createStream).toHaveBeenCalledTimes(3);

    router.close();
  });

  // ── Test 4: Pre-flight overflow triggers transparent restart ───────

  it('pre-flight overflow in StreamBuffer triggers transparent restart through router', async () => {
    const firstStreamer = mockStreamer('pre-ovf-first');
    const secondStreamer = mockStreamer('pre-ovf-second');
    const deps = createDeps([firstStreamer, secondStreamer]);
    const router = new StreamRouter(deps);

    // Send initial chunk to create stream
    await router.handle({
      type: 'stream_chunk',
      channel: 'CO', threadTs: 'TO', userId: 'UO',
      streamType: 'main',
      chunks: [{ type: 'task_update', id: 'ovf-0', title: 'Initial', status: 'in_progress' }],
    } satisfies StreamMessage);

    expect(deps.createStream).toHaveBeenCalledTimes(1);

    // Artificially inflate the buffer's byte count to just under the limit.
    // Access the internal StreamBuffer via the router's streams map.
    const routerStreams = (router as any).streams as Map<string, Map<string, any>>;
    const threadStreams = routerStreams.get('TO');
    expect(threadStreams).toBeDefined();
    const buffer = threadStreams!.get('main');
    expect(buffer).toBeDefined();

    // Set byte count near limit so next drain triggers pre-flight overflow
    (buffer as any).byteCount = STREAM_SIZE_LIMIT - 10;

    // Send a chunk that exceeds the remaining space
    await router.handle({
      type: 'stream_chunk',
      channel: 'CO', threadTs: 'TO', userId: 'UO',
      streamType: 'main',
      chunks: [{ type: 'task_update', id: 'ovf-1', title: 'Overflow trigger', status: 'in_progress' }],
    } satisfies StreamMessage);

    // Should have created a second stream (transparent restart)
    expect(deps.createStream).toHaveBeenCalledTimes(2);
    // Old stream stopped
    expect(firstStreamer.stop).toHaveBeenCalled();
    // New stream received the chunk
    expect(secondStreamer.appendCalls.length).toBeGreaterThanOrEqual(1);

    router.close();
  });

  // ── Test 5: Task ID limit triggers transparent restart ────────────

  it('exceeding task ID limit triggers transparent restart', async () => {
    const firstStreamer = mockStreamer('id-ovf-first');
    const secondStreamer = mockStreamer('id-ovf-second');
    const deps = createDeps([firstStreamer, secondStreamer]);
    const router = new StreamRouter(deps);

    // Send initial chunk
    await router.handle({
      type: 'stream_chunk',
      channel: 'CI', threadTs: 'TI', userId: 'UI',
      streamType: 'main',
      chunks: [{ type: 'task_update', id: 'id-0', title: 'Initial', status: 'in_progress' }],
    } satisfies StreamMessage);

    // Fill up taskIdSet to near limit
    const buffer = (router as any).streams.get('TI')?.get('main');
    for (let i = 1; i < STREAM_TASK_LIMIT; i++) {
      (buffer as any).taskIdSet.add(`synthetic-${i}`);
    }

    // Send chunk with a new task ID — should trigger overflow
    await router.handle({
      type: 'stream_chunk',
      channel: 'CI', threadTs: 'TI', userId: 'UI',
      streamType: 'main',
      chunks: [{ type: 'task_update', id: 'id-overflow', title: 'Overflow by IDs', status: 'in_progress' }],
    } satisfies StreamMessage);

    // Transparent restart happened
    expect(deps.createStream).toHaveBeenCalledTimes(2);
    expect(firstStreamer.stop).toHaveBeenCalled();

    router.close();
  });

  // ── Test 6: Empty stream gets deleted on stop ─────────────────────

  it('stream with no meaningful content gets deleted on stream_stop', async () => {
    const emptyStreamer = mockStreamer('empty');
    const deps = createDeps([emptyStreamer]);
    const router = new StreamRouter(deps);

    // Send only a plan_update (no task_update, so no meaningful content)
    await router.handle({
      type: 'stream_chunk',
      channel: 'CE', threadTs: 'TE', userId: 'UE',
      streamType: 'main',
      chunks: [{ type: 'plan_update', title: 'Working' }],
    } satisfies StreamMessage);

    // Stop — should delete the empty message
    await router.handle({
      type: 'stream_stop',
      channel: 'CE', threadTs: 'TE',
    } satisfies StreamMessage);

    expect(deps.deleteMessage).toHaveBeenCalledWith('CE', `ts-empty`);

    router.close();
  });

  // ── Test 7: Stream with meaningful content is NOT deleted on stop ──

  it('stream with meaningful content is preserved on stream_stop', async () => {
    const contentStreamer = mockStreamer('content');
    const deps = createDeps([contentStreamer]);
    const router = new StreamRouter(deps);

    // Send a meaningful chunk (non-keepalive task_update)
    await router.handle({
      type: 'stream_chunk',
      channel: 'CM', threadTs: 'TM', userId: 'UM',
      streamType: 'main',
      chunks: [{ type: 'task_update', id: 'real-1', title: 'Real work', status: 'in_progress' }],
    } satisfies StreamMessage);

    await router.handle({
      type: 'stream_stop',
      channel: 'CM', threadTs: 'TM',
    } satisfies StreamMessage);

    // deleteMessage should NOT have been called (hadMeaningfulContent = true)
    expect(deps.deleteMessage).not.toHaveBeenCalled();

    router.close();
  });

  // ── Test 8: Concurrent main + todo with interleaved chunks ────────

  it('main and todo streams handle interleaved chunks independently', async () => {
    const mainStreamer = mockStreamer('interleave-main');
    const todoStreamer = mockStreamer('interleave-todo');
    const deps = createDeps([mainStreamer, todoStreamer]);
    const router = new StreamRouter(deps);

    // Interleave main and todo chunks
    const messages: StreamMessage[] = [
      { type: 'stream_chunk', channel: 'CI', threadTs: 'TI', userId: 'UI', streamType: 'main', chunks: [{ type: 'task_update', id: 'm1', title: 'Main 1', status: 'in_progress' }] },
      { type: 'stream_chunk', channel: 'CI', threadTs: 'TI', userId: 'UI', streamType: 'todo', chunks: [{ type: 'task_update', id: 'd1', title: 'Todo 1', status: 'in_progress' }] },
      { type: 'stream_chunk', channel: 'CI', threadTs: 'TI', userId: 'UI', streamType: 'main', chunks: [{ type: 'task_update', id: 'm2', title: 'Main 2', status: 'complete' }] },
      { type: 'stream_chunk', channel: 'CI', threadTs: 'TI', userId: 'UI', streamType: 'todo', chunks: [{ type: 'task_update', id: 'd2', title: 'Todo 2', status: 'complete' }] },
    ];

    for (const msg of messages) {
      await router.handle(msg);
    }

    // Main streamer got 2 drains, todo streamer got 2 drains
    expect(mainStreamer.appendCalls).toHaveLength(2);
    expect(todoStreamer.appendCalls).toHaveLength(2);

    // Verify correct chunks went to correct streamers
    const mainIds = mainStreamer.appendCalls.flatMap((c) =>
      c.chunks.filter((ch: any) => ch.type === 'task_update' && ch.id).map((ch: any) => ch.id),
    );
    const todoIds = todoStreamer.appendCalls.flatMap((c) =>
      c.chunks.filter((ch: any) => ch.type === 'task_update' && ch.id).map((ch: any) => ch.id),
    );
    expect(mainIds).toContain('m1');
    expect(mainIds).toContain('m2');
    expect(todoIds).toContain('d1');
    expect(todoIds).toContain('d2');

    // No cross-contamination
    expect(mainIds).not.toContain('d1');
    expect(todoIds).not.toContain('m1');

    router.close();
  });

  // ── Test 9: Dead-stream error triggers restart through router ─────

  it('message_not_found error on append triggers transparent restart', async () => {
    const deadStreamer = mockStreamer('dead');
    const freshStreamer = mockStreamer('fresh');
    const deps = createDeps([deadStreamer, freshStreamer]);
    const router = new StreamRouter(deps);

    // First chunk creates stream
    await router.handle({
      type: 'stream_chunk',
      channel: 'CD', threadTs: 'TD', userId: 'UD',
      streamType: 'main',
      chunks: [{ type: 'task_update', id: 'dead-1', title: 'Before crash', status: 'in_progress' }],
    } satisfies StreamMessage);

    // Make next append fail with message_not_found
    deadStreamer.append.mockRejectedValueOnce(new Error('message_not_found'));

    // Send another chunk — triggers dead-stream recovery
    await router.handle({
      type: 'stream_chunk',
      channel: 'CD', threadTs: 'TD', userId: 'UD',
      streamType: 'main',
      chunks: [{ type: 'task_update', id: 'dead-2', title: 'After crash', status: 'in_progress' }],
    } satisfies StreamMessage);

    // Transparent restart: old stream stopped, new created
    expect(deps.createStream).toHaveBeenCalledTimes(2);
    expect(deadStreamer.stop).toHaveBeenCalled();

    router.close();
  });
});
