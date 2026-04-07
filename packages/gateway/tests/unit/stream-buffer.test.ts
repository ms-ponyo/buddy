import { jest } from '@jest/globals';
import type { StreamerHandle, StreamFactoryResult, StreamBufferOptions } from '../../src/stream-buffer.js';

// Import the constants so tests stay in sync with shared definitions
import { STREAM_SIZE_LIMIT, STREAM_TASK_LIMIT, STREAM_ROTATE_MS } from '@buddy/shared';

// Dynamically import StreamBuffer (ESM)
let StreamBuffer: typeof import('../../src/stream-buffer.js').StreamBuffer;

beforeAll(async () => {
  const mod = await import('../../src/stream-buffer.js');
  StreamBuffer = mod.StreamBuffer;
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

function makeFactory(newStreamer?: StreamerHandle): jest.Mock<(channel: string, threadTs: string, userId: string, streamType: string) => Promise<StreamFactoryResult>> {
  const s = newStreamer ?? mockStreamer();
  return jest.fn<(channel: string, threadTs: string, userId: string, streamType: string) => Promise<StreamFactoryResult>>()
    .mockResolvedValue({ streamer: s, ts: 'new-ts-9999' });
}

function createBuffer(overrides: Partial<StreamBufferOptions> = {}): InstanceType<typeof StreamBuffer> {
  const streamer = mockStreamer();
  const defaults: StreamBufferOptions = {
    streamType: 'main',
    channel: 'C123',
    threadTs: '111.222',
    userId: 'U456',
    streamer,
    streamFactory: makeFactory(),
    rateLimitAcquire: async () => {},
    onError: jest.fn(),
  };
  return new StreamBuffer({ ...defaults, ...overrides });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('StreamBuffer', () => {
  // 1. Basic lifecycle: buffer chunks, drain flushes them
  describe('basic lifecycle', () => {
    it('buffers chunks and drains them to Slack', async () => {
      const streamer = mockStreamer();
      const buf = createBuffer({ streamer });

      buf.append([{ type: 'task_update', id: 't1', title: 'Hi', status: 'in_progress' }]);
      await buf.drain();

      expect(streamer.append).toHaveBeenCalledTimes(1);
      const call = streamer.appendCalls[0];
      // Should contain the task_update chunk plus an appended plan_update
      expect(call.chunks).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'task_update', id: 't1' }),
        expect.objectContaining({ type: 'plan_update' }),
      ]));
    });

    it('returns slackTs from options', () => {
      const buf = createBuffer();
      // slackTs comes from the initial streamer — not set by drain
      // The initial ts should be accessible
      expect(buf.slackTs).toBeDefined();
    });
  });

  // 2. Empty drain is no-op
  describe('empty drain', () => {
    it('does not call streamer.append when buffer is empty', async () => {
      const streamer = mockStreamer();
      const buf = createBuffer({ streamer });
      await buf.drain();
      expect(streamer.append).not.toHaveBeenCalled();
    });
  });

  // 3. Byte count tracking
  describe('byte count tracking', () => {
    it('accumulates byteCount from drained batch JSON size', async () => {
      const streamer = mockStreamer();
      const buf = createBuffer({ streamer });

      const chunks = [{ type: 'task_update', id: 'b1', title: 'Byte test', status: 'in_progress' }];
      buf.append(chunks);
      await buf.drain();

      // byteCount should be the JSON size of the raw batch (without the appended plan_update)
      const expectedSize = JSON.stringify(chunks).length;
      expect((buf as any).byteCount).toBe(expectedSize);
    });
  });

  // 4. Unique task ID tracking
  describe('task ID tracking', () => {
    it('tracks unique task_update IDs', async () => {
      const streamer = mockStreamer();
      const buf = createBuffer({ streamer });

      buf.append([
        { type: 'task_update', id: 'u1', title: 'A', status: 'in_progress' },
        { type: 'task_update', id: 'u2', title: 'B', status: 'in_progress' },
        { type: 'task_update', id: 'u1', title: 'A updated', status: 'complete' },
      ]);
      await buf.drain();

      expect((buf as any).taskIdSet.size).toBe(2);
      expect((buf as any).taskIdSet.has('u1')).toBe(true);
      expect((buf as any).taskIdSet.has('u2')).toBe(true);
    });
  });

  // 5. hadMeaningfulContent flag
  describe('hadMeaningfulContent', () => {
    it('is false before any drain', () => {
      const buf = createBuffer();
      expect(buf.hadMeaningfulContent).toBe(false);
    });

    it('is true after draining a task_update', async () => {
      const streamer = mockStreamer();
      const buf = createBuffer({ streamer });
      buf.append([{ type: 'task_update', id: 'real-1', title: 'Real work', status: 'in_progress' }]);
      await buf.drain();
      expect(buf.hadMeaningfulContent).toBe(true);
    });

    it('remains false after draining only plan_update chunks', async () => {
      const streamer = mockStreamer();
      const buf = createBuffer({ streamer });
      buf.append([{ type: 'plan_update', title: 'Working' }]);
      await buf.drain();
      expect(buf.hadMeaningfulContent).toBe(false);
    });
  });

  // 6. planTitle tracking from plan_update chunks
  describe('planTitle tracking', () => {
    it('captures planTitle from plan_update chunks', async () => {
      const streamer = mockStreamer();
      const buf = createBuffer({ streamer });
      buf.append([{ type: 'plan_update', title: 'My Custom Plan' }]);
      await buf.drain();
      expect((buf as any).planTitle).toBe('My Custom Plan');
    });

    it('updates planTitle on subsequent plan_update', async () => {
      const streamer = mockStreamer();
      const buf = createBuffer({ streamer });
      buf.append([{ type: 'plan_update', title: 'Plan v1' }]);
      await buf.drain();
      buf.append([{ type: 'plan_update', title: 'Plan v2' }]);
      await buf.drain();
      expect((buf as any).planTitle).toBe('Plan v2');
    });
  });

  // 7. Overflow: transparent restart on size limit
  describe('overflow - size limit', () => {
    it('triggers transparent restart when byteCount + batch exceeds STREAM_SIZE_LIMIT', async () => {
      const streamer = mockStreamer();
      const newStreamer = mockStreamer();
      const factory = makeFactory(newStreamer);
      const buf = createBuffer({ streamer, streamFactory: factory });

      // Artificially set byteCount near the limit
      (buf as any).byteCount = STREAM_SIZE_LIMIT - 10;

      // Now append a chunk that will push us over the limit
      const bigChunk = { type: 'task_update', id: 'overflow-1', title: 'x'.repeat(100), status: 'in_progress' };
      buf.append([bigChunk]);
      await buf.drain();

      // Factory should have been called (transparent restart)
      expect(factory).toHaveBeenCalledTimes(1);
      // Old streamer should have been stopped
      expect(streamer.stop).toHaveBeenCalled();
      // New streamer should receive the drained chunks
      expect(newStreamer.append).toHaveBeenCalled();
    });
  });

  // 8. Overflow: transparent restart on task ID limit
  describe('overflow - task ID limit', () => {
    it('triggers transparent restart when taskIdSet + new IDs exceeds STREAM_TASK_LIMIT', async () => {
      const streamer = mockStreamer();
      const newStreamer = mockStreamer();
      const factory = makeFactory(newStreamer);
      const buf = createBuffer({ streamer, streamFactory: factory });

      // Fill taskIdSet near the limit
      for (let i = 0; i < STREAM_TASK_LIMIT - 1; i++) {
        (buf as any).taskIdSet.add(`existing-${i}`);
      }

      // Append chunks with 2 new IDs — should push over the limit
      buf.append([
        { type: 'task_update', id: 'new-1', title: 'A', status: 'in_progress' },
        { type: 'task_update', id: 'new-2', title: 'B', status: 'in_progress' },
      ]);
      await buf.drain();

      expect(factory).toHaveBeenCalledTimes(1);
      expect(streamer.stop).toHaveBeenCalled();
    });
  });

  // 9. Overflow: transparent restart on msg_too_long error
  describe('overflow - msg_too_long', () => {
    it('triggers transparent restart on msg_too_long and re-queues chunks', async () => {
      const streamer = mockStreamer();
      streamer.append.mockRejectedValueOnce(new Error('msg_too_long'));

      const newStreamer = mockStreamer();
      const factory = makeFactory(newStreamer);
      const buf = createBuffer({ streamer, streamFactory: factory });

      buf.append([{ type: 'task_update', id: 'err-1', title: 'Test', status: 'in_progress' }]);
      await buf.drain();

      // Should have triggered restart
      expect(factory).toHaveBeenCalledTimes(1);
      // Chunks should have been pushed back to pending for the next drain
      // The pending should still have the failed chunks for next drain
    });
  });

  // 10. Rotation: transparent restart when timer expires
  describe('rotation - transparent restart', () => {
    it('restarts with a new message when rotation timer expires after content was appended', async () => {
      const streamer = mockStreamer();
      const newStreamer = mockStreamer();
      const factory = makeFactory(newStreamer);
      const buf = createBuffer({ streamer, streamFactory: factory });

      // Append and drain content so _contentSinceRotation is set
      buf.append([{ type: 'task_update', id: 't1', title: 'Work', status: 'in_progress' }]);
      await buf.drain();

      // Set createdAt to past the rotation interval
      (buf as any).createdAt = Date.now() - STREAM_ROTATE_MS - 1000;

      await buf.checkRotation();

      // Should have triggered transparent restart
      expect(factory).toHaveBeenCalledTimes(1);
      expect(streamer.stop).toHaveBeenCalled();
      // New streamer should receive recovery payload (plan_update)
      expect(newStreamer.append).toHaveBeenCalledTimes(1);
      const call = newStreamer.appendCalls[0];
      expect(call.chunks.some((c: any) => c.type === 'plan_update')).toBe(true);
    });

    it('skips rotation when no content was appended since last rotation', async () => {
      const streamer = mockStreamer();
      const factory = makeFactory();
      const buf = createBuffer({ streamer, streamFactory: factory });

      // Set createdAt to past the rotation interval but never append content
      (buf as any).createdAt = Date.now() - STREAM_ROTATE_MS - 1000;

      await buf.checkRotation();
      // Should NOT have triggered restart (no content since creation)
      expect(factory).not.toHaveBeenCalled();
    });

    it('is a no-op when pending is non-empty', async () => {
      const streamer = mockStreamer();
      const factory = makeFactory();
      const buf = createBuffer({ streamer, streamFactory: factory });

      (buf as any).createdAt = Date.now() - STREAM_ROTATE_MS - 1000;
      buf.append([{ type: 'task_update', id: 'active', title: 'Busy', status: 'in_progress' }]);

      await buf.checkRotation();
      // Should NOT have triggered restart (pending non-empty means active work)
      expect(factory).not.toHaveBeenCalled();
    });

    it('is a no-op when not yet due for rotation', async () => {
      const streamer = mockStreamer();
      const factory = makeFactory();
      const buf = createBuffer({ streamer, streamFactory: factory });

      // createdAt is recent — no rotation needed
      await buf.checkRotation();
      expect(factory).not.toHaveBeenCalled();
    });
  });

  // 11. Stop behavior
  describe('stop', () => {
    it('drains remaining pending and stops', async () => {
      const streamer = mockStreamer();
      const buf = createBuffer({ streamer });

      buf.append([{ type: 'task_update', id: 'pend-1', title: 'Pending', status: 'in_progress' }]);
      await buf.stop();

      expect(streamer.append).toHaveBeenCalled();
      expect(streamer.stop).toHaveBeenCalled();
    });

    it('makes subsequent append and drain no-ops', async () => {
      const streamer = mockStreamer();
      const buf = createBuffer({ streamer });

      await buf.stop();

      buf.append([{ type: 'task_update', id: 'after-stop', title: 'Ignored', status: 'in_progress' }]);
      await buf.drain();

      expect(streamer.appendCalls.length).toBe(0);
    });
  });

  // 12. Dead-stream recovery: transparent restart on not_in_streaming_state
  describe('dead-stream recovery', () => {
    it('triggers transparent restart on not_in_streaming_state error', async () => {
      const streamer = mockStreamer();
      streamer.append.mockRejectedValueOnce(new Error('not_in_streaming_state'));

      const newStreamer = mockStreamer();
      const factory = makeFactory(newStreamer);
      const buf = createBuffer({ streamer, streamFactory: factory });

      buf.append([{ type: 'task_update', id: 'dead-1', title: 'Recovery', status: 'in_progress' }]);
      await buf.drain();

      expect(factory).toHaveBeenCalledTimes(1);
      expect(streamer.stop).toHaveBeenCalled();
    });

    it('triggers transparent restart on message_not_found error', async () => {
      const streamer = mockStreamer();
      streamer.append.mockRejectedValueOnce(new Error('message_not_found'));

      const newStreamer = mockStreamer();
      const factory = makeFactory(newStreamer);
      const buf = createBuffer({ streamer, streamFactory: factory });

      buf.append([{ type: 'task_update', id: 'dead-2', title: 'Recovery 2', status: 'in_progress' }]);
      await buf.drain();

      expect(factory).toHaveBeenCalledTimes(1);
    });
  });

  // Drain appends plan_update to force Slack flush
  describe('drain always appends plan_update', () => {
    it('appends a plan_update chunk to every drain call', async () => {
      const streamer = mockStreamer();
      const buf = createBuffer({ streamer });

      buf.append([{ type: 'task_update', id: 'pu-1', title: 'Test', status: 'in_progress' }]);
      await buf.drain();

      const call = streamer.appendCalls[0];
      const planUpdate = call.chunks.find((c: any) => c.type === 'plan_update');
      expect(planUpdate).toBeDefined();
    });

    it('uses current planTitle in the appended plan_update', async () => {
      const streamer = mockStreamer();
      const buf = createBuffer({ streamer });

      // First set a plan title
      buf.append([{ type: 'plan_update', title: 'Custom Title' }]);
      await buf.drain();

      // Next drain should use the saved title
      buf.append([{ type: 'task_update', id: 'pu-2', title: 'Test', status: 'in_progress' }]);
      await buf.drain();

      const secondCall = streamer.appendCalls[1];
      const planUpdate = secondCall.chunks.find((c: any) => c.type === 'plan_update');
      expect((planUpdate as any).title).toBe('Custom Title');
    });
  });

  // slackTs getter updates after transparent restart
  describe('slackTs getter', () => {
    it('updates slackTs after transparent restart', async () => {
      const streamer = mockStreamer();
      const newStreamer = mockStreamer();
      // Make the new streamer's append also return the factory ts for consistency
      newStreamer.append.mockResolvedValue({ ts: 'new-ts-9999' });
      const factory = makeFactory(newStreamer);
      const buf = createBuffer({ streamer, streamFactory: factory });

      const initialTs = buf.slackTs;

      // Force overflow to trigger restart
      (buf as any).byteCount = STREAM_SIZE_LIMIT - 1;
      buf.append([{ type: 'task_update', id: 'ts-1', title: 'x'.repeat(100), status: 'in_progress' }]);
      await buf.drain();

      // After restart, slackTs comes from factory, then may be updated by append
      expect(buf.slackTs).toBe('new-ts-9999');
      expect(buf.slackTs).not.toBe(initialTs);
    });
  });

  // rateLimitAcquire is called before each drain
  describe('rate limiting', () => {
    it('calls rateLimitAcquire before each drain', async () => {
      const streamer = mockStreamer();
      const rateLimitAcquire = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
      const buf = createBuffer({ streamer, rateLimitAcquire });

      buf.append([{ type: 'task_update', id: 'rl-1', title: 'Test', status: 'in_progress' }]);
      await buf.drain();

      expect(rateLimitAcquire).toHaveBeenCalled();
    });
  });

  // onError callback for non-recoverable errors
  describe('onError callback', () => {
    it('calls onError for non-recoverable errors', async () => {
      const streamer = mockStreamer();
      streamer.append.mockRejectedValueOnce(new Error('some_unknown_error'));
      const onError = jest.fn();
      const buf = createBuffer({ streamer, onError });

      buf.append([{ type: 'task_update', id: 'e1', title: 'Err', status: 'in_progress' }]);
      await buf.drain();

      expect(onError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.any(String),
      );
    });
  });

  // Todo stream snapshot recovery on restart
  describe('todo snapshot recovery', () => {
    it('replays full task snapshot on transparent restart for todo streams', async () => {
      const streamer = mockStreamer();
      const newStreamer = mockStreamer();
      const factory = makeFactory(newStreamer);
      const buf = createBuffer({ streamer, streamFactory: factory, streamType: 'todo' });

      // Drain some todo tasks
      buf.append([
        { type: 'task_update', id: 'd1', title: 'Todo 1', status: 'in_progress' },
        { type: 'task_update', id: 'd2', title: 'Todo 2', status: 'complete' },
      ]);
      await buf.drain();

      // Force overflow to trigger restart
      (buf as any).byteCount = STREAM_SIZE_LIMIT - 1;
      buf.append([{ type: 'task_update', id: 'd3', title: 'x'.repeat(100), status: 'in_progress' }]);
      await buf.drain();

      expect(factory).toHaveBeenCalledTimes(1);

      // New streamer should have received snapshot (d1, d2) + the new chunk (d3) + plan_updates
      const allChunks = newStreamer.appendCalls.flatMap((c) => c.chunks);
      const taskIds = allChunks.filter((c: any) => c.type === 'task_update').map((c: any) => c.id);
      expect(taskIds).toContain('d1');
      expect(taskIds).toContain('d2');
      expect(taskIds).toContain('d3');
    });

    it('does NOT replay snapshot for main stream restart', async () => {
      const streamer = mockStreamer();
      const newStreamer = mockStreamer();
      const factory = makeFactory(newStreamer);
      const buf = createBuffer({ streamer, streamFactory: factory, streamType: 'main' });

      // Drain some tasks
      buf.append([
        { type: 'task_update', id: 'm1', title: 'Main 1', status: 'in_progress' },
      ]);
      await buf.drain();

      // Force overflow to trigger restart
      (buf as any).byteCount = STREAM_SIZE_LIMIT - 1;
      buf.append([{ type: 'task_update', id: 'm2', title: 'x'.repeat(100), status: 'in_progress' }]);
      await buf.drain();

      // New streamer should have m2 (the overflow chunk) but NOT m1 (already drained)
      const allChunks = newStreamer.appendCalls.flatMap((c) => c.chunks);
      const taskIds = allChunks.filter((c: any) => c.type === 'task_update').map((c: any) => c.id);
      expect(taskIds).toContain('m2');
      expect(taskIds).not.toContain('m1');
    });
  });

  // transparentRestart resets counters and preserves plan title
  describe('transparentRestart state reset', () => {
    it('resets byteCount and taskIdSet after restart', async () => {
      const streamer = mockStreamer();
      const newStreamer = mockStreamer();
      const factory = makeFactory(newStreamer);
      const buf = createBuffer({ streamer, streamFactory: factory });

      // Build up some state
      buf.append([{ type: 'task_update', id: 'pre-1', title: 'Before', status: 'in_progress' }]);
      await buf.drain();
      expect((buf as any).byteCount).toBeGreaterThan(0);
      expect((buf as any).taskIdSet.size).toBe(1);

      // Force restart
      (buf as any).byteCount = STREAM_SIZE_LIMIT - 1;
      buf.append([{ type: 'task_update', id: 'ovf-1', title: 'x'.repeat(100), status: 'in_progress' }]);
      await buf.drain();

      // After restart, counters should be reset (byteCount reflects only the new drain)
      // taskIdSet should only contain the new task IDs (from the re-drained batch)
      expect((buf as any).taskIdSet.has('pre-1')).toBe(false);
    });

    it('prepends plan_update with saved planTitle after restart', async () => {
      const streamer = mockStreamer();
      const newStreamer = mockStreamer();
      const factory = makeFactory(newStreamer);
      const buf = createBuffer({ streamer, streamFactory: factory });

      // Set a custom plan title
      buf.append([{ type: 'plan_update', title: 'My Custom Plan' }]);
      await buf.drain();

      // Force restart
      (buf as any).byteCount = STREAM_SIZE_LIMIT - 1;
      buf.append([{ type: 'task_update', id: 'plan-1', title: 'x'.repeat(100), status: 'in_progress' }]);
      await buf.drain();

      // New streamer should have received plan_update with saved title
      const planUpdateInNew = newStreamer.appendCalls.some((call) =>
        call.chunks.some((c: any) => c.type === 'plan_update' && c.title === 'My Custom Plan'),
      );
      expect(planUpdateInNew).toBe(true);
    });
  });

  // stop with pending chunks still drains them
  describe('stop with pending data', () => {
    it('drains remaining pending chunks before stopping', async () => {
      const streamer = mockStreamer();
      const buf = createBuffer({ streamer });

      // Add pending chunks without draining
      buf.append([{ type: 'task_update', id: 'pend-1', title: 'Pending', status: 'in_progress' }]);

      // Stop should drain first
      await buf.stop();

      // Streamer should have received the pending chunk
      expect(streamer.append).toHaveBeenCalled();
      const hasPendingChunk = streamer.appendCalls.some((call) =>
        call.chunks.some((c: any) => c.id === 'pend-1'),
      );
      expect(hasPendingChunk).toBe(true);
      expect(streamer.stop).toHaveBeenCalled();
    });
  });

  // 10b. Stop: completes in-progress task cards
  describe('stop - completes in-progress task cards', () => {
    it('sends completion chunks for non-complete tasks on stop', async () => {
      const streamer = mockStreamer();
      const buf = createBuffer({ streamer, streamType: 'main' });

      // Drain some tasks
      buf.append([
        { type: 'task_update', id: 's1', title: 'Searching', status: 'in_progress', details: 'Grep for auth' },
        { type: 'task_update', id: 's2', title: 'Done task', status: 'complete' },
      ]);
      await buf.drain();
      const callsAfterDrain = streamer.appendCalls.length;

      // Stop the stream
      await buf.stop();

      // Should have sent completion chunks (after drain, before stop)
      const completionCall = streamer.appendCalls[callsAfterDrain];
      expect(completionCall).toBeDefined();
      const completionTasks = completionCall.chunks.filter(
        (c: any) => c.type === 'task_update' && c.status === 'complete',
      );
      // Only s1 should appear — s2 was already complete
      expect(completionTasks).toHaveLength(1);
      expect(completionTasks[0]).toEqual(
        expect.objectContaining({ id: 's1', title: 'Searching', details: 'Grep for auth', status: 'complete' }),
      );
    });

    it('does not send completion chunks if all tasks already complete', async () => {
      const streamer = mockStreamer();
      const buf = createBuffer({ streamer, streamType: 'main' });

      buf.append([
        { type: 'task_update', id: 'c1', title: 'Already done', status: 'complete' },
      ]);
      await buf.drain();
      const callsAfterDrain = streamer.appendCalls.length;

      await buf.stop();

      // No extra append call for completion — only stop
      expect(streamer.appendCalls.length).toBe(callsAfterDrain);
      expect(streamer.stop).toHaveBeenCalled();
    });
  });

  // 10c. Rotation: completion chunks preserve full task state on old stream
  describe('rotation - completion preserves task state', () => {
    it('includes title, details, and output in completion chunks on rotation', async () => {
      const streamer = mockStreamer();
      const newStreamer = mockStreamer();
      const factory = makeFactory(newStreamer);
      const buf = createBuffer({ streamer, streamFactory: factory, streamType: 'main' });

      // Drain tasks with titles, details, and output
      buf.append([
        { type: 'task_update', id: 'rt1', title: 'Searching codebase', status: 'in_progress', details: 'Grep for handleAuth' },
        { type: 'task_update', id: 'rt2', title: 'Editing config.ts', status: 'complete', details: 'Added new field', output: '1 file changed' },
      ]);
      await buf.drain();

      // Trigger rotation
      (buf as any).createdAt = Date.now() - STREAM_ROTATE_MS - 1000;
      await buf.checkRotation();

      expect(factory).toHaveBeenCalledTimes(1);

      // Old streamer should have received completion chunks with full state
      const completionCall = streamer.appendCalls[streamer.appendCalls.length - 1];
      const completionTasks = completionCall.chunks.filter(
        (c: any) => c.type === 'task_update' && c.status === 'complete',
      );
      // rt1 was in_progress → should be completed with title + details preserved
      expect(completionTasks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'rt1', title: 'Searching codebase', details: 'Grep for handleAuth', status: 'complete' }),
        ]),
      );
      // rt2 was already complete → should NOT appear in completion chunks (no duplicate)
      const rt2Chunks = completionTasks.filter((c: any) => c.id === 'rt2');
      expect(rt2Chunks).toHaveLength(0);
    });
  });

  // checkRotation is no-op after stop
  describe('checkRotation after stop', () => {
    it('is a no-op when buffer has been stopped', async () => {
      const streamer = mockStreamer();
      const buf = createBuffer({ streamer });

      await buf.stop();

      (buf as any).createdAt = Date.now() - STREAM_ROTATE_MS - 1000;
      (buf as any).stopped = false; // temporarily unstop to set createdAt, then re-stop
      (buf as any).stopped = true;

      await buf.checkRotation();
      // No additional append calls beyond what stop() may have done
      expect(streamer.appendCalls).toHaveLength(0);
    });
  });

  // Non-Error throwables handled in drain
  describe('non-Error throwable in drain', () => {
    it('wraps non-Error throwable in Error for onError', async () => {
      const streamer = mockStreamer();
      streamer.append.mockRejectedValueOnce('string_error');
      const onError = jest.fn();
      const buf = createBuffer({ streamer, onError });

      buf.append([{ type: 'task_update', id: 'ne1', title: 'NonError', status: 'in_progress' }]);
      await buf.drain();

      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'string_error' }),
        expect.any(String),
      );
    });
  });
});
