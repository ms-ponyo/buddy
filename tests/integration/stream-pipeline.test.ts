/**
 * Integration test: Stream messages through the persistence queue.
 *
 * Simulates the full pipeline:
 *   Worker enqueues stream messages → persistence outbound queue →
 *   deliver.message → processOutboundMessage → StreamRouter → fake Slack chatStream
 *
 * Uses real persistence services (in-process) and a real StreamRouter
 * wired to a fake Slack chatStream API.
 */
import { jest } from '@jest/globals';
import type { QueueMessage } from '../../packages/shared/src/rpc-types.js';
import { isStreamMessage } from '../../packages/shared/src/stream-types.js';
import { StreamRouter } from '../../packages/gateway/src/stream-router.js';
import type { StreamFactoryResult } from '../../packages/gateway/src/stream-buffer.js';
import { createFakeSlackApp, type FakeSlackApp, type FakeStreamerHandle } from './helpers/fake-slack-server.js';
import { setupPersistenceServer, waitForCondition } from './helpers/test-helpers.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeStreamRouter(fakeSlack: FakeSlackApp): {
  router: StreamRouter;
  deleteMessage: jest.Mock;
} {
  const deleteMessage = jest.fn<(channel: string, ts: string) => Promise<void>>().mockResolvedValue(undefined);

  const router = new StreamRouter({
    createStream: async (channel: string, threadTs: string, userId: string, _streamType: string) => {
      const streamer = fakeSlack.client.chatStream({
        channel,
        thread_ts: threadTs,
        recipient_user_id: userId,
      });
      // Send initial plan_update (mirrors real gateway behavior)
      const result = await streamer.append({ chunks: [{ type: 'plan_update', title: 'Working' }] });
      return { streamer, ts: result?.ts ?? '' } as StreamFactoryResult;
    },
    rateLimitAcquire: async () => {},
    deleteMessage,
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    },
  });

  return { router, deleteMessage };
}

/**
 * Mirrors the gateway's processOutboundMessage: routes stream messages
 * to StreamRouter, non-stream messages to Slack API.
 */
async function processOutboundMessage(
  fakeSlack: FakeSlackApp,
  router: StreamRouter,
  msg: QueueMessage,
): Promise<void> {
  const payload = msg.payload as Record<string, any>;

  if (isStreamMessage(payload)) {
    await router.handle(payload);
    return;
  }

  const type = payload.type as string;
  switch (type) {
    case 'postMessage': {
      await fakeSlack.client.chat.postMessage({
        channel: payload.channel,
        thread_ts: payload.thread_ts,
        text: payload.text,
      });
      break;
    }
  }
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Stream pipeline — persistence queue to StreamRouter', () => {
  let fakeSlack: FakeSlackApp;
  let cleanup: () => Promise<void>;
  let client: any;
  let router: StreamRouter;
  let deleteMessage: jest.Mock;
  const delivered: QueueMessage[] = [];

  beforeAll(async () => {
    const setup = await setupPersistenceServer();
    client = setup.client;
    cleanup = setup.cleanup;
    fakeSlack = createFakeSlackApp();
    const routerSetup = makeStreamRouter(fakeSlack);
    router = routerSetup.router;
    deleteMessage = routerSetup.deleteMessage;

    // Register deliver.message handler (mirrors gateway)
    client.registerMethod('deliver.message', (params: any) => {
      const { message } = params as { message: QueueMessage };
      delivered.push(message);
      return { accepted: true };
    });

    await client.call('identify', { type: 'gateway' });
    await client.call('queue.subscribe', { queue: 'outbound' });
  });

  afterAll(async () => {
    router.close();
    await cleanup();
  });

  beforeEach(() => {
    fakeSlack.reset();
    delivered.length = 0;
  });

  // ── Test 1: Full stream lifecycle through persistence queue ────────

  it('stream_start → stream_chunk → stream_stop routes through StreamRouter', async () => {
    const threadKey = 'C-pipe:T-pipe';

    // Enqueue stream_start
    await client.call('queue.enqueue', {
      queue: 'outbound',
      threadKey,
      message: { type: 'stream_start', channel: 'C-pipe', threadTs: 'T-pipe', userId: 'U-pipe' },
    });
    await waitForCondition(() => delivered.length >= 1);
    await processOutboundMessage(fakeSlack, router, delivered[0]);
    await client.call('queue.ack', { queue: 'outbound', id: delivered[0].id });

    // stream_start eagerly creates the 'main' buffer (rotation timer starts immediately)
    expect(fakeSlack.getCalls('chatStream')).toHaveLength(1);

    // Enqueue stream_chunk for 'main'
    await client.call('queue.enqueue', {
      queue: 'outbound',
      threadKey,
      message: {
        type: 'stream_chunk',
        channel: 'C-pipe',
        threadTs: 'T-pipe',
        userId: 'U-pipe',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 't1', title: 'Working on it', status: 'in_progress' }],
      },
    });
    await waitForCondition(() => delivered.length >= 2);
    await processOutboundMessage(fakeSlack, router, delivered[1]);
    await client.call('queue.ack', { queue: 'outbound', id: delivered[1].id });

    // chatStream created + initial plan_update + data chunk appended
    expect(fakeSlack.getCalls('chatStream')).toHaveLength(1);
    const appendCalls = fakeSlack.getCalls('chatStream.append');
    expect(appendCalls.length).toBeGreaterThanOrEqual(2); // initial plan_update + data drain

    // Enqueue stream_stop
    await client.call('queue.enqueue', {
      queue: 'outbound',
      threadKey,
      message: { type: 'stream_stop', channel: 'C-pipe', threadTs: 'T-pipe' },
    });
    await waitForCondition(() => delivered.length >= 3);
    await processOutboundMessage(fakeSlack, router, delivered[2]);
    await client.call('queue.ack', { queue: 'outbound', id: delivered[2].id });

    // Stream stopped
    expect(fakeSlack.getCalls('chatStream.stop')).toHaveLength(1);
  });

  // ── Test 2: Stream messages interleaved with non-stream messages ───

  it('correctly routes stream and non-stream messages from the same queue', async () => {
    const threadKey = 'C-mix:T-mix';

    // Enqueue a postMessage (non-stream)
    await client.call('queue.enqueue', {
      queue: 'outbound',
      threadKey,
      message: { type: 'postMessage', channel: 'C-mix', thread_ts: 'T-mix', text: 'Regular message' },
    });
    await waitForCondition(() => delivered.length >= 1);
    await processOutboundMessage(fakeSlack, router, delivered[0]);
    await client.call('queue.ack', { queue: 'outbound', id: delivered[0].id });

    // Enqueue stream_chunk (stream)
    await client.call('queue.enqueue', {
      queue: 'outbound',
      threadKey,
      message: {
        type: 'stream_chunk',
        channel: 'C-mix',
        threadTs: 'T-mix',
        userId: 'U-mix',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 'mx1', title: 'Streaming', status: 'in_progress' }],
      },
    });
    await waitForCondition(() => delivered.length >= 2);
    await processOutboundMessage(fakeSlack, router, delivered[1]);
    await client.call('queue.ack', { queue: 'outbound', id: delivered[1].id });

    // Enqueue another postMessage (non-stream)
    await client.call('queue.enqueue', {
      queue: 'outbound',
      threadKey,
      message: { type: 'postMessage', channel: 'C-mix', thread_ts: 'T-mix', text: 'Another regular' },
    });
    await waitForCondition(() => delivered.length >= 3);
    await processOutboundMessage(fakeSlack, router, delivered[2]);
    await client.call('queue.ack', { queue: 'outbound', id: delivered[2].id });

    // Verify: 2 postMessage calls + 1 chatStream creation
    expect(fakeSlack.getCalls('chat.postMessage')).toHaveLength(2);
    expect(fakeSlack.getCalls('chatStream')).toHaveLength(1);

    // Cleanup
    await processOutboundMessage(fakeSlack, router, {
      ...delivered[0],
      payload: { type: 'stream_stop', channel: 'C-mix', threadTs: 'T-mix' },
    });
  });

  // ── Test 3: Multiple stream types (main + todo) in same thread ────

  it('main and todo streams create separate chatStream instances', async () => {
    const threadKey = 'C-multi:T-multi';

    // stream_chunk for 'main'
    await client.call('queue.enqueue', {
      queue: 'outbound',
      threadKey,
      message: {
        type: 'stream_chunk',
        channel: 'C-multi',
        threadTs: 'T-multi',
        userId: 'U-multi',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 'mm1', title: 'Main work', status: 'in_progress' }],
      },
    });
    await waitForCondition(() => delivered.length >= 1);
    await processOutboundMessage(fakeSlack, router, delivered[0]);
    await client.call('queue.ack', { queue: 'outbound', id: delivered[0].id });

    // stream_chunk for 'todo'
    await client.call('queue.enqueue', {
      queue: 'outbound',
      threadKey,
      message: {
        type: 'stream_chunk',
        channel: 'C-multi',
        threadTs: 'T-multi',
        userId: 'U-multi',
        streamType: 'todo',
        chunks: [{ type: 'task_update', id: 'td1', title: 'Todo item', status: 'in_progress' }],
      },
    });
    await waitForCondition(() => delivered.length >= 2);
    await processOutboundMessage(fakeSlack, router, delivered[1]);
    await client.call('queue.ack', { queue: 'outbound', id: delivered[1].id });

    // Two separate chatStream instances created
    expect(fakeSlack.getCalls('chatStream')).toHaveLength(2);

    // stream_stop closes both
    await client.call('queue.enqueue', {
      queue: 'outbound',
      threadKey,
      message: { type: 'stream_stop', channel: 'C-multi', threadTs: 'T-multi' },
    });
    await waitForCondition(() => delivered.length >= 3);
    await processOutboundMessage(fakeSlack, router, delivered[2]);
    await client.call('queue.ack', { queue: 'outbound', id: delivered[2].id });

    expect(fakeSlack.getCalls('chatStream.stop')).toHaveLength(2);
  });

  // ── Test 4: stream_pause stops streams, new chunks create fresh ones ─

  it('stream_pause stops active streams and allows fresh streams on next chunk', async () => {
    const threadKey = 'C-pause:T-pause';

    // Create a stream
    await client.call('queue.enqueue', {
      queue: 'outbound',
      threadKey,
      message: {
        type: 'stream_chunk',
        channel: 'C-pause',
        threadTs: 'T-pause',
        userId: 'U-pause',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 'p1', title: 'Before pause', status: 'in_progress' }],
      },
    });
    await waitForCondition(() => delivered.length >= 1);
    await processOutboundMessage(fakeSlack, router, delivered[0]);
    await client.call('queue.ack', { queue: 'outbound', id: delivered[0].id });

    const streamsBefore = fakeSlack.getCalls('chatStream').length;

    // Pause
    await client.call('queue.enqueue', {
      queue: 'outbound',
      threadKey,
      message: { type: 'stream_pause', channel: 'C-pause', threadTs: 'T-pause' },
    });
    await waitForCondition(() => delivered.length >= 2);
    await processOutboundMessage(fakeSlack, router, delivered[1]);
    await client.call('queue.ack', { queue: 'outbound', id: delivered[1].id });

    expect(fakeSlack.getCalls('chatStream.stop').length).toBeGreaterThanOrEqual(1);

    // Send new chunk after pause — should create a fresh stream
    await client.call('queue.enqueue', {
      queue: 'outbound',
      threadKey,
      message: {
        type: 'stream_chunk',
        channel: 'C-pause',
        threadTs: 'T-pause',
        userId: 'U-pause',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 'p2', title: 'After pause', status: 'in_progress' }],
      },
    });
    await waitForCondition(() => delivered.length >= 3);
    await processOutboundMessage(fakeSlack, router, delivered[2]);
    await client.call('queue.ack', { queue: 'outbound', id: delivered[2].id });

    // A new chatStream should have been created
    expect(fakeSlack.getCalls('chatStream').length).toBe(streamsBefore + 1);

    // Cleanup
    await processOutboundMessage(fakeSlack, router, {
      ...delivered[0],
      payload: { type: 'stream_stop', channel: 'C-pause', threadTs: 'T-pause' },
    });
  });

  // ── Test 5: Multiple threads don't interfere ──────────────────────

  it('streams for different threads are independent', async () => {
    // Thread A
    await client.call('queue.enqueue', {
      queue: 'outbound',
      threadKey: 'C-A:T-A',
      message: {
        type: 'stream_chunk',
        channel: 'C-A',
        threadTs: 'T-A',
        userId: 'U-A',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 'a1', title: 'Thread A', status: 'in_progress' }],
      },
    });
    await waitForCondition(() => delivered.length >= 1);
    await processOutboundMessage(fakeSlack, router, delivered[0]);
    await client.call('queue.ack', { queue: 'outbound', id: delivered[0].id });

    // Thread B
    await client.call('queue.enqueue', {
      queue: 'outbound',
      threadKey: 'C-B:T-B',
      message: {
        type: 'stream_chunk',
        channel: 'C-B',
        threadTs: 'T-B',
        userId: 'U-B',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 'b1', title: 'Thread B', status: 'in_progress' }],
      },
    });
    await waitForCondition(() => delivered.length >= 2);
    await processOutboundMessage(fakeSlack, router, delivered[1]);
    await client.call('queue.ack', { queue: 'outbound', id: delivered[1].id });

    // Two separate chatStream instances (one per thread)
    expect(fakeSlack.getCalls('chatStream')).toHaveLength(2);

    // Stop thread A only
    await client.call('queue.enqueue', {
      queue: 'outbound',
      threadKey: 'C-A:T-A',
      message: { type: 'stream_stop', channel: 'C-A', threadTs: 'T-A' },
    });
    await waitForCondition(() => delivered.length >= 3);
    await processOutboundMessage(fakeSlack, router, delivered[2]);
    await client.call('queue.ack', { queue: 'outbound', id: delivered[2].id });

    // Only 1 stream stopped (thread A)
    expect(fakeSlack.getCalls('chatStream.stop')).toHaveLength(1);

    // Thread B can still receive chunks
    await client.call('queue.enqueue', {
      queue: 'outbound',
      threadKey: 'C-B:T-B',
      message: {
        type: 'stream_chunk',
        channel: 'C-B',
        threadTs: 'T-B',
        userId: 'U-B',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 'b2', title: 'Thread B continued', status: 'in_progress' }],
      },
    });
    await waitForCondition(() => delivered.length >= 4);
    await processOutboundMessage(fakeSlack, router, delivered[3]);
    await client.call('queue.ack', { queue: 'outbound', id: delivered[3].id });

    // No new chatStream — reuses existing buffer for thread B
    expect(fakeSlack.getCalls('chatStream')).toHaveLength(2);

    // Cleanup thread B
    await processOutboundMessage(fakeSlack, router, {
      ...delivered[0],
      payload: { type: 'stream_stop', channel: 'C-B', threadTs: 'T-B' },
    });
  });

  // ── Test 6: isStreamMessage correctly classifies all message types ─

  it('isStreamMessage identifies stream messages and rejects non-stream messages', () => {
    // Stream messages
    expect(isStreamMessage({ type: 'stream_start', channel: 'C', threadTs: 'T', userId: 'U' })).toBe(true);
    expect(isStreamMessage({ type: 'stream_chunk', channel: 'C', threadTs: 'T', userId: 'U', streamType: 'main', chunks: [] })).toBe(true);
    expect(isStreamMessage({ type: 'stream_pause', channel: 'C', threadTs: 'T' })).toBe(true);
    expect(isStreamMessage({ type: 'stream_stop', channel: 'C', threadTs: 'T' })).toBe(true);

    // Non-stream messages
    expect(isStreamMessage({ type: 'postMessage', channel: 'C', text: 'hello' })).toBe(false);
    expect(isStreamMessage({ type: 'fileUpload', channel_id: 'C' })).toBe(false);
    expect(isStreamMessage({ type: 'interactivePrompt', callbackId: 'cb' })).toBe(false);
    expect(isStreamMessage(null)).toBe(false);
    expect(isStreamMessage(undefined)).toBe(false);
    expect(isStreamMessage('string')).toBe(false);
  });
});
