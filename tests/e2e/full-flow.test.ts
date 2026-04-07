import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RpcClient } from '../../packages/shared/src/index.js';
import { ProcessManager } from './helpers/process-manager.js';
import type { QueueMessage, ProcessEntry, PersistenceHealth } from '../../packages/shared/src/rpc-types.js';

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

describe('E2E: Full Flow', () => {
  let tempDir: string;
  let manager: ProcessManager;
  let persistenceClient: RpcClient;
  const sockets = {
    socketDir: '',
    dbPath: '',
    persistenceSocket: '',
    gatewaySocket: '',
  };

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'e2e-full-flow-'));
    sockets.socketDir = tempDir;
    sockets.dbPath = join(tempDir, 'test.db');
    sockets.persistenceSocket = join(tempDir, 'persistence.sock');
    sockets.gatewaySocket = join(tempDir, 'gateway.sock');

    manager = new ProcessManager();
    await manager.spawnPersistence(sockets);

    persistenceClient = new RpcClient({
      socketPath: sockets.persistenceSocket,
      reconnect: false,
    });
    await persistenceClient.connect();
    await persistenceClient.call('identify', { type: 'gateway' });
    await persistenceClient.call('registry.register', {
      type: 'gateway',
      pid: process.pid,
      socketPath: sockets.gatewaySocket,
    });
  }, 15000);

  afterAll(async () => {
    await persistenceClient?.close();
    await manager?.cleanupAll();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('persistence is healthy', async () => {
    const health = await persistenceClient.call('health.ping') as PersistenceHealth;
    expect(health.status).toBe('ok');
    expect(health.uptime).toBeGreaterThanOrEqual(0);
  });

  it('gateway registers in persistence registry', async () => {
    const { processes } = await persistenceClient.call('registry.list', {
      type: 'gateway',
    }) as { processes: ProcessEntry[] };
    expect(processes).toHaveLength(1);
    expect(processes[0].pid).toBe(process.pid);
  });

  it('inbound message lifecycle: enqueue → subscribe → deliver → ack', async () => {
    const delivered: QueueMessage[] = [];

    // Create a worker client that subscribes
    const workerClient = new RpcClient({
      socketPath: sockets.persistenceSocket,
      reconnect: false,
    });
    await workerClient.connect();
    await workerClient.call('identify', { type: 'worker', threadKey: 'C-test:T-test' });

    workerClient.registerMethod('deliver.message', (params) => {
      const { message } = params as { message: QueueMessage };
      delivered.push(message);
      return { accepted: true };
    });

    const { id } = await persistenceClient.call('queue.enqueue', {
      queue: 'inbound',
      threadKey: 'C-test:T-test',
      message: { text: 'hello from test', user: 'U123' },
    }) as { id: string };

    await workerClient.call('queue.subscribe', { queue: 'inbound', threadKey: 'C-test:T-test' });

    await waitForCondition(() => delivered.length > 0);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].payload).toMatchObject({ text: 'hello from test' });

    await workerClient.call('queue.ack', { queue: 'inbound', id });

    // Verify completed — no pending messages
    const health = await persistenceClient.call('health.ping') as PersistenceHealth;
    expect(health.queues.inbound.by_thread['C-test:T-test']?.pending ?? 0).toBe(0);

    await workerClient.close();
  });

  it('outbound messages delivered via subscribe', async () => {
    const delivered: QueueMessage[] = [];

    persistenceClient.registerMethod('deliver.message', (params) => {
      const { message } = params as { message: QueueMessage };
      delivered.push(message);
      return { accepted: true };
    });

    await persistenceClient.call('queue.subscribe', { queue: 'outbound' });

    await persistenceClient.call('queue.enqueue', {
      queue: 'outbound',
      threadKey: 'C-test:T-test',
      message: { type: 'postMessage', channel: 'C-test', thread_ts: 'T-test', text: 'reply' },
    });

    await waitForCondition(() => delivered.length > 0);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].payload).toMatchObject({ type: 'postMessage', text: 'reply' });
    await persistenceClient.call('queue.ack', { queue: 'outbound', id: delivered[0].id });
  });

  it('simulated worker registers and processes messages via push delivery', async () => {
    const threadKey = 'C-test:T-worker';
    const delivered: QueueMessage[] = [];

    // Simulate worker connection
    const workerClient = new RpcClient({
      socketPath: sockets.persistenceSocket,
      reconnect: false,
    });
    await workerClient.connect();
    await workerClient.call('identify', { type: 'worker', threadKey });
    await workerClient.call('registry.register', {
      type: 'worker',
      threadKey,
      pid: process.pid,
      socketPath: join(sockets.socketDir, `worker-${threadKey.replace(/[^a-zA-Z0-9._-]/g, '_')}.sock`),
    });

    workerClient.registerMethod('deliver.message', (params) => {
      const { message } = params as { message: QueueMessage };
      delivered.push(message);
      return { accepted: true };
    });

    // Verify worker registered
    const { processes } = await persistenceClient.call('registry.list', {
      type: 'worker',
    }) as { processes: ProcessEntry[] };
    expect(processes.some((p) => p.threadKey === threadKey)).toBe(true);

    // Enqueue inbound message
    const { id } = await persistenceClient.call('queue.enqueue', {
      queue: 'inbound',
      threadKey,
      message: { text: 'for-worker', user: 'U456' },
    }) as { id: string };

    // Worker subscribes and receives pushed message
    await workerClient.call('queue.subscribe', { queue: 'inbound', threadKey });
    await waitForCondition(() => delivered.length > 0);
    expect(delivered).toHaveLength(1);

    await workerClient.call('queue.ack', { queue: 'inbound', id });

    // Cleanup
    await workerClient.call('registry.deregister', { type: 'worker', threadKey });
    await workerClient.close();
  });
});
