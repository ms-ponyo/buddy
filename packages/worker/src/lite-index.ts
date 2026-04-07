// src/lite-index.ts — Process entry point for the lite worker.
// Bootstraps the lite worker: parses env, creates context, connects to persistence/gateway/main worker,
// registers RPC handlers, starts the queue consumer, and manages graceful shutdown.

process.title = 'buddy-lite-worker';

import {
  RpcServer,
  RpcClient,
  liteWorkerSocketPath,
  workerSocketPath,
  PERSISTENCE_SOCKET,
  GATEWAY_SOCKET,
} from '@buddy/shared';
import { loadConfig } from './config.js';
import { createLiteWorkerContext } from './lite-context.js';
import type { LiteWorkerContext } from './lite-context.js';

// ── Validate required env ─────────────────────────────────────────

const threadKey = process.env.WORKER_THREAD_KEY!;
if (!threadKey) {
  console.error('WORKER_THREAD_KEY env var is required');
  process.exit(1);
}

const purpose = process.env.LITE_WORKER_PURPOSE ?? 'dispatch';

// ── Constants ─────────────────────────────────────────────────────

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const IDLE_CHECK_INTERVAL_MS = 60_000;  // 60 seconds
const MAIN_WORKER_CONNECT_RETRIES = 10;
const MAIN_WORKER_CONNECT_BASE_DELAY_MS = 500;
const MAIN_WORKER_CONNECT_MAX_DELAY_MS = 5000;

// ── Module-level state ────────────────────────────────────────────

const startTime = Date.now();
let lastActivityAt = Date.now();
let idleCheckInterval: NodeJS.Timeout | undefined;
let ctx: LiteWorkerContext | undefined;
let shuttingDown = false;

// ── RPC infrastructure ──────────────────────────────────────────

let persistenceInitialized = false;

const persistenceClient = new RpcClient({
  socketPath: PERSISTENCE_SOCKET,
  reconnect: true,
  onConnect: async () => {
    if (!persistenceInitialized) return;
    try {
      await persistenceClient.call('identify', { type: 'lite', threadKey });
      await persistenceClient.call('queue.subscribe', { queue: 'inbound-lite', threadKey });
    } catch (err) {
      console.error('Lite worker: failed to re-identify/re-subscribe with persistence:', err);
    }
  },
});

// Handle pushed inbound-lite messages from persistence
persistenceClient.registerMethod('deliver.message', (params) => {
  const { message } = params as { message: any };
  if (!ctx) return { accepted: false };
  lastActivityAt = Date.now();
  ctx.liteMessageHandler.handleInbound([message]).catch((err) => {
    console.error('Lite worker handleInbound error:', err);
  });
  return { accepted: true };
});

const gatewayClient = new RpcClient({
  socketPath: GATEWAY_SOCKET,
  reconnect: true,
});

// Main worker RPC client — connects to the main worker's socket
const mainWorkerClient = new RpcClient({
  socketPath: workerSocketPath(threadKey),
  reconnect: true,
});

// ── RPC Server ────────────────────────────────────────────────────

function createLiteRpcServer(): RpcServer {
  const server = new RpcServer({
    socketPath: liteWorkerSocketPath(threadKey, purpose),
  });

  // lite.interrupt — interrupt the dispatch session
  server.registerMethod('lite.interrupt', () => {
    if (ctx) {
      ctx.claudeSession.interrupt();
    }
    return {};
  });

  // lite.health.ping — liveness probe
  server.registerMethod('lite.health.ping', () => {
    return {
      status: 'ok',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      thread_key: threadKey,
      purpose,
      last_activity_sec: Math.floor((Date.now() - lastActivityAt) / 1000),
    };
  });

  // lite.interactiveResponse — deliver an interactive action to the lite worker
  server.registerMethod('lite.interactiveResponse', (params) => {
    const { callbackId } = params as { callbackId: string; action: unknown };
    if (!ctx) return {};

    // Dispatch session close button
    if (callbackId === 'dispatch_close') {
      ctx.dispatchHandler.stop().catch((err) =>
        console.error('Lite worker: failed to stop dispatch handler:', err),
      );
      return {};
    }

    return {};
  });

  return server;
}

// ── Idle check ────────────────────────────────────────────────────

function startIdleCheck(): void {
  idleCheckInterval = setInterval(() => {
    const age = Date.now() - lastActivityAt;
    if (age > IDLE_TIMEOUT_MS) {
      console.log(`Lite worker ${threadKey} idle for ${Math.floor(age / 1000)}s, shutting down`);
      shutdown().catch((err) => console.error('Shutdown error during idle check:', err));
    }
  }, IDLE_CHECK_INTERVAL_MS);
}

// ── Shutdown ──────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Lite worker ${threadKey} shutting down...`);

  if (idleCheckInterval) {
    clearInterval(idleCheckInterval);
    idleCheckInterval = undefined;
  }

  // Stop the dispatch handler
  if (ctx) {
    await ctx.dispatchHandler.stop().catch(() => {});
  }

  // Deregister from persistence
  try {
    await persistenceClient.call('registry.deregister', { type: 'lite', threadKey });
  } catch { /* ignore */ }

  // Close connections
  await mainWorkerClient.close().catch(() => {});
  await gatewayClient.close().catch(() => {});
  await persistenceClient.close().catch(() => {});

  setTimeout(() => process.exit(0), 500);
}

// ── Connect to main worker with retry ─────────────────────────────

async function connectToMainWorker(): Promise<void> {
  let delay = MAIN_WORKER_CONNECT_BASE_DELAY_MS;

  for (let attempt = 0; attempt <= MAIN_WORKER_CONNECT_RETRIES; attempt++) {
    try {
      await mainWorkerClient.connect();
      console.log('Lite worker: connected to main worker');
      return;
    } catch (err) {
      if (attempt === MAIN_WORKER_CONNECT_RETRIES) {
        console.error('Lite worker: failed to connect to main worker after max retries', {
          attempts: attempt + 1,
          error: String(err),
        });
        throw err;
      }
      console.log(`Lite worker: main worker connect attempt ${attempt + 1} failed, retrying in ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, MAIN_WORKER_CONNECT_MAX_DELAY_MS);
    }
  }
}

// ── Start ─────────────────────────────────────────────────────────

async function start(): Promise<void> {
  // 1. Parse config from env
  const config = loadConfig();

  // 2. Create and start RPC server
  const liteServer = createLiteRpcServer();
  await liteServer.listen();

  // 3. Connect to persistence (with retry)
  const persistenceAdapter = await (async () => {
    // Use raw client connection first
    let pDelay = 500;
    for (let attempt = 0; attempt <= 10; attempt++) {
      try {
        await persistenceClient.connect();
        console.log('Lite worker: connected to persistence');
        break;
      } catch (err) {
        if (attempt === 10) throw err;
        await new Promise((r) => setTimeout(r, pDelay));
        pDelay = Math.min(pDelay * 2, 5000);
      }
    }
  })();

  // 4. Identify as lite worker
  await persistenceClient.call('identify', { type: 'lite', threadKey });

  // 5. Connect to gateway
  try {
    await gatewayClient.connect();
  } catch {
    // Gateway may not be running yet; auto-reconnect handles it
  }

  // 6. Connect to main worker RPC (with retry — main worker may still be starting)
  await connectToMainWorker();

  // 7. Create LiteWorkerContext via factory
  ctx = createLiteWorkerContext(
    config,
    gatewayClient,
    persistenceClient,
    mainWorkerClient,
    threadKey,
    () => {
      // onShutdown callback — haiku_done action triggers this
      shutdown().catch((err) => console.error('Shutdown error from haiku_done:', err));
    },
  );

  // 8. Register in process registry
  await persistenceClient.call('registry.register', {
    type: 'lite',
    threadKey,
    pid: process.pid,
    socketPath: liteWorkerSocketPath(threadKey, purpose),
    purpose,
  });

  // 9. Subscribe to inbound-lite messages
  await persistenceClient.call('queue.subscribe', { queue: 'inbound-lite', threadKey });
  persistenceInitialized = true;

  // 10. Start idle check
  startIdleCheck();

  console.log(`Lite worker ${threadKey} started (pid=${process.pid}, purpose=${purpose})`);
}

// ── Bootstrap ─────────────────────────────────────────────────────

start().catch((err) => {
  console.error(`Lite worker ${threadKey} failed to start:`, err);
  process.exit(1);
});

// ── Signal handlers ───────────────────────────────────────────────

process.on('SIGTERM', () => {
  shutdown().catch((err) => console.error('SIGTERM shutdown error:', err));
});

process.on('SIGINT', () => {
  shutdown().catch((err) => console.error('SIGINT shutdown error:', err));
});

// ── Global error handlers ──────────────────────────────────────────

process.on('uncaughtException', (err) => {
  console.error(`Lite worker uncaught exception: ${err.message}`);
  setTimeout(() => process.exit(1), 100);
});

process.on('unhandledRejection', (reason) => {
  console.error(`Lite worker unhandled rejection: ${String(reason)}`);
});
