import { jest } from '@jest/globals';
import { RpcClient } from '../../packages/shared/src/index.js';
import { setupPersistenceServer, waitForCondition } from './helpers/test-helpers.js';
import type { QueueMessage, SessionRecord, ProcessEntry, PersistenceHealth } from '../../packages/shared/src/rpc-types.js';

describe('Persistence RPC', () => {
  let cleanup: () => Promise<void>;
  let client: RpcClient;
  let serverSocketPath: string;

  beforeAll(async () => {
    const setup = await setupPersistenceServer();
    client = setup.client;
    serverSocketPath = setup.socketPath;
    cleanup = setup.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  describe('queue lifecycle', () => {
    it('enqueue → subscribe → deliver → ack lifecycle', async () => {
      const delivered: QueueMessage[] = [];
      const workerClient = new RpcClient({
        socketPath: serverSocketPath,
        reconnect: false,
      });
      await workerClient.connect();
      await workerClient.call('identify', { type: 'worker', threadKey: 'C1:T1' });

      workerClient.registerMethod('deliver.message', (params) => {
        const { message } = params as { message: QueueMessage };
        delivered.push(message);
        return { accepted: true };
      });

      const { id } = await client.call('queue.enqueue', {
        queue: 'inbound',
        threadKey: 'C1:T1',
        message: { text: 'hello' },
      }) as { id: string };
      expect(id).toBeDefined();

      // Subscribe — triggers delivery of pending message
      await workerClient.call('queue.subscribe', { queue: 'inbound', threadKey: 'C1:T1' });

      await waitForCondition(() => delivered.length > 0);
      expect(delivered).toHaveLength(1);
      expect(delivered[0].id).toBe(id);

      await workerClient.call('queue.ack', { queue: 'inbound', id });

      // Verify completed — health should show 0 pending
      const health = await client.call('health.ping') as PersistenceHealth;
      const threadMetrics = health.queues.inbound.by_thread['C1:T1'];
      expect(threadMetrics?.pending ?? 0).toBe(0);

      await workerClient.close();
    });

    it('nack retries then deadletters', async () => {
      // Verify nack → re-delivery via health metrics (avoids complex timing)
      const workerClient = new RpcClient({
        socketPath: serverSocketPath,
        reconnect: false,
      });
      await workerClient.connect();
      await workerClient.call('identify', { type: 'worker', threadKey: 'C1:T2' });

      let deliveryCount = 0;
      workerClient.registerMethod('deliver.message', () => {
        deliveryCount++;
        return { accepted: true };
      });

      const { id } = await client.call('queue.enqueue', {
        queue: 'inbound',
        threadKey: 'C1:T2',
        message: { text: 'retry-me' },
      }) as { id: string };

      await workerClient.call('queue.subscribe', { queue: 'inbound', threadKey: 'C1:T2' });
      await waitForCondition(() => deliveryCount >= 1);

      // Nack and wait for re-delivery 3 times
      for (let i = 0; i < 3; i++) {
        const prevCount = deliveryCount;
        await workerClient.call('queue.nack', { queue: 'inbound', id });
        if (i < 2) {
          await waitForCondition(() => deliveryCount > prevCount, 3000);
        }
      }

      // After 3 nacks, message should be deadlettered
      await new Promise((r) => setTimeout(r, 100));
      const health = await client.call('health.ping') as PersistenceHealth;
      expect(health.queues.inbound.by_thread['C1:T2']?.pending ?? 0).toBe(0);

      await workerClient.close();
    }, 15000);
  });

  describe('session operations', () => {
    it('upsert → get round-trip', async () => {
      await client.call('session.upsert', {
        threadKey: 'C1:T3',
        data: { sessionId: 'sess-1', cost: 0.05 },
      });

      const { session } = await client.call('session.get', {
        threadKey: 'C1:T3',
      }) as { session: SessionRecord };
      expect(session.sessionId).toBe('sess-1');
      expect(session.cost).toBe(0.05);

      await client.call('session.delete', { threadKey: 'C1:T3' });
    });
  });

  describe('registry operations', () => {
    it('register → list → deregister', async () => {
      await client.call('registry.register', {
        type: 'worker',
        threadKey: 'C1:T4',
        pid: process.pid,
        socketPath: '/tmp/test-worker.sock',
      });

      const { processes } = await client.call('registry.list', {
        type: 'worker',
      }) as { processes: ProcessEntry[] };
      expect(processes.some((p) => p.threadKey === 'C1:T4')).toBe(true);

      await client.call('registry.deregister', { type: 'worker', threadKey: 'C1:T4' });

      const { processes: after } = await client.call('registry.list', {
        type: 'worker',
      }) as { processes: ProcessEntry[] };
      expect(after.some((p) => p.threadKey === 'C1:T4')).toBe(false);
    });
  });

  describe('health', () => {
    it('health.ping returns queue metrics', async () => {
      const health = await client.call('health.ping') as PersistenceHealth;
      expect(health.status).toBe('ok');
      expect(health.uptime).toBeGreaterThanOrEqual(0);
      expect(health.queues.inbound).toBeDefined();
      expect(health.queues.outbound).toBeDefined();
    });
  });

  describe('identify + push delivery', () => {
    it('identify handshake sets client identity', async () => {
      const result = await client.call('identify', { type: 'gateway' });
      expect(result).toEqual({ ok: true });
    });

    it('inbound messages pushed to subscribed worker on enqueue', async () => {
      const delivered: QueueMessage[] = [];

      const workerClient = new RpcClient({
        socketPath: serverSocketPath,
        reconnect: false,
      });
      await workerClient.connect();
      await workerClient.call('identify', { type: 'worker', threadKey: 'C1:T5' });

      workerClient.registerMethod('deliver.message', (params) => {
        const { message } = params as { message: QueueMessage };
        delivered.push(message);
        return { accepted: true };
      });

      await workerClient.call('queue.subscribe', { queue: 'inbound', threadKey: 'C1:T5' });

      // Enqueue inbound for that thread — should be pushed to the worker
      await client.call('queue.enqueue', {
        queue: 'inbound',
        threadKey: 'C1:T5',
        message: { text: 'push-test' },
      });

      await waitForCondition(() => delivered.length > 0);

      expect(delivered).toHaveLength(1);
      expect(delivered[0].payload).toMatchObject({ text: 'push-test' });

      await workerClient.close();
    });

    it('outbound messages pushed to subscribed gateway on enqueue', async () => {
      const dedicated = await setupPersistenceServer();
      const delivered: QueueMessage[] = [];

      const gatewayClient = new RpcClient({
        socketPath: dedicated.socketPath,
        reconnect: false,
      });
      await gatewayClient.connect();
      await gatewayClient.call('identify', { type: 'gateway' });

      gatewayClient.registerMethod('deliver.message', (params) => {
        const { message } = params as { message: QueueMessage };
        delivered.push(message);
        return { accepted: true };
      });

      await gatewayClient.call('queue.subscribe', { queue: 'outbound' });

      // Enqueue outbound — should be pushed to this gateway client
      await gatewayClient.call('queue.enqueue', {
        queue: 'outbound',
        threadKey: 'C1:T6',
        message: { type: 'postMessage', text: 'outbound-push' },
      });

      await waitForCondition(() => delivered.length > 0);

      expect(delivered).toHaveLength(1);
      expect(delivered[0].payload).toMatchObject({ text: 'outbound-push' });

      await gatewayClient.close();
      await dedicated.cleanup();
    });

    it('disconnect triggers resetForThread (crash recovery at RPC level)', async () => {
      const delivered: QueueMessage[] = [];

      const workerClient = new RpcClient({
        socketPath: serverSocketPath,
        reconnect: false,
      });
      await workerClient.connect();
      await workerClient.call('identify', { type: 'worker', threadKey: 'C1:T7' });

      await workerClient.call('registry.register', {
        type: 'worker',
        threadKey: 'C1:T7',
        pid: process.pid,
        socketPath: '/tmp/test.sock',
      });

      workerClient.registerMethod('deliver.message', (params) => {
        const { message } = params as { message: QueueMessage };
        delivered.push(message);
        return { accepted: true };
      });

      await client.call('queue.enqueue', {
        queue: 'inbound',
        threadKey: 'C1:T7',
        message: { text: 'crash-test' },
      });

      await workerClient.call('queue.subscribe', { queue: 'inbound', threadKey: 'C1:T7' });
      await waitForCondition(() => delivered.length > 0);

      // Simulate crash
      await workerClient.close();
      await new Promise((r) => setTimeout(r, 100));

      // Message should be reset to pending — verify via health
      const health = await client.call('health.ping') as PersistenceHealth;
      expect(health.queues.inbound.by_thread['C1:T7']?.pending ?? 0).toBe(1);

      // Worker deregistered
      const { processes } = await client.call('registry.list', {
        type: 'worker',
      }) as { processes: ProcessEntry[] };
      expect(processes.some((p) => p.threadKey === 'C1:T7')).toBe(false);
    });
  });
});
