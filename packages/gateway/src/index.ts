process.title = 'buddy-gateway';
import { App } from '@slack/bolt';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { SessionRegistry } from './session-registry.js';
import { WorkerManager } from './worker-manager.js';
import { IpcGateway, postInteractivePromptToSlack } from './ipc-gateway.js';
import { SlackRouter } from './slack-router.js';
import { RestartHandler } from './restart-handler.js';
import { HealthMonitor } from './health.js';
import { RpcClient, PERSISTENCE_SOCKET, GATEWAY_SOCKET, MARKDOWN_BLOCK_MAX_LENGTH, isStreamMessage, liteWorkerSocketPath } from '@buddy/shared';
import type { ProcessEntry, QueueMessage, PersistenceHealth, WorkerConfig } from '@buddy/shared';
import { StreamRouter } from './stream-router.js';
import { existsSync } from 'fs';
import { SlackRateLimiter } from './rate-limiter.js';

async function waitForSocket(socketPath: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(socketPath)) {
      try {
        const testClient = new RpcClient({ socketPath, reconnect: false });
        await testClient.connect();
        await testClient.close();
        return;
      } catch {
        // Socket file exists but not yet accepting — wait
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for socket at ${socketPath}`);
}

async function main() {
  const config = loadConfig();
  const logger = createLogger('gateway');

  logger.info('Gateway starting');

  // Initialize Slack app
  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
  });

  // Initialize components
  const registry = new SessionRegistry(logger);

  // ── Crash-loop protection ──────────────────────────────────────
  // Track recent crash timestamps per threadKey to detect crash loops.
  const MAX_CRASHES = 5;
  const CRASH_WINDOW_MS = 60_000;
  const crashHistory = new Map<string, number[]>();

  /** Returns true if the thread has exceeded the crash-loop threshold. */
  function isCrashLooping(threadKey: string): boolean {
    const now = Date.now();
    const timestamps = crashHistory.get(threadKey) ?? [];
    // Keep only crashes within the window
    const recent = timestamps.filter(t => now - t < CRASH_WINDOW_MS);
    recent.push(now);
    crashHistory.set(threadKey, recent);
    return recent.length > MAX_CRASHES;
  }

  /** Clear crash history for a thread (e.g. after a successful run or manual restart). */
  function clearCrashHistory(threadKey: string): void {
    crashHistory.delete(threadKey);
  }

  const workerManager = new WorkerManager(
    config,
    registry,
    logger,
    async (threadKey, expected) => {
      if (!expected) {
        // Crash-loop protection: stop respawning if crashing too fast
        if (isCrashLooping(threadKey)) {
          const [channel, threadTs] = threadKey.split(':');
          logger.error('Worker crash loop detected, stopping respawn', { threadKey, maxCrashes: MAX_CRASHES, windowMs: CRASH_WINDOW_MS });
          app.client.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text: `Worker crash loop detected (${MAX_CRASHES}+ crashes in ${CRASH_WINDOW_MS / 1000}s) — stopping auto-respawn. Use \`!restart\` to retry.`,
          }).catch(() => {});
          return;
        }

        const [channel, threadTs] = threadKey.split(':');
        app.client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: 'Worker crashed — checking for pending messages...',
        }).catch(() => {});

        // Check persistence for pending messages and auto-respawn
        if (persistenceReady) {
          try {
            const health = await persistenceClient.call('health.ping') as PersistenceHealth;
            const threadMetrics = health.queues.inbound.by_thread[threadKey];
            if (threadMetrics && (threadMetrics.pending > 0 || threadMetrics.delivered > 0)) {
              // Reset any delivered messages back to pending (persistence onDisconnect
              // may not have fired yet if the worker process died abruptly)
              if (threadMetrics.delivered > 0) {
                await persistenceClient.call('queue.resetForThread', { threadKey, queue: 'inbound' });
              }
              logger.info(`Auto-respawning worker for ${threadKey} (${threadMetrics.pending} pending, ${threadMetrics.delivered} delivered)`);
              const workerConfig: WorkerConfig = {
                model: config.defaultModel,
                permissionMode: config.defaultPermissionMode,
                mcpServers: config.mcpServers,
                anthropicApiKey: config.anthropicApiKey,
              };
              workerManager.spawn(threadKey, workerConfig);
            }
          } catch (err) {
            logger.error('Failed to check/respawn after worker crash', { threadKey, error: (err as Error).message });
          }
        }
      }
    },
  );

  // Register lite worker exit handler
  workerManager.setLiteWorkerExitHandler(async (threadKey, expected) => {
    if (!expected) {
      // Crash-loop protection (shared history with main worker)
      if (isCrashLooping(`lite:${threadKey}`)) {
        logger.error('Lite worker crash loop detected, stopping respawn', { threadKey, maxCrashes: MAX_CRASHES, windowMs: CRASH_WINDOW_MS });
        return;
      }

      logger.error('Lite worker crashed unexpectedly', { threadKey });

      // Check persistence for pending inbound-lite messages and auto-respawn
      if (persistenceReady) {
        try {
          const health = await persistenceClient.call('health.ping') as PersistenceHealth;
          const liteMetrics = health.queues['inbound-lite'].by_thread[threadKey];
          if (liteMetrics && (liteMetrics.pending > 0 || liteMetrics.delivered > 0)) {
            if (liteMetrics.delivered > 0) {
              await persistenceClient.call('queue.resetForThread', { threadKey, queue: 'inbound-lite' });
            }
            logger.info(`Auto-respawning lite worker for ${threadKey} (${liteMetrics.pending} pending, ${liteMetrics.delivered} delivered inbound-lite)`);
            const workerConfig: WorkerConfig = {
              model: config.defaultModel,
              permissionMode: config.defaultPermissionMode,
              mcpServers: config.mcpServers,
              anthropicApiKey: config.anthropicApiKey,
            };
            // Also spawn main worker if not running (lite worker needs it)
            if (!registry.has(threadKey)) {
              workerManager.spawn(threadKey, workerConfig);
            }
            workerManager.spawnLite(threadKey, 'dispatch', workerConfig);
          }
        } catch (err) {
          logger.error('Failed to check/respawn after lite worker crash', { threadKey, error: (err as Error).message });
        }
      }
    }
  });

  // Rate limiter for outbound Slack API calls (40 tokens/min ≈ Tier 3 safe margin).
  // Shared between outbound queue processing and stream flushes.
  const rateLimiter = new SlackRateLimiter(40, 60_000);

  // Gateway RPC server for worker connections (Slack API proxying, streaming)
  const ipcGateway = new IpcGateway(app, registry, logger, workerManager, config.slackUserToken);

  const streamRouter = new StreamRouter({
    createStream: async (channel, threadTs, userId, streamType) => {
      const teamId = await ipcGateway.resolveTeamId();
      const effectiveUserId = userId || await ipcGateway.resolveBotUserId();
      const args: Record<string, unknown> = {
        channel,
        thread_ts: threadTs,
        task_display_mode: streamType === 'todo' ? 'plan' : 'timeline',
      };
      if (teamId) args.recipient_team_id = teamId;
      if (effectiveUserId) args.recipient_user_id = effectiveUserId;

      const streamer = (app.client as any).chatStream(args);
      // Must send a plan_update to force Slack to start the stream and return ts.
      await rateLimiter.acquire();
      const result = await streamer.append({ chunks: [{ type: 'plan_update', title: 'Working' }] });
      return { streamer, ts: result?.ts ?? '' };
    },
    rateLimitAcquire: () => rateLimiter.acquire(),
    deleteMessage: async (channel, ts) => {
      await rateLimitedSlackCall(() => app.client.chat.delete({ channel, ts }));
    },
    logger,
  });

  const restartHandler = new RestartHandler(app, workerManager, logger, (threadKey) => {
    clearCrashHistory(threadKey);
    clearCrashHistory(`lite:${threadKey}`);
  });

  // Connect to persistence service
  let persistenceReady = false; // Gate to prevent onDisconnect from firing before initial connect
  const persistenceClient = new RpcClient({
    socketPath: PERSISTENCE_SOCKET,
    reconnect: true,
    onConnect: async () => {
      if (!persistenceReady) return; // Initial connect handled explicitly below
      // Re-identify and re-subscribe after reconnect
      logger.info('Reconnected to persistence, re-identifying');
      try {
        await persistenceClient.call('identify', { type: 'gateway' });
        await persistenceClient.call('registry.register', {
          type: 'gateway',
          pid: process.pid,
          socketPath: GATEWAY_SOCKET,
        });
        await persistenceClient.call('queue.subscribe', { queue: 'outbound' });
      } catch (err) {
        logger.error('Failed to re-identify/re-subscribe with persistence', { error: (err as Error).message });
      }
    },
    onDisconnect: () => {
      if (!persistenceReady) return; // Don't spawn on initial connect failure
      logger.warn('Lost connection to persistence service');
      setTimeout(async () => {
        await workerManager.spawnPersistence().catch((err) => {
          logger.error('Failed to spawn persistence', { error: (err as Error).message });
        });
      }, 1000);
    },
  });

  // Track the last posted message per thread so appendToLastMessage can update it
  const lastPostedMessage = new Map<string, { ts: string; channel: string; text: string; blocks?: unknown[] }>();

  /** Call a Slack API method through the rate limiter, handling 429 Retry-After. */
  async function rateLimitedSlackCall<T>(fn: () => Promise<T>): Promise<T> {
    await rateLimiter.acquire();
    try {
      return await fn();
    } catch (err: any) {
      // Detect Slack 429 rate limit and pause the limiter
      const retryAfter = err?.data?.retryAfter ?? err?.retryAfter;
      if (retryAfter && typeof retryAfter === 'number') {
        logger.warn(`Slack rate limited, pausing for ${retryAfter}s`);
        rateLimiter.onRateLimited(retryAfter);
      }
      throw err;
    }
  }

  async function processOutboundMessage(msg: QueueMessage): Promise<void> {
    const payload = msg.payload as Record<string, any>;

    if (isStreamMessage(payload)) {
      await streamRouter.handle(payload);
      return;
    }

    const type = payload.type as string;

    switch (type) {
      case 'postMessage': {
        const fullText = payload.text as string;
        // When blocks are present, truncate text to a short fallback for
        // notifications/screen-readers (full text doubles payload → msg_too_long).
        const args: Record<string, unknown> = {
          channel: payload.channel,
          thread_ts: payload.thread_ts,
          text: payload.blocks ? fullText.slice(0, 500) : fullText,
        };
        if (payload.blocks) args.blocks = payload.blocks;
        try {
          const result = await rateLimitedSlackCall(() => app.client.chat.postMessage(args as any));
          if (result.ts) {
            lastPostedMessage.set(msg.threadKey, {
              ts: result.ts,
              channel: payload.channel as string,
              text: '',
              blocks: payload.blocks as unknown[] | undefined,
            });
          }
        } catch (postErr: any) {
          if (postErr?.data?.error === 'msg_too_long' || postErr.message?.includes('msg_too_long')) {
            // Blocks themselves too large — retry text-only
            logger.warn('postMessage msg_too_long, retrying text-only', { length: fullText.length });
            const fallbackText = fullText.length > 39_000 ? fullText.slice(0, 39_000) + '\n\n_(truncated)_' : fullText;
            const fallbackResult = await rateLimitedSlackCall(() =>
              app.client.chat.postMessage({
                channel: payload.channel as string,
                thread_ts: payload.thread_ts as string,
                text: fallbackText,
              }),
            );
            if (fallbackResult.ts) {
              lastPostedMessage.set(msg.threadKey, {
                ts: fallbackResult.ts,
                channel: payload.channel as string,
                text: fallbackText,
              });
            }
          } else if (postErr?.data?.error === 'invalid_blocks' || postErr.message?.includes('invalid_blocks')) {
            // Markdown blocks rejected (HTML tags, nested fences, etc.) — upload as .md file
            logger.warn('postMessage invalid_blocks, uploading as .md file', { length: fullText.length });
            const preview = fullText.slice(0, 256).trimEnd() + '...\n\n_(full response attached as file — Slack rejected the message blocks)_';
            await rateLimitedSlackCall(() =>
              app.client.filesUploadV2({
                channel_id: payload.channel as string,
                thread_ts: payload.thread_ts as string,
                filename: `response-${Date.now()}.md`,
                content: fullText,
                initial_comment: preview,
              } as any),
            );
          } else {
            throw postErr;
          }
        }
        break;
      }
      case 'appendToLastMessage': {
        const last = lastPostedMessage.get(msg.threadKey);
        if (last) {
          const updatedBlocks = [
            ...(last.blocks ?? []),
            ...(payload.blocks ? payload.blocks as unknown[] : []),
          ];
          // Check if the combined blocks would exceed Slack's limits.
          const blocksPayloadLen = JSON.stringify(updatedBlocks).length;
          if (blocksPayloadLen > MARKDOWN_BLOCK_MAX_LENGTH) {
            // Too large to update — post as a new message instead
            const args: Record<string, unknown> = {
              channel: last.channel, thread_ts: payload.thread_ts,
              text: payload.blocks ? (payload.text as string).slice(0, 500) : payload.text,
            };
            if (payload.blocks) args.blocks = payload.blocks;
            await rateLimitedSlackCall(() => app.client.chat.postMessage(args as any));
          } else {
            const updateArgs: Record<string, unknown> = {
              channel: last.channel,
              ts: last.ts,
              text: (payload.text as string || '').slice(0, 500),
            };
            if (updatedBlocks.length > 0) updateArgs.blocks = updatedBlocks;
            await rateLimitedSlackCall(() => app.client.chat.update(updateArgs as any));
            last.blocks = updatedBlocks.length > 0 ? updatedBlocks : undefined;
          }
        } else {
          const args: Record<string, unknown> = {
            channel: payload.channel, thread_ts: payload.thread_ts,
            text: payload.blocks ? (payload.text as string).slice(0, 500) : payload.text,
          };
          if (payload.blocks) args.blocks = payload.blocks;
          await rateLimitedSlackCall(() => app.client.chat.postMessage(args as any));
        }
        break;
      }
      case 'fileUpload': {
        const args: Record<string, unknown> = {
          channel_id: payload.channel_id,
          thread_ts: payload.thread_ts,
          filename: payload.filename,
        };
        if (payload.file_path) {
          const { readFileSync } = await import('node:fs');
          args.file = readFileSync(payload.file_path as string);
        } else if (payload.content) {
          args.content = payload.content;
        }
        if (payload.initial_comment) args.initial_comment = payload.initial_comment;
        await rateLimitedSlackCall(() => app.client.filesUploadV2(args as any));
        break;
      }
      case 'interactivePrompt': {
        await rateLimitedSlackCall(() => postInteractivePromptToSlack(
          app,
          msg.threadKey,
          payload.promptType,
          payload.display,
          payload.callbackId,
          logger,
        ));
        const entry = registry.get(msg.threadKey);
        if (entry) {
          registry.registerCallback(payload.callbackId, msg.threadKey);
        }
        break;
      }
      case 'updateMessage': {
        await rateLimitedSlackCall(() =>
          app.client.chat.update({
            channel: payload.channel as string,
            ts: payload.ts as string,
            text: payload.text as string,
            ...(payload.blocks ? { blocks: payload.blocks as any } : {}),
          }),
        );
        break;
      }
      case 'deleteMessage': {
        await rateLimitedSlackCall(() =>
          app.client.chat.delete({
            channel: payload.channel as string,
            ts: payload.ts as string,
          }),
        );
        break;
      }
      default:
        logger.warn('Unknown outbound message type', { id: msg.id, type });
    }
  }

  // Track in-flight outbound messages for observability (waiting on rate limiter or Slack API)
  let outboundInFlight = 0;

  // Per-thread processing chain: ensures outbound messages for the same thread
  // are processed sequentially (e.g. postMessage completes before appendToLastMessage
  // so that lastPostedMessage is populated).
  const threadOutboundChain = new Map<string, Promise<void>>();

  // Handle pushed outbound messages from persistence.
  // Returns { accepted: true } immediately so the delivery loop isn't blocked
  // by rate limiter waits or slow Slack API calls (which could exceed the
  // 30s callClient timeout). Processing and ack/nack happen asynchronously,
  // but serialized per thread to preserve ordering dependencies.
  persistenceClient.registerMethod('deliver.message', (params) => {
    const { message } = params as { message: QueueMessage };
    outboundInFlight++;
    const previous = threadOutboundChain.get(message.threadKey) ?? Promise.resolve();
    const current = previous.then(async () => {
      try {
        await processOutboundMessage(message);
        await persistenceClient.call('queue.ack', { queue: 'outbound', id: message.id });
      } catch (err) {
        logger.error('Failed to process outbound message', { id: message.id, error: (err as Error).message });
        await persistenceClient.call('queue.nack', { queue: 'outbound', id: message.id });
      } finally {
        outboundInFlight--;
        if (threadOutboundChain.get(message.threadKey) === current) {
          threadOutboundChain.delete(message.threadKey);
        }
      }
    });
    threadOutboundChain.set(message.threadKey, current);
    return { accepted: true };
  });

  const router = new SlackRouter(
    app,
    config,
    registry,
    workerManager,
    persistenceClient,
    logger,
    (threadKey, channel, threadTs) => restartHandler.restartThread(threadKey, channel, threadTs),
    (channel, threadTs) => restartHandler.restartAll(channel, threadTs),
    (threadKey, channel, threadTs) => restartHandler.restart(threadKey, channel, threadTs),
    (channel, threadTs) => restartHandler.restartPersistenceOnly(channel, threadTs),
    (channel, threadTs) => restartHandler.restartWorkers(channel, threadTs),
    (channel, threadTs) => restartHandler.restartPersistence(channel, threadTs),
  );

  // Register Slack event handlers
  router.register();

  // Socket lifecycle logging
  const socketReceiver = (app as any).receiver;
  if (socketReceiver?.client) {
    for (const event of ['connecting', 'connected', 'authenticated', 'reconnecting', 'disconnecting', 'disconnected', 'error']) {
      socketReceiver.client.on(event, (...args: any[]) => {
        logger.info(`Socket: ${event}`, { args: args.length > 0 ? args[0] : undefined });
      });
    }
  }

  // Start health monitoring
  const healthMonitor = new HealthMonitor(app, persistenceClient, registry, workerManager, logger, config);
  healthMonitor.start();

  try {
    await persistenceClient.connect();
    logger.info('Connected to existing persistence service');
  } catch {
    logger.info('Persistence service not found, spawning...');
    await workerManager.spawnPersistence();
    await waitForSocket(PERSISTENCE_SOCKET, 10000);
    await persistenceClient.connect();
    logger.info('Connected to newly spawned persistence service');
  }

  await persistenceClient.call('identify', { type: 'gateway' });
  await persistenceClient.call('registry.register', {
    type: 'gateway',
    pid: process.pid,
    socketPath: GATEWAY_SOCKET,
  });
  persistenceReady = true; // Now safe to handle disconnect/reconnect events

  // Subscribe to outbound messages — persistence will push them to us
  await persistenceClient.call('queue.subscribe', { queue: 'outbound' });

  // Start gateway RPC server (after persistence connection is established)
  await ipcGateway.listen();

  // Reconnect to existing workers from registry
  const { processes } = await persistenceClient.call('registry.list', { type: 'worker' }) as { processes: ProcessEntry[] };
  for (const entry of processes) {
    try {
      const workerClient = new RpcClient({ socketPath: entry.socketPath, reconnect: false });
      await workerClient.connect();
      registry.register(entry.threadKey, entry.pid, entry.socketPath);
      registry.setRpcClient(entry.threadKey, workerClient);
      logger.info(`Reconnected to worker ${entry.threadKey} (PID ${entry.pid})`);
    } catch {
      logger.warn(`Worker ${entry.threadKey} (PID ${entry.pid}) not reachable, cleaning up`);
      await persistenceClient.call('registry.deregister', { type: 'worker', threadKey: entry.threadKey });
    }
  }

  // Reconnect to existing lite workers from registry
  const { processes: liteProcesses } = await persistenceClient.call('registry.list', { type: 'lite' }) as { processes: ProcessEntry[] };
  for (const entry of liteProcesses) {
    try {
      const liteClient = new RpcClient({ socketPath: entry.socketPath, reconnect: false });
      await liteClient.connect();
      registry.register(entry.threadKey, entry.pid, entry.socketPath, 'lite');
      registry.setRpcClient(entry.threadKey, liteClient, 'lite');
      logger.info(`Reconnected to lite worker ${entry.threadKey} (PID ${entry.pid})`);
    } catch {
      logger.warn(`Lite worker ${entry.threadKey} (PID ${entry.pid}) not reachable, cleaning up`);
      await persistenceClient.call('registry.deregister', { type: 'lite', threadKey: entry.threadKey });
    }
  }

  // Check for threads with pending inbound messages but no active worker
  try {
    const startupHealth = await persistenceClient.call('health.ping') as PersistenceHealth;

    // Check orphaned inbound messages (main workers)
    for (const [orphanThreadKey, metrics] of Object.entries(startupHealth.queues.inbound.by_thread)) {
      const hasUnfinished = metrics.pending > 0 || metrics.delivered > 0;
      if (hasUnfinished && !registry.get(orphanThreadKey)) {
        // Reset delivered → pending so the new worker can pick them up
        if (metrics.delivered > 0) {
          await persistenceClient.call('queue.resetForThread', { threadKey: orphanThreadKey, queue: 'inbound' });
          logger.info(`Reset ${metrics.delivered} delivered inbound messages for orphaned thread ${orphanThreadKey}`);
        }
        logger.info(`Spawning worker for orphaned thread ${orphanThreadKey} (${metrics.pending} pending, ${metrics.delivered} delivered)`);
        const workerConfig: WorkerConfig = {
          model: config.defaultModel,
          permissionMode: config.defaultPermissionMode,
          mcpServers: config.mcpServers,
          anthropicApiKey: config.anthropicApiKey,
        };
        workerManager.spawn(orphanThreadKey, workerConfig);
      }
    }

    // Check orphaned inbound-lite messages (lite workers)
    for (const [orphanThreadKey, metrics] of Object.entries(startupHealth.queues['inbound-lite'].by_thread)) {
      const hasUnfinished = metrics.pending > 0 || metrics.delivered > 0;
      if (hasUnfinished && !registry.get(orphanThreadKey, 'lite')) {
        // Reset delivered → pending so the new lite worker can pick them up
        if (metrics.delivered > 0) {
          await persistenceClient.call('queue.resetForThread', { threadKey: orphanThreadKey, queue: 'inbound-lite' });
          logger.info(`Reset ${metrics.delivered} delivered inbound-lite messages for orphaned thread ${orphanThreadKey}`);
        }
        logger.info(`Spawning lite worker for orphaned inbound-lite thread ${orphanThreadKey} (${metrics.pending} pending, ${metrics.delivered} delivered)`);
        const workerConfig: WorkerConfig = {
          model: config.defaultModel,
          permissionMode: config.defaultPermissionMode,
          mcpServers: config.mcpServers,
          anthropicApiKey: config.anthropicApiKey,
        };
        // Ensure main worker is also running (lite worker needs it as RPC target)
        if (!registry.get(orphanThreadKey)) {
          workerManager.spawn(orphanThreadKey, workerConfig);
        }
        workerManager.spawnLite(orphanThreadKey, 'dispatch', workerConfig);
      }
    }
  } catch (err) {
    logger.error('Failed startup orphan check', { error: (err as Error).message });
  }

  // Start the Slack app
  await app.start();
  logger.info('Gateway connected to Slack');

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Gateway shutting down');
    healthMonitor.stop();
    streamRouter.close();
    workerManager.killAll(); // kills both main workers and lite workers
    await ipcGateway.close();
    await persistenceClient.close();
    try {
      await app.stop();
    } catch {}
    setTimeout(() => process.exit(0), 1000);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { error: err.message, stack: err.stack });
    shutdown();
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { reason: String(reason) });
  });
}

main().catch((err) => {
  console.error('Gateway failed to start:', err);
  process.exit(1);
});
