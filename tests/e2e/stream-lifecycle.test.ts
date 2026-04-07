/**
 * E2E test: Full stream lifecycle with real persistence process.
 *
 * Spawns a real persistence process, simulates both worker and gateway
 * communication patterns:
 *   Worker enqueues stream messages → persistence → gateway receives via
 *   deliver.message → routes through StreamRouter → fake Slack chatStream
 *
 * This tests the actual persistence queue, delivery loop, and serialization.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RpcClient } from '../../packages/shared/src/index.js';
import { isStreamMessage } from '../../packages/shared/src/stream-types.js';
import type { QueueMessage } from '../../packages/shared/src/rpc-types.js';
import { ProcessManager } from './helpers/process-manager.js';

// ── Helpers ──────────────────────────────────────────────────────────

function waitForCondition(fn: () => boolean, timeoutMs = 5000, intervalMs = 50): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (fn()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitForCondition timed out'));
      setTimeout(check, intervalMs);
    };
    check();
  });
}

interface StreamCall {
  method: string;
  args: Record<string, unknown>;
}

function createFakeStreamHandler() {
  const calls: StreamCall[] = [];
  let streamCounter = 0;

  return {
    calls,
    getCalls: (method?: string) => method ? calls.filter((c) => c.method === method) : calls,
    reset: () => { calls.length = 0; streamCounter = 0; },
    handleMessage: (msg: QueueMessage) => {
      const payload = msg.payload as Record<string, any>;

      if (!isStreamMessage(payload)) {
        calls.push({ method: 'nonStream', args: payload });
        return;
      }

      switch (payload.type) {
        case 'stream_start':
          calls.push({ method: 'stream_start', args: { channel: payload.channel, threadTs: payload.threadTs, userId: payload.userId } });
          break;
        case 'stream_chunk': {
          streamCounter++;
          calls.push({
            method: 'stream_chunk',
            args: {
              channel: payload.channel,
              threadTs: payload.threadTs,
              streamType: payload.streamType,
              chunkCount: (payload.chunks as unknown[]).length,
              seq: streamCounter,
            },
          });
          break;
        }
        case 'stream_pause':
          calls.push({ method: 'stream_pause', args: { channel: payload.channel, threadTs: payload.threadTs } });
          break;
        case 'stream_stop':
          calls.push({ method: 'stream_stop', args: { channel: payload.channel, threadTs: payload.threadTs } });
          break;
      }
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('E2E: Stream Lifecycle', () => {
  let tempDir: string;
  let manager: ProcessManager;
  let gatewayClient: RpcClient;
  let workerClient: RpcClient;
  const sockets = {
    socketDir: '',
    dbPath: '',
    persistenceSocket: '',
    gatewaySocket: '',
  };

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'e2e-stream-'));
    sockets.socketDir = tempDir;
    sockets.dbPath = join(tempDir, 'test.db');
    sockets.persistenceSocket = join(tempDir, 'persistence.sock');
    sockets.gatewaySocket = join(tempDir, 'gateway.sock');

    // Spawn real persistence process
    manager = new ProcessManager();
    await manager.spawnPersistence(sockets);

    // Gateway client — subscribes to outbound queue
    gatewayClient = new RpcClient({ socketPath: sockets.persistenceSocket, reconnect: false });
    await gatewayClient.connect();
    await gatewayClient.call('identify', { type: 'gateway' });
    await gatewayClient.call('registry.register', {
      type: 'gateway',
      pid: process.pid,
      socketPath: sockets.gatewaySocket,
    });

    // Worker client — enqueues stream messages
    workerClient = new RpcClient({ socketPath: sockets.persistenceSocket, reconnect: false });
    await workerClient.connect();
    await workerClient.call('identify', { type: 'worker', threadKey: 'C-e2e:T-e2e' });
  }, 15000);

  afterAll(async () => {
    await workerClient?.close();
    await gatewayClient?.close();
    await manager?.cleanupAll();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── Test 1: Full stream lifecycle: start → chunks → stop ──────────

  it('worker enqueues stream messages that are delivered to gateway in order', async () => {
    const delivered: QueueMessage[] = [];
    const handler = createFakeStreamHandler();

    gatewayClient.registerMethod('deliver.message', (params) => {
      const { message } = params as { message: QueueMessage };
      delivered.push(message);
      handler.handleMessage(message);
      return { accepted: true };
    });

    await gatewayClient.call('queue.subscribe', { queue: 'outbound' });

    // Worker enqueues stream_start
    await workerClient.call('queue.enqueue', {
      queue: 'outbound',
      threadKey: 'C-e2e:T-e2e',
      message: { type: 'stream_start', channel: 'C-e2e', threadTs: 'T-e2e', userId: 'U-e2e' },
    });

    await waitForCondition(() => delivered.length >= 1);
    await gatewayClient.call('queue.ack', { queue: 'outbound', id: delivered[0].id });

    // Worker enqueues main stream chunks
    for (let i = 0; i < 3; i++) {
      await workerClient.call('queue.enqueue', {
        queue: 'outbound',
        threadKey: 'C-e2e:T-e2e',
        message: {
          type: 'stream_chunk',
          channel: 'C-e2e',
          threadTs: 'T-e2e',
          userId: 'U-e2e',
          streamType: 'main',
          chunks: [{ type: 'task_update', id: `task-${i}`, title: `Step ${i}`, status: 'in_progress' }],
        },
      });
    }

    await waitForCondition(() => delivered.length >= 4);
    for (let i = 1; i < 4; i++) {
      await gatewayClient.call('queue.ack', { queue: 'outbound', id: delivered[i].id });
    }

    // Worker enqueues stream_stop
    await workerClient.call('queue.enqueue', {
      queue: 'outbound',
      threadKey: 'C-e2e:T-e2e',
      message: { type: 'stream_stop', channel: 'C-e2e', threadTs: 'T-e2e' },
    });

    await waitForCondition(() => delivered.length >= 5);
    await gatewayClient.call('queue.ack', { queue: 'outbound', id: delivered[4].id });

    // Verify order: stream_start, 3 chunks, stream_stop
    expect(handler.getCalls('stream_start')).toHaveLength(1);
    expect(handler.getCalls('stream_chunk')).toHaveLength(3);
    expect(handler.getCalls('stream_stop')).toHaveLength(1);

    // Verify delivery order matches enqueue order
    const types = handler.calls.map((c) => c.method);
    expect(types).toEqual(['stream_start', 'stream_chunk', 'stream_chunk', 'stream_chunk', 'stream_stop']);
  });

  // ── Test 2: Multiple stream types (main + todo) ───────────────────

  it('main and todo stream chunks are delivered separately', async () => {
    const delivered: QueueMessage[] = [];
    const handler = createFakeStreamHandler();

    // Re-register deliver handler (clears previous)
    gatewayClient.registerMethod('deliver.message', (params) => {
      const { message } = params as { message: QueueMessage };
      delivered.push(message);
      handler.handleMessage(message);
      return { accepted: true };
    });

    const threadKey = 'C-e2e-multi:T-e2e-multi';

    // Enqueue main chunk
    await workerClient.call('queue.enqueue', {
      queue: 'outbound',
      threadKey,
      message: {
        type: 'stream_chunk',
        channel: 'C-e2e-multi',
        threadTs: 'T-e2e-multi',
        userId: 'U-e2e',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 'main-1', title: 'Main work', status: 'in_progress' }],
      },
    });

    // Enqueue todo chunk
    await workerClient.call('queue.enqueue', {
      queue: 'outbound',
      threadKey,
      message: {
        type: 'stream_chunk',
        channel: 'C-e2e-multi',
        threadTs: 'T-e2e-multi',
        userId: 'U-e2e',
        streamType: 'todo',
        chunks: [{ type: 'task_update', id: 'todo-1', title: 'Todo item', status: 'in_progress' }],
      },
    });

    await waitForCondition(() => delivered.length >= 2);
    for (const msg of delivered) {
      await gatewayClient.call('queue.ack', { queue: 'outbound', id: msg.id });
    }

    // Verify both stream types were delivered
    const chunks = handler.getCalls('stream_chunk');
    expect(chunks).toHaveLength(2);

    const streamTypes = chunks.map((c) => c.args.streamType);
    expect(streamTypes).toContain('main');
    expect(streamTypes).toContain('todo');
  });

  // ── Test 3: Stream messages interleaved with non-stream ───────────

  it('stream and non-stream messages coexist in the same queue', async () => {
    const delivered: QueueMessage[] = [];
    const handler = createFakeStreamHandler();

    gatewayClient.registerMethod('deliver.message', (params) => {
      const { message } = params as { message: QueueMessage };
      delivered.push(message);
      handler.handleMessage(message);
      return { accepted: true };
    });

    const threadKey = 'C-e2e-mix:T-e2e-mix';

    // Non-stream message
    await workerClient.call('queue.enqueue', {
      queue: 'outbound',
      threadKey,
      message: { type: 'postMessage', channel: 'C-e2e-mix', thread_ts: 'T-e2e-mix', text: 'Regular text' },
    });

    // Stream message
    await workerClient.call('queue.enqueue', {
      queue: 'outbound',
      threadKey,
      message: {
        type: 'stream_chunk',
        channel: 'C-e2e-mix',
        threadTs: 'T-e2e-mix',
        userId: 'U-e2e',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 'mix-1', title: 'Streamed', status: 'in_progress' }],
      },
    });

    // Another non-stream message
    await workerClient.call('queue.enqueue', {
      queue: 'outbound',
      threadKey,
      message: { type: 'postMessage', channel: 'C-e2e-mix', thread_ts: 'T-e2e-mix', text: 'Another regular' },
    });

    await waitForCondition(() => delivered.length >= 3);
    for (const msg of delivered) {
      await gatewayClient.call('queue.ack', { queue: 'outbound', id: msg.id });
    }

    // Verify both types processed
    expect(handler.getCalls('nonStream')).toHaveLength(2);
    expect(handler.getCalls('stream_chunk')).toHaveLength(1);

    // Verify ordering preserved
    const methods = handler.calls.map((c) => c.method);
    expect(methods).toEqual(['nonStream', 'stream_chunk', 'nonStream']);
  });

  // ── Test 4: stream_pause and resume ───────────────────────────────

  it('stream_pause followed by new chunks creates fresh stream context', async () => {
    const delivered: QueueMessage[] = [];
    const handler = createFakeStreamHandler();

    gatewayClient.registerMethod('deliver.message', (params) => {
      const { message } = params as { message: QueueMessage };
      delivered.push(message);
      handler.handleMessage(message);
      return { accepted: true };
    });

    const threadKey = 'C-e2e-pause:T-e2e-pause';

    // Chunk before pause
    await workerClient.call('queue.enqueue', {
      queue: 'outbound',
      threadKey,
      message: {
        type: 'stream_chunk',
        channel: 'C-e2e-pause', threadTs: 'T-e2e-pause', userId: 'U-e2e',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 'pre-pause', title: 'Before', status: 'in_progress' }],
      },
    });

    await waitForCondition(() => delivered.length >= 1);
    await gatewayClient.call('queue.ack', { queue: 'outbound', id: delivered[0].id });

    // Pause
    await workerClient.call('queue.enqueue', {
      queue: 'outbound',
      threadKey,
      message: { type: 'stream_pause', channel: 'C-e2e-pause', threadTs: 'T-e2e-pause' },
    });

    await waitForCondition(() => delivered.length >= 2);
    await gatewayClient.call('queue.ack', { queue: 'outbound', id: delivered[1].id });

    // Chunk after pause
    await workerClient.call('queue.enqueue', {
      queue: 'outbound',
      threadKey,
      message: {
        type: 'stream_chunk',
        channel: 'C-e2e-pause', threadTs: 'T-e2e-pause', userId: 'U-e2e',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 'post-pause', title: 'After', status: 'in_progress' }],
      },
    });

    await waitForCondition(() => delivered.length >= 3);
    await gatewayClient.call('queue.ack', { queue: 'outbound', id: delivered[2].id });

    // Verify: chunk, pause, chunk
    const methods = handler.calls.map((c) => c.method);
    expect(methods).toEqual(['stream_chunk', 'stream_pause', 'stream_chunk']);

    // Cleanup
    await workerClient.call('queue.enqueue', {
      queue: 'outbound',
      threadKey,
      message: { type: 'stream_stop', channel: 'C-e2e-pause', threadTs: 'T-e2e-pause' },
    });
    await waitForCondition(() => delivered.length >= 4);
    await gatewayClient.call('queue.ack', { queue: 'outbound', id: delivered[3].id });
  });

  // ── Test 5: nack and redelivery of stream messages ────────────────

  it('nacked stream message is redelivered', async () => {
    const delivered: QueueMessage[] = [];
    let nackOnFirst = true;

    gatewayClient.registerMethod('deliver.message', (params) => {
      const { message } = params as { message: QueueMessage };
      delivered.push(message);
      return { accepted: true };
    });

    const threadKey = 'C-e2e-nack:T-e2e-nack';

    // Enqueue a stream chunk
    const { id } = await workerClient.call('queue.enqueue', {
      queue: 'outbound',
      threadKey,
      message: {
        type: 'stream_chunk',
        channel: 'C-e2e-nack', threadTs: 'T-e2e-nack', userId: 'U-e2e',
        streamType: 'main',
        chunks: [{ type: 'task_update', id: 'nack-1', title: 'Will nack first', status: 'in_progress' }],
      },
    }) as { id: string };

    // Wait for first delivery, then nack
    await waitForCondition(() => delivered.length >= 1);
    await gatewayClient.call('queue.nack', { queue: 'outbound', id });

    // Wait for redelivery
    await waitForCondition(() => delivered.length >= 2, 10000);

    // Same message redelivered
    expect(delivered[1].payload).toMatchObject({ type: 'stream_chunk', streamType: 'main' });

    // Ack the redelivery
    await gatewayClient.call('queue.ack', { queue: 'outbound', id });
  }, 15000);
});
