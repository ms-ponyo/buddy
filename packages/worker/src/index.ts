// src/index.ts — Process entry point for the buddy worker.
// Bootstraps the full worker: parses env, creates context, connects persistence/gateway,
// registers RPC handlers, starts the main loop, and manages graceful shutdown.

process.title = 'buddy-worker';

import { RpcServer, RpcClient, workerSocketPath, PERSISTENCE_SOCKET, GATEWAY_SOCKET } from '@buddy/shared';
import { loadConfig } from './config.js';
import { createWorkerContext } from './context.js';
import type { WorkerContext } from './context.js';
import { registerWorkerControlHandlers } from './rpc-handlers.js';
import { BotCommandRouter } from './services/bot-command-router.js';
import { allCommands } from './commands/index.js';

// ── Validate required env ─────────────────────────────────────────

const threadKey = process.env.WORKER_THREAD_KEY!;
if (!threadKey) {
  console.error('WORKER_THREAD_KEY env var is required');
  process.exit(1);
}

// ── Constants ─────────────────────────────────────────────────────

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const IDLE_CHECK_INTERVAL_MS = 60_000;  // 60 seconds

// ── Module-level state ────────────────────────────────────────────

const startTime = Date.now();
let idleCheckInterval: NodeJS.Timeout | undefined;
let ctx: WorkerContext | undefined;

// ── RPC infrastructure (created before context) ───────────────────

let persistenceInitialized = false; // Gate to skip onConnect during initial startup

const persistenceClient = new RpcClient({
  socketPath: PERSISTENCE_SOCKET,
  reconnect: true,
  onConnect: async () => {
    if (!persistenceInitialized) return; // Initial connect handled explicitly in start()
    // Re-identify and re-subscribe on reconnect
    try {
      await persistenceClient.call('identify', { type: 'worker', threadKey });
      await persistenceClient.call('queue.subscribe', { queue: 'inbound', threadKey });
    } catch (err) {
      console.error('Failed to re-identify/re-subscribe with persistence:', err);
    }
  },
});

// Handle pushed inbound messages from persistence
persistenceClient.registerMethod('deliver.message', (params) => {
  const { message } = params as { message: any };
  if (!ctx) return { accepted: false };
  // Route to message handler (fire-and-forget — ack happens after processing)
  ctx.messageHandler.handleInbound([message]).catch((err) => {
    console.error('handleInbound error:', err);
  });
  return { accepted: true };
});

const gatewayClient = new RpcClient({
  socketPath: GATEWAY_SOCKET,
  reconnect: true,
});

// ── RPC Server ────────────────────────────────────────────────────

function createWorkerRpcServer(): RpcServer {
  const server = new RpcServer({
    socketPath: workerSocketPath(threadKey),
  });

  // worker.interrupt — signal the worker to stop the current session
  server.registerMethod('worker.interrupt', () => {
    if (ctx) {
      ctx.workerLoop.interrupt();
    }
    return {};
  });

  // worker.interactiveResponse — deliver a user response to a pending interaction
  server.registerMethod('worker.interactiveResponse', (params) => {
    const { callbackId, action } = params as { callbackId: string; action: unknown };
    if (!ctx) return {};

    // Try permission manager first (allow/deny/always button clicks)
    const actionStr = typeof action === 'string' ? action : '';
    if (actionStr === 'allow' || actionStr === 'always' || actionStr === 'deny') {
      const approved = actionStr !== 'deny';
      // Capture tool names and lock texts before resolveInteraction clears the pending state
      const permToolNames = ctx.permissions.getToolNames(callbackId);
      const permLockTexts = ctx.permissions.getLockTexts(callbackId);
      // On "always", determine the right updatedPermissions:
      // - For file tools (Edit/Write/NotebookEdit), switch to acceptEdits mode
      //   instead of adding individual allow rules
      // - For other tools, use the stored SDK suggestions as before
      let updatedPermissions: unknown[] | undefined;
      if (actionStr === 'always') {
        const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
        const allFileTools = permToolNames.length > 0 && permToolNames.every(t => FILE_TOOLS.has(t));
        if (allFileTools) {
          updatedPermissions = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }];
          // Actually switch the mode so subsequent file-tool hooks auto-allow
          ctx.configOverrides.setPermissionMode('acceptEdits');
          ctx.claudeSession.setPermissionMode('acceptEdits');
        } else {
          updatedPermissions = ctx.permissions.getSuggestions(callbackId);
        }
      }
      const resolved = ctx.permissions.resolveInteraction(callbackId, {
        approved,
        updatedPermissions,
      });
      if (resolved) {
        // Record the permission result in the live stream and emit updated chunks
        const alwaysPattern = updatedPermissions ? formatPermPattern(updatedPermissions) : undefined;
        ctx.progress.onPermissionResult(callbackId, approved, {
          toolNames: permToolNames,
          lockTexts: permLockTexts,
          alwaysAllow: actionStr === 'always',
          alwaysPattern,
        });
        const chunks = ctx.progress.buildMainChunks();
        if (chunks.length > 0) {
          ctx.slack.enqueueOutbound({
            type: 'stream_chunk',
            channel: ctx.channel,
            threadTs: ctx.threadTs,
            userId: ctx.workerLoop.currentUserId,
            streamType: 'main',
            chunks,
          } as any).catch(() => {});
        }
        return {};
      }
    }

    // Try plan review (approve/reject button clicks)
    if (actionStr === 'approve' || actionStr === 'reject') {
      const resolved = ctx.permissions.resolveInteraction(callbackId, {
        approved: actionStr === 'approve',
      });
      if (resolved) return {};
    }

    // Try question answer (button value has "callbackId:qi:value" format,
    // or plain text from text input)
    if (actionStr) {
      const resolved = ctx.permissions.resolveInteraction(callbackId, {
        answer: actionStr,
      });
      if (resolved) return {};
    }

    return {};
  });

  // worker.health.ping — liveness probe
  server.registerMethod('worker.health.ping', () => {
    const exec = ctx?.workerLoop.currentExecution ?? null;
    const response: Record<string, unknown> = {
      status: 'ok',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      thread_key: threadKey,
      last_activity_sec: ctx ? Math.floor(ctx.workerLoop.lastActivityAge / 1000) : -1,
      awaiting_user_input: ctx?.workerLoop.awaitingUserInput ?? false,
      active_tool: ctx?.workerLoop.activeToolName ?? null,
    };
    if (exec) {
      response.execution = {
        model: exec.model,
        cost_usd: exec.costUsd,
        tool_count: exec.toolCount,
        files_changed: exec.filesChanged.size,
        duration_sec: Math.floor((Date.now() - exec.createdAt) / 1000),
        session_id: exec.sessionId,
      };
    }
    return response;
  });

  // worker.getStatus / switchModel / switchMode / sendToBackground / forkThread /
  // getInitInfo / getAccountInfo / switchEffort / switchBudget
  registerWorkerControlHandlers(
    () => ctx,
    (method, handler) => server.registerMethod(method, handler as any),
  );

  // worker.getSupportedCommands — return supported commands from the active SDK session
  server.registerMethod('worker.getSupportedCommands', async () => {
    if (!ctx) return { commands: null };
    const commands = await ctx.claudeSession.getSupportedCommands();
    return { commands };
  });

  // worker.executeBotCommand — execute a bot command or forward SDK slash commands
  let botCommandRouter: BotCommandRouter | undefined;
  server.registerMethod('worker.executeBotCommand', async (params) => {
    if (!ctx) return { type: 'dispatch', reply: 'Worker not ready.' };
    const { command, args } = params as { command: string; args: string };

    // Lazily create router (needs ctx to be initialized)
    if (!botCommandRouter) {
      botCommandRouter = new BotCommandRouter(
        {
          logger: ctx.logger,
          configOverrides: ctx.configOverrides,
          config: ctx.config,
          getCurrentExecution: () => ctx!.workerLoop.currentExecution,
          getInitInfo: () => ctx!.claudeSession.getInitInfo(),
          getAccountInfo: () => ctx!.claudeSession.getAccountInfo(),
          onInterrupt: () => ctx!.workerLoop.interrupt(),
          onPermissionModeChange: (mode) => { ctx!.claudeSession.setPermissionMode(mode); },
          getSupportedCommands: () => ctx!.claudeSession.getSupportedCommands(),
        },
        allCommands,
      );
    }

    // !insights — forward to SDK, then post a detailed summary to Slack
    if (command === 'insights') {
      await ctx.persistence.enqueue('inbound', threadKey, { prompt: `/insights${args ? ' ' + args : ''}` });
      await ctx.persistence.enqueue('inbound', threadKey, {
        prompt: 'You just generated a Claude Code insights report. The full insights data is in your conversation context above. '
          + 'Now post a detailed, well-formatted summary to this Slack thread covering ALL sections:\n'
          + '1. At a Glance (what\'s working, what\'s hindering, quick wins)\n'
          + '2. Project Areas (list each area with session count)\n'
          + '3. Interaction Style (key pattern and narrative highlights)\n'
          + '4. Impressive Things (top workflows)\n'
          + '5. Friction Analysis (each category with examples)\n'
          + '6. Suggestions (CLAUDE.md additions, features to try with code examples, usage pattern improvements)\n'
          + '7. On the Horizon (future opportunities with copyable prompts)\n'
          + '8. Fun Ending\n\n'
          + 'Use Slack formatting: *bold* for headers, bullet points, code blocks for prompts/code. '
          + 'Be comprehensive — include specific examples, numbers, and actionable details from each section. '
          + 'This should be a complete standalone report the user can share.',
      });
      return { type: 'handled', reply: 'Generating insights report... This analyzes your session history and makes multiple API calls, so it may take a few minutes.' };
    }

    // SDK slash command → forward to main worker inbound as /command
    if (botCommandRouter.isSDKSlashCommand(command)) {
      const slashCommand = `/${command}${args ? ' ' + args : ''}`;
      await ctx.persistence.enqueue('inbound', threadKey, { prompt: slashCommand });
      return { type: 'handled', reply: `Forwarded \`${slashCommand}\` to the SDK session.` };
    }

    // Registered bot command → execute locally
    if (botCommandRouter.hasCommand(command)) {
      return botCommandRouter.execute({ command, args });
    }

    // Unknown command
    return { type: 'dispatch', reply: `Unknown command "${command}". Try !help to see available commands.` };
  });

  return server;
}

// ── Idle check ────────────────────────────────────────────────────

function startIdleCheck(): void {
  idleCheckInterval = setInterval(() => {
    if (!ctx) return;

    // Don't shut down if waiting for user (e.g. permission prompts)
    if (ctx.workerLoop.awaitingUserInput) return;

    if (ctx.workerLoop.lastActivityAge > IDLE_TIMEOUT_MS) {
      console.log(`Worker ${threadKey} idle for ${IDLE_TIMEOUT_MS / 1000}s, shutting down`);
      shutdown().catch((err) => console.error('Shutdown error during idle check:', err));
    }
  }, IDLE_CHECK_INTERVAL_MS);
}

// ── Shutdown ──────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  console.log(`Worker ${threadKey} shutting down...`);

  // Stop idle check
  if (idleCheckInterval) {
    clearInterval(idleCheckInterval);
    idleCheckInterval = undefined;
  }

  // Interrupt any in-progress session and wait for the SDK subprocess to exit
  // so we don't orphan a Claude Code process that holds the session.
  if (ctx) {
    await ctx.workerLoop.interruptAndWait();
  }

  // Deregister from gateway (expected exit, not a crash)
  try {
    await gatewayClient.call('worker.deregister', { threadKey, pid: process.pid });
  } catch { /* ignore — gateway may already be gone */ }

  // Deregister from persistence
  try {
    await persistenceClient.call('registry.deregister', { type: 'worker', threadKey });
  } catch { /* ignore — persistence may already be gone */ }

  // Stop cleanup interval
  if (ctx) {
    ctx.persistence.stopCleanupInterval();
  }

  // Close connections
  await gatewayClient.close();
  await persistenceClient.close();

  // Kill our entire process group to ensure no orphaned SDK subprocesses.
  // Workers are spawned with detached:true so this only affects our children.
  // SIGKILL cannot be caught, so this terminates us and all children immediately.
  try {
    process.kill(-process.pid, 'SIGKILL');
  } catch { /* already dead or not a group leader */ }
}

// ── Start ─────────────────────────────────────────────────────────

async function start(): Promise<void> {
  // 1. Parse config from env
  const config = loadConfig();

  // 2. Create and start RPC server (so gateway can reach us immediately)
  const workerServer = createWorkerRpcServer();
  await workerServer.listen();

  // 3. Create the worker context (wires all services together)
  ctx = createWorkerContext(config, gatewayClient, persistenceClient, threadKey);

  // 4. Connect persistence (with retry)
  await ctx.persistence.connect();

  // Register with persistence (identify already called by onConnect handler)
  await persistenceClient.call('registry.register', {
    type: 'worker',
    threadKey,
    pid: process.pid,
    socketPath: workerSocketPath(threadKey),
  });

  // 5. Connect to gateway (may not be up yet — auto-reconnect handles it)
  try {
    await gatewayClient.connect();
  } catch {
    // Gateway may not be running yet; the RpcClient reconnect will retry
  }

  // 6. Hydrate session ID from persistence (enables session resume after restart)
  await ctx.workerLoop.init();

  // 8. Start periodic cleanup of stale session files
  ctx.persistence.startCleanupInterval();

  // 9. Subscribe to inbound messages — tells persistence to start pushing
  // (also called by onConnect handler on reconnect, but we call explicitly
  // here to ensure subscription is active before we log "started")
  await persistenceClient.call('queue.subscribe', { queue: 'inbound', threadKey });
  persistenceInitialized = true; // Now safe to re-subscribe on reconnect

  // 10. Start idle check — will shut down if quiet for IDLE_TIMEOUT_MS
  startIdleCheck();

  console.log(`Worker ${threadKey} started (pid=${process.pid})`);
}

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Extract a human-readable pattern string from updatedPermissions.
 * e.g. "Bash(git:*)" or "acceptEdits mode"
 */
function formatPermPattern(perms: unknown[]): string | undefined {
  const labels: string[] = [];
  for (const p of perms) {
    if (typeof p !== 'object' || p === null) continue;
    const perm = p as Record<string, unknown>;
    if (perm.type === 'setMode' && typeof perm.mode === 'string') {
      labels.push(`${perm.mode} mode`);
      continue;
    }
    const rules = perm.rules;
    if (!Array.isArray(rules)) continue;
    for (const rule of rules) {
      if (typeof rule !== 'object' || rule === null) continue;
      const { toolName, ruleContent } = rule as Record<string, unknown>;
      if (typeof toolName === 'string' && typeof ruleContent === 'string') {
        labels.push(`${toolName}(${ruleContent})`);
      }
    }
  }
  return labels.length > 0 ? labels.join(', ') : undefined;
}

// ── Bootstrap ─────────────────────────────────────────────────────

start().catch((err) => {
  console.error(`Worker ${threadKey} failed to start:`, err);
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
  console.error(`Worker uncaught exception: ${err.message}`);
  setTimeout(() => process.exit(1), 100);
});

process.on('unhandledRejection', (reason) => {
  console.error(`Worker unhandled rejection: ${String(reason)}`);
});
