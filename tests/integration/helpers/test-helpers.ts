import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../../../packages/persistence/src/database.js';
import { QueueService } from '../../../packages/persistence/src/queue-service.js';
import { SessionService } from '../../../packages/persistence/src/session-service.js';
import { RegistryService } from '../../../packages/persistence/src/registry-service.js';
import { HealthService } from '../../../packages/persistence/src/health-service.js';
import { DeliveryLoop } from '../../../packages/persistence/src/delivery-loop.js';
import { RpcServer, RpcClient } from '../../../packages/shared/src/index.js';
import type { QueueName } from '../../../packages/shared/src/rpc-types.js';
import type Database from 'better-sqlite3';

let tempDirCounter = 0;

export function createTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `buddy-test-${process.pid}-${tempDirCounter++}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function createTempDb(): { db: Database.Database; dbPath: string; cleanup: () => void } {
  const { dir, cleanup: cleanupDir } = createTempDir();
  const dbPath = join(dir, 'test.db');
  const db = openDatabase(dbPath);
  return {
    db,
    dbPath,
    cleanup: () => {
      db.close();
      cleanupDir();
    },
  };
}

export function createTempSocket(name: string): { socketPath: string; cleanup: () => void } {
  const { dir, cleanup } = createTempDir();
  return { socketPath: join(dir, `${name}.sock`), cleanup };
}

export interface PersistenceServices {
  queue: QueueService;
  sessions: SessionService;
  registry: RegistryService;
  health: HealthService;
}

export async function setupPersistenceServer(dbPath?: string, socketPath?: string): Promise<{
  server: RpcServer;
  client: RpcClient;
  services: PersistenceServices;
  db: Database.Database;
  socketPath: string;
  cleanup: () => Promise<void>;
}> {
  const { dir, cleanup: cleanupDir } = createTempDir();
  const actualDbPath = dbPath ?? join(dir, 'test.db');
  const actualSocketPath = socketPath ?? join(dir, 'persistence.sock');

  const db = openDatabase(actualDbPath);
  const services = {
    queue: new QueueService(db),
    sessions: new SessionService(db),
    registry: new RegistryService(db),
    health: new HealthService(db),
  };

  // Wire up the same RPC methods as the real persistence server
  const clientIdentities = new Map<string, { type: string; threadKey?: string }>();
  const subscriptions = new Map<string, DeliveryLoop>();
  let dbOpen = true;

  function subscriptionKey(queue: QueueName, threadKey?: string): string {
    return threadKey ? `${queue}:${threadKey}` : `${queue}:*`;
  }

  function wakeSubscription(queue: QueueName, threadKey: string): void {
    const exactKey = subscriptionKey(queue, threadKey);
    subscriptions.get(exactKey)?.wake();
    const wildcardKey = subscriptionKey(queue);
    subscriptions.get(wildcardKey)?.wake();
  }

  const server = new RpcServer({
    socketPath: actualSocketPath,
    onDisconnect: (clientId) => {
      // Stop delivery loops for this client
      for (const [key, loop] of subscriptions) {
        if (loop.clientId === clientId) {
          loop.stop();
          subscriptions.delete(key);
        }
      }
      const identity = clientIdentities.get(clientId);
      if (dbOpen && identity?.type === 'worker' && identity.threadKey) {
        services.queue.resetForThread(identity.threadKey);
        services.registry.deregister('worker', identity.threadKey);
      }
      clientIdentities.delete(clientId);
    },
  });

  // Register all methods (mirrors packages/persistence/src/index.ts)
  server.registerMethod('identify', (params, clientId) => {
    const { type, threadKey } = params as { type: string; threadKey?: string };
    clientIdentities.set(clientId, { type, threadKey });
    return { ok: true };
  });

  server.registerMethod('queue.enqueue', (params) => {
    const { queue, message, threadKey } = params as any;
    const result = services.queue.enqueue(queue, threadKey, message);
    wakeSubscription(queue, threadKey);
    return result;
  });

  server.registerMethod('queue.subscribe', (params, clientId) => {
    const { queue, threadKey } = params as { queue: QueueName; threadKey?: string };
    const key = subscriptionKey(queue, threadKey);
    subscriptions.get(key)?.stop();

    const loop = new DeliveryLoop({
      queue,
      threadKey,
      clientId,
      server,
      queueService: services.queue,
    });
    subscriptions.set(key, loop);
    loop.start();
    return { ok: true };
  });

  server.registerMethod('queue.ack', (params) => {
    const { queue, id } = params as any;
    services.queue.ack(queue, id);
    return {};
  });

  server.registerMethod('queue.nack', (params) => {
    const { queue, id } = params as any;
    const threadKey = services.queue.nack(queue, id);
    if (threadKey) {
      wakeSubscription(queue, threadKey);
    }
    return {};
  });

  server.registerMethod('queue.deadletter', (params) => {
    const { queue, id, reason } = params as any;
    services.queue.deadletter(queue, id, reason);
    return {};
  });

  server.registerMethod('session.get', (params) => {
    const { threadKey } = params as any;
    return services.sessions.get(threadKey);
  });

  server.registerMethod('session.upsert', (params) => {
    const { threadKey, data } = params as any;
    services.sessions.upsert(threadKey, data);
    return {};
  });

  server.registerMethod('session.delete', (params) => {
    const { threadKey } = params as any;
    services.sessions.delete(threadKey);
    return {};
  });

  server.registerMethod('session.list', () => {
    return services.sessions.list();
  });

  server.registerMethod('registry.register', (params) => {
    const { type, threadKey, pid, socketPath: sp } = params as any;
    services.registry.register(type, threadKey, pid, sp);
    return {};
  });

  server.registerMethod('registry.deregister', (params) => {
    const { type, threadKey } = params as any;
    services.registry.deregister(type, threadKey);
    return {};
  });

  server.registerMethod('registry.list', (params) => {
    const { type } = (params || {}) as any;
    return { processes: services.registry.list(type) };
  });

  server.registerMethod('health.ping', () => {
    return services.health.getHealth();
  });

  await server.listen();

  const client = new RpcClient({ socketPath: actualSocketPath, reconnect: false });
  await client.connect();

  return {
    server,
    client,
    services,
    db,
    socketPath: actualSocketPath,
    cleanup: async () => {
      // Stop all delivery loops
      for (const [, loop] of subscriptions) {
        loop.stop();
      }
      subscriptions.clear();
      await client.close();
      await server.close();
      dbOpen = false;
      db.close();
      cleanupDir();
    },
  };
}

export async function waitForCondition(
  fn: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitForCondition timed out after ${timeoutMs}ms`);
}
