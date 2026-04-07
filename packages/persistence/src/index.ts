// packages/persistence/src/index.ts
import { openDatabase } from './database.js';
import { QueueService } from './queue-service.js';
import { SessionService } from './session-service.js';
import { RegistryService } from './registry-service.js';
import { HealthService } from './health-service.js';
import { RpcServer } from '@buddy/shared';
import type { IdentifyParams, QueueName } from '@buddy/shared';
import { DeliveryLoop } from './delivery-loop.js';
import { CONFIG } from './config.js';
import { logger } from './logger.js';

process.title = 'buddy-persistence';

// ---- Open database ----
const db = openDatabase();
const queueService = new QueueService(db);
const sessionService = new SessionService(db);
const registryService = new RegistryService(db);
const healthService = new HealthService(db);

// Clean up stale registry entries from previous runs
const staleRemoved = registryService.cleanupStale();
if (staleRemoved > 0) {
  logger.info(`Cleaned up ${staleRemoved} stale process registry entries`);
}

// ---- Client identity tracking ----
// Maps clientId (from RPC server) → { type, threadKey }
const clientIdentities = new Map<string, { type: string; threadKey?: string }>();

// ---- Client subscription tracking ----
// Maps clientId → list of { queue, threadKey } the client subscribed to
const clientSubscriptions = new Map<string, Array<{ queue: QueueName; threadKey?: string }>>();

// ---- Subscription tracking ----
// Maps subscription key ("inbound:<threadKey>" or "outbound:*") → DeliveryLoop
const subscriptions = new Map<string, DeliveryLoop>();

function subscriptionKey(queue: QueueName, threadKey?: string): string {
  return threadKey ? `${queue}:${threadKey}` : `${queue}:*`;
}

/** Wake the delivery loop for a matching subscription.
 *  Tries both exact key and wildcard — this is needed because outbound
 *  subscriptions use "outbound:*" but nack/enqueue provide a specific
 *  threadKey, so we must fall through to the wildcard match. */
function wakeSubscription(queue: QueueName, threadKey: string): void {
  // Try exact match first (inbound with threadKey)
  const exactKey = subscriptionKey(queue, threadKey);
  subscriptions.get(exactKey)?.wake();
  // Also try wildcard (outbound uses "outbound:*" regardless of threadKey)
  const wildcardKey = subscriptionKey(queue);
  subscriptions.get(wildcardKey)?.wake();
}

// ---- RPC Server ----
const server = new RpcServer({
  socketPath: CONFIG.SOCKET_PATH,
  onConnect: (_socket, clientId) => {
    logger.info('Client connected', { clientId });
  },
  onDisconnect: (clientId) => {
    const identity = clientIdentities.get(clientId);
    logger.info('Client disconnected', { clientId, type: identity?.type });

    // Stop any delivery loops owned by this client (BEFORE resetForThread)
    for (const [key, loop] of subscriptions) {
      if (loop.clientId === clientId) {
        loop.stop();
        subscriptions.delete(key);
        logger.info('Subscription removed', { key });
      }
    }

    // Reset delivered messages for each queue the client was subscribed to
    const subs = clientSubscriptions.get(clientId);
    if (subs) {
      for (const sub of subs) {
        if (sub.threadKey) {
          queueService.resetForThread(sub.threadKey, sub.queue);
          logger.info('Reset queue entries for disconnected subscriber', { threadKey: sub.threadKey, queue: sub.queue });
        }
      }
    }

    // Deregister from registry if this was a worker or lite worker
    if (identity?.type === 'worker' && identity.threadKey) {
      registryService.deregister('worker', identity.threadKey);
    } else if (identity?.type === 'lite' && identity.threadKey) {
      registryService.deregister('lite', identity.threadKey);
    }

    clientIdentities.delete(clientId);
    clientSubscriptions.delete(clientId);
  },
});

// ---- Register methods ----

// Handshake — clientId is passed as second arg by RpcServer (defined in Task 3)
server.registerMethod('identify', (params, clientId) => {
  const { type, threadKey } = params as unknown as IdentifyParams;
  clientIdentities.set(clientId, { type, threadKey });
  logger.info('Client identified', { clientId, type, threadKey });
  return { ok: true };
});

// Queue operations
server.registerMethod('queue.enqueue', (params) => {
  const { queue, message, threadKey } = params as { queue: QueueName; message: Record<string, unknown>; threadKey: string };
  const result = queueService.enqueue(queue, threadKey, message);

  wakeSubscription(queue, threadKey);

  return result;
});

server.registerMethod('queue.ack', (params) => {
  const { queue, id } = params as { queue: QueueName; id: string };
  queueService.ack(queue, id);
  return {};
});

server.registerMethod('queue.nack', (params) => {
  const { queue, id } = params as { queue: QueueName; id: string };
  const threadKey = queueService.nack(queue, id);
  if (threadKey) {
    wakeSubscription(queue, threadKey);
  }
  return {};
});

server.registerMethod('queue.deadletter', (params) => {
  const { queue, id, reason } = params as { queue: QueueName; id: string; reason: string };
  queueService.deadletter(queue, id, reason);
  return {};
});

server.registerMethod('queue.subscribe', (params, clientId) => {
  const { queue, threadKey } = params as { queue: QueueName; threadKey?: string };
  const key = subscriptionKey(queue, threadKey);

  // Stop existing loop for this key if any
  subscriptions.get(key)?.stop();

  const loop = new DeliveryLoop({
    queue,
    threadKey,
    clientId,
    server,
    queueService,
    onError: (err) => {
      logger.error('Delivery loop error', { key, error: err.message });
    },
  });

  subscriptions.set(key, loop);
  loop.start();

  // Track this subscription so onDisconnect can reset delivered messages
  const existing = clientSubscriptions.get(clientId) ?? [];
  existing.push({ queue, threadKey });
  clientSubscriptions.set(clientId, existing);

  logger.info('Subscription created', { key, clientId });
  return { ok: true };
});

// Session operations
server.registerMethod('session.get', (params) => {
  const { threadKey } = params as { threadKey: string };
  return sessionService.get(threadKey);
});

server.registerMethod('session.upsert', (params) => {
  const { threadKey, data } = params as { threadKey: string; data: Record<string, unknown> };
  sessionService.upsert(threadKey, data);
  return {};
});

server.registerMethod('session.delete', (params) => {
  const { threadKey } = params as { threadKey: string };
  sessionService.delete(threadKey);
  return {};
});

server.registerMethod('session.list', () => {
  return sessionService.list();
});

// Registry operations
server.registerMethod('registry.register', (params) => {
  const { type, threadKey, pid, socketPath } = params as { type: 'gateway' | 'worker' | 'persistence'; threadKey?: string; pid: number; socketPath: string };
  registryService.register(type, threadKey, pid, socketPath);
  return {};
});

server.registerMethod('registry.deregister', (params) => {
  const { type, threadKey } = params as { type: 'gateway' | 'worker' | 'persistence'; threadKey?: string };
  registryService.deregister(type, threadKey);
  return {};
});

server.registerMethod('registry.list', (params) => {
  const { type } = (params || {}) as { type?: 'gateway' | 'worker' | 'persistence' };
  return { processes: registryService.list(type) };
});

server.registerMethod('queue.resetForThread', (params) => {
  const { threadKey, queue } = params as { threadKey: string; queue?: QueueName };
  queueService.resetForThread(threadKey, queue);
  return {};
});

// Health
server.registerMethod('health.ping', () => {
  return healthService.getHealth();
});

// ---- Prune timer ----
const pruneInterval = setInterval(() => {
  const pruned = queueService.prune();
  if (pruned > 0) {
    logger.info('Pruned old queue messages', { count: pruned });
  }
}, CONFIG.PRUNE_INTERVAL_MS);

// ---- Start server ----
async function start(): Promise<void> {
  await server.listen();
  logger.info('Persistence service listening', { socketPath: CONFIG.SOCKET_PATH, pid: process.pid });
}

// ---- Graceful shutdown ----
function shutdown(): void {
  logger.info('Persistence service shutting down');
  clearInterval(pruneInterval);
  server.close().then(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start().catch((err) => {
  logger.error('Failed to start persistence service', { error: String(err) });
  process.exit(1);
});
