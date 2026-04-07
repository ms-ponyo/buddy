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

describe('E2E: Crash Recovery', () => {
  let tempDir: string;
  let manager: ProcessManager;
  const sockets = {
    socketDir: '',
    dbPath: '',
    persistenceSocket: '',
    gatewaySocket: '',
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'e2e-crash-'));
    sockets.socketDir = tempDir;
    sockets.dbPath = join(tempDir, 'test.db');
    sockets.persistenceSocket = join(tempDir, 'persistence.sock');
    sockets.gatewaySocket = join(tempDir, 'gateway.sock');
    manager = new ProcessManager();
  });

  afterEach(async () => {
    await manager?.cleanupAll();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('persistence crash: DB state survives, new client can read after restart', async () => {
    const persistenceProc = await manager.spawnPersistence(sockets);

    // First client enqueues before crash
    const clientBefore = new RpcClient({
      socketPath: sockets.persistenceSocket,
      reconnect: false,
    });
    await clientBefore.connect();
    await clientBefore.call('identify', { type: 'gateway' });

    await clientBefore.call('queue.enqueue', {
      queue: 'inbound',
      threadKey: 'C1:T1',
      message: { text: 'before-crash' },
    });

    // SIGKILL persistence
    await manager.crash(persistenceProc.pid);
    await clientBefore.close();

    // Restart — same DB path, spawnPersistence waits for socket ready
    await manager.spawnPersistence(sockets);

    // New client connects to restarted persistence
    const clientAfter = new RpcClient({
      socketPath: sockets.persistenceSocket,
      reconnect: false,
    });
    await clientAfter.connect();
    await clientAfter.call('identify', { type: 'gateway' });

    // Verify data survived the crash via health metrics
    const health = await clientAfter.call('health.ping') as PersistenceHealth;
    expect(health.queues.inbound.by_thread['C1:T1']?.pending ?? 0).toBe(1);

    // Also verify via subscribe+deliver
    const delivered: QueueMessage[] = [];
    const workerClient = new RpcClient({
      socketPath: sockets.persistenceSocket,
      reconnect: false,
    });
    await workerClient.connect();
    await workerClient.call('identify', { type: 'worker', threadKey: 'C1:T1' });
    workerClient.registerMethod('deliver.message', (params) => {
      const { message } = params as { message: QueueMessage };
      delivered.push(message);
      return { accepted: true };
    });
    await workerClient.call('queue.subscribe', { queue: 'inbound', threadKey: 'C1:T1' });

    await waitForCondition(() => delivered.length > 0);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].payload).toMatchObject({ text: 'before-crash' });

    await workerClient.close();
    await clientAfter.close();
  }, 20000);

  it('worker disconnect: persistence resets messages and deregisters', async () => {
    await manager.spawnPersistence(sockets);

    const gatewayClient = new RpcClient({
      socketPath: sockets.persistenceSocket,
      reconnect: false,
    });
    await gatewayClient.connect();
    await gatewayClient.call('identify', { type: 'gateway' });

    // Simulate worker connection via RPC client
    const delivered: QueueMessage[] = [];
    const workerClient = new RpcClient({
      socketPath: sockets.persistenceSocket,
      reconnect: false,
    });
    await workerClient.connect();
    await workerClient.call('identify', { type: 'worker', threadKey: 'C1:T2' });
    await workerClient.call('registry.register', {
      type: 'worker',
      threadKey: 'C1:T2',
      pid: process.pid,
      socketPath: join(sockets.socketDir, 'worker.sock'),
    });

    workerClient.registerMethod('deliver.message', (params) => {
      const { message } = params as { message: QueueMessage };
      delivered.push(message);
      return { accepted: true };
    });

    // Enqueue + subscribe (message delivered via push)
    await gatewayClient.call('queue.enqueue', {
      queue: 'inbound',
      threadKey: 'C1:T2',
      message: { text: 'will-be-reset' },
    });
    await workerClient.call('queue.subscribe', { queue: 'inbound', threadKey: 'C1:T2' });

    await waitForCondition(() => delivered.length > 0);

    // Simulate crash by closing the RPC connection
    await workerClient.close();
    await new Promise((r) => setTimeout(r, 200));

    // Message should be reset to pending — verify via health
    const health = await gatewayClient.call('health.ping') as PersistenceHealth;
    expect(health.queues.inbound.by_thread['C1:T2']?.pending ?? 0).toBe(1);

    // Worker deregistered
    const { processes } = await gatewayClient.call('registry.list', {
      type: 'worker',
    }) as { processes: ProcessEntry[] };
    expect(processes.some((p) => p.threadKey === 'C1:T2')).toBe(false);

    await gatewayClient.close();
  }, 10000);

  it('gateway disconnect: persistence still accepts new connections', async () => {
    await manager.spawnPersistence(sockets);

    // Gateway connects
    const gatewayClient = new RpcClient({
      socketPath: sockets.persistenceSocket,
      reconnect: false,
    });
    await gatewayClient.connect();
    await gatewayClient.call('identify', { type: 'gateway' });

    // Enqueue a message
    await gatewayClient.call('queue.enqueue', {
      queue: 'inbound',
      threadKey: 'C1:T3',
      message: { text: 'before-gateway-crash' },
    });

    // Gateway "crashes"
    await gatewayClient.close();
    await new Promise((r) => setTimeout(r, 200));

    // New gateway connects — persistence still works
    const newGatewayClient = new RpcClient({
      socketPath: sockets.persistenceSocket,
      reconnect: false,
    });
    await newGatewayClient.connect();
    await newGatewayClient.call('identify', { type: 'gateway' });

    // Data still there — verify via health
    const health = await newGatewayClient.call('health.ping') as PersistenceHealth;
    expect(health.queues.inbound.by_thread['C1:T3']?.pending ?? 0).toBe(1);

    await newGatewayClient.close();
  }, 10000);
});
