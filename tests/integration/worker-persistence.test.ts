import { jest } from '@jest/globals';
import { RpcClient } from '../../packages/shared/src/index.js';
import { setupPersistenceServer, waitForCondition } from './helpers/test-helpers.js';
import type { QueueMessage, ProcessEntry, SessionRecord } from '../../packages/shared/src/rpc-types.js';

describe('Worker-Persistence Integration', () => {
  let cleanup: () => Promise<void>;
  let workerClient: RpcClient;
  let serverSocketPath: string;
  const delivered: QueueMessage[] = [];

  beforeAll(async () => {
    const setup = await setupPersistenceServer();
    serverSocketPath = setup.socketPath;

    // The setup client acts as a gateway; create a separate worker client
    workerClient = new RpcClient({ socketPath: serverSocketPath, reconnect: false });
    await workerClient.connect();

    // Register deliver.message handler
    workerClient.registerMethod('deliver.message', (params) => {
      const { message } = params as { message: QueueMessage };
      delivered.push(message);
      return { accepted: true };
    });

    cleanup = async () => {
      await workerClient.close();
      await setup.cleanup();
    };
  });

  afterAll(async () => {
    await cleanup();
  });

  it('worker registers via identify + registry.register', async () => {
    await workerClient.call('identify', { type: 'worker', threadKey: 'C1:T10' });
    await workerClient.call('registry.register', {
      type: 'worker',
      threadKey: 'C1:T10',
      pid: process.pid,
      socketPath: '/tmp/worker-C1_T10.sock',
    });

    const { processes } = await workerClient.call('registry.list', {
      type: 'worker',
    }) as { processes: ProcessEntry[] };
    expect(processes.some((p) => p.threadKey === 'C1:T10')).toBe(true);
  });

  it('worker subscribes and receives pushed inbound messages, acks', async () => {
    delivered.length = 0;

    // Subscribe to inbound messages
    await workerClient.call('queue.subscribe', { queue: 'inbound', threadKey: 'C1:T10' });

    // Enqueue a message (simulating gateway enqueue)
    await workerClient.call('queue.enqueue', {
      queue: 'inbound',
      threadKey: 'C1:T10',
      message: { text: 'process-me' },
    });

    // Wait for delivery
    await waitForCondition(() => delivered.length > 0);
    expect(delivered).toHaveLength(1);

    // Ack
    await workerClient.call('queue.ack', {
      queue: 'inbound',
      id: delivered[0].id,
    });
  });

  it('worker enqueues outbound messages', async () => {
    const outboundDelivered: QueueMessage[] = [];

    // Create a gateway client to subscribe to outbound
    const gatewayClient = new RpcClient({ socketPath: serverSocketPath, reconnect: false });
    await gatewayClient.connect();
    await gatewayClient.call('identify', { type: 'gateway' });

    gatewayClient.registerMethod('deliver.message', (params) => {
      const { message } = params as { message: QueueMessage };
      outboundDelivered.push(message);
      return { accepted: true };
    });

    await gatewayClient.call('queue.subscribe', { queue: 'outbound' });

    await workerClient.call('queue.enqueue', {
      queue: 'outbound',
      threadKey: 'C1:T10',
      message: { type: 'postMessage', channel: 'C1', thread_ts: 'T10', text: 'reply' },
    });

    await waitForCondition(() => outboundDelivered.length > 0);
    expect(outboundDelivered).toHaveLength(1);
    expect(outboundDelivered[0].payload).toMatchObject({ type: 'postMessage', text: 'reply' });

    await gatewayClient.close();
  });

  it('session CRUD through RPC', async () => {
    // Create
    await workerClient.call('session.upsert', {
      threadKey: 'C1:T10',
      data: { sessionId: 'worker-sess-1', cost: 0.01 },
    });

    // Read
    const { session } = await workerClient.call('session.get', {
      threadKey: 'C1:T10',
    }) as { session: SessionRecord };
    expect(session.sessionId).toBe('worker-sess-1');

    // Update
    await workerClient.call('session.upsert', {
      threadKey: 'C1:T10',
      data: { cost: 0.02 },
    });
    const { session: updated } = await workerClient.call('session.get', {
      threadKey: 'C1:T10',
    }) as { session: SessionRecord };
    expect(updated.cost).toBe(0.02);
    expect(updated.sessionId).toBe('worker-sess-1'); // preserved

    // Delete
    await workerClient.call('session.delete', { threadKey: 'C1:T10' });
    const { session: deleted } = await workerClient.call('session.get', {
      threadKey: 'C1:T10',
    }) as { session: SessionRecord | null };
    expect(deleted).toBeNull();
  });

  it('worker deregisters on shutdown', async () => {
    await workerClient.call('registry.deregister', { type: 'worker', threadKey: 'C1:T10' });

    const { processes } = await workerClient.call('registry.list', {
      type: 'worker',
    }) as { processes: ProcessEntry[] };
    expect(processes.some((p) => p.threadKey === 'C1:T10')).toBe(false);
  });
});
