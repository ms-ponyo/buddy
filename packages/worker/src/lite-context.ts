// src/lite-context.ts — Factory function that creates the LiteWorkerContext.
// Wires all dependencies for the lite worker process.

import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { RpcClient } from '@buddy/shared';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { BuddyConfig } from './types.js';
import { Logger } from './logger.js';
import { parseThreadKey } from './config.js';
import { SlackAdapter } from './adapters/slack-adapter.js';
import { PersistenceAdapter } from './adapters/persistence-adapter.js';
import { RemoteConfigOverrides } from './services/remote-config-overrides.js';
import { ClaudeSessionService } from './services/claude-session.js';
import { BotCommandRouter } from './services/bot-command-router.js';
import { DispatchHandler } from './handlers/dispatch-handler.js';
import { LiteMessageHandler } from './lite-message-handler.js';
import { allCommands } from './commands/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Monorepo root — three levels up from packages/worker/src/ (or dist/) */
const MONOREPO_ROOT = resolve(__dirname, '../../..');

// ── LiteWorkerContext ─────────────────────────────────────────────────

export interface LiteWorkerContext {
  logger: Logger;
  slack: SlackAdapter;
  persistence: PersistenceAdapter;
  remoteConfig: RemoteConfigOverrides;
  claudeSession: ClaudeSessionService;
  botCommandRouter: BotCommandRouter;
  dispatchHandler: DispatchHandler;
  liteMessageHandler: LiteMessageHandler;
  channel: string;
  threadTs: string;
  threadKey: string;
}

// ── createLiteWorkerContext ───────────────────────────────────────────

/**
 * Factory that wires all services together for the lite worker.
 * Creates adapters -> services -> handlers in dependency order.
 *
 * @param config        Worker config loaded from env
 * @param gatewayClient RPC client connected to the gateway
 * @param persistenceClient RPC client connected to the persistence server
 * @param mainWorkerRpc RPC client connected to the main worker
 * @param threadKey     Thread key in "CHANNEL:THREAD_TS" format
 * @param onShutdown    Callback invoked when the lite worker should shut down
 */
export function createLiteWorkerContext(
  config: BuddyConfig,
  gatewayClient: RpcClient,
  persistenceClient: RpcClient,
  mainWorkerRpc: RpcClient,
  threadKey: string,
  onShutdown: () => void,
): LiteWorkerContext {
  const { channel, threadTs } = parseThreadKey(threadKey);

  const logFile = resolve(MONOREPO_ROOT, `logs/lite-workers/${channel}_${threadTs}.log`);
  const logger = new Logger({
    module: 'lite-worker',
    level: config.logLevel as any,
    filePath: logFile,
    context: { channel, threadTs },
  });

  // ── Adapters ───────────────────────────────────────────────────

  const slack = new SlackAdapter(gatewayClient, persistenceClient, threadKey);
  const persistence = new PersistenceAdapter(persistenceClient, logger);

  // ── Services ───────────────────────────────────────────────────

  const remoteConfig = new RemoteConfigOverrides(mainWorkerRpc);

  const claudeSession = new ClaudeSessionService({ logger, queryFn: query as any });

  const botCommandRouter = new BotCommandRouter(
    {
      configOverrides: remoteConfig as any,  // RemoteConfigOverrides is duck-type compatible
      logger,
      config,
      // Lite worker does not have direct access to main worker execution — use RPC for status
      getCurrentExecution: () => null,
      logFile,
      getInitInfo: () => claudeSession.getInitInfo(),
      getAccountInfo: () => claudeSession.getAccountInfo(),
      getSessionCost: () => persistence.getCost(channel, threadTs),
      onInterrupt: async () => { await mainWorkerRpc.call('worker.interrupt'); },
      onPermissionModeChange: (mode) => { claudeSession.setPermissionMode(mode); },
      getSupportedCommands: async () => {
        try {
          const result = await mainWorkerRpc.call('worker.getSupportedCommands') as { commands: { name: string; description: string; argumentHint: string }[] | null };
          return result.commands;
        } catch {
          return null;
        }
      },
    },
    allCommands,
  );

  // ── Handlers ───────────────────────────────────────────────────

  const dispatchHandler = new DispatchHandler({
    claudeSession,
    slack,
    logger,
    channel,
    threadTs,
    config,
    remoteConfig,
    mainWorkerRpc,
    botCommandRouter,
  });

  const liteMessageHandler = new LiteMessageHandler({
    botCommandRouter,
    dispatchHandler,
    persistence,
    slack,
    config,
    logger,
    channel,
    threadTs,
    onShutdown,
  });

  return {
    logger,
    slack,
    persistence,
    remoteConfig,
    claudeSession,
    botCommandRouter,
    dispatchHandler,
    liteMessageHandler,
    channel,
    threadTs,
    threadKey,
  };
}
