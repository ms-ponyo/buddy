// src/context.ts — WorkerContext type and factory function.
// Creates all adapters, services, and orchestration layers in dependency order.

import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { RpcClient } from '@buddy/shared';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { BuddyConfig } from './types.js';
import { Logger } from './logger.js';
import { parseThreadKey } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Monorepo root — three levels up from packages/worker/src/ (or dist/) */
const MONOREPO_ROOT = resolve(__dirname, '../../..');
import { SlackAdapter } from './adapters/slack-adapter.js';
import { PersistenceAdapter } from './adapters/persistence-adapter.js';
import { ProgressTracker } from './services/progress-tracker.js';
import { ConfigOverrides } from './services/config-overrides.js';
import { PermissionManager } from './services/permission-manager.js';
import { InteractiveBridge } from './services/interactive-bridge.js';
import { McpRegistry } from './services/mcp-registry.js';
import { createSlackToolsServer } from './mcp-servers/slack-tools-server.js';
import { createVscodeTunnelServer } from './mcp-servers/vscode-tunnel-server.js';
import { InteractiveBashSession, createInteractiveBashServer } from './mcp-servers/interactive-bash-server.js';
import { ClaudeSessionService } from './services/claude-session.js';
import { BotCommandRouter } from './services/bot-command-router.js';
import { WorkerLoop } from './orchestration/worker-loop.js';
import { MessageHandler } from './orchestration/message-handler.js';

// ── WorkerContext ─────────────────────────────────────────────────

export interface WorkerContext {
  config: BuddyConfig;
  logger: Logger;
  slack: SlackAdapter;
  persistence: PersistenceAdapter;
  progress: ProgressTracker;
  permissions: PermissionManager;
  bridge: InteractiveBridge;
  interactiveBash: InteractiveBashSession;
  configOverrides: ConfigOverrides;
  mcpRegistry: McpRegistry;
  claudeSession: ClaudeSessionService;
  workerLoop: WorkerLoop;
  messageHandler: MessageHandler;
  threadKey: string;
  channel: string;
  threadTs: string;
}

// ── createWorkerContext ───────────────────────────────────────────

/**
 * Factory that wires all services together.
 * Creates adapters → services → orchestration in dependency order.
 */
export function createWorkerContext(
  config: BuddyConfig,
  gatewayClient: RpcClient,
  persistenceClient: RpcClient,
  threadKey: string,
): WorkerContext {
  const { channel, threadTs } = parseThreadKey(threadKey);

  const logFile = resolve(MONOREPO_ROOT, `logs/workers/${channel}_${threadTs}.log`);
  const logger = new Logger({
    module: 'worker',
    level: config.logLevel as any,
    filePath: logFile,
    context: { channel, threadTs },
  });

  // ── Adapters ───────────────────────────────────────────────────

  const slack = new SlackAdapter(gatewayClient, persistenceClient, threadKey);
  const persistence = new PersistenceAdapter(persistenceClient, logger);

  // ── Services (order matters — each may depend on previous) ─────

  const progress = new ProgressTracker();
  progress.setProjectDir(config.projectDir);
  const configOverrides = new ConfigOverrides();
  const permissions = new PermissionManager({
    slack,
    logger,
    onAwaitingInput: () => {
      slack.enqueueOutbound({ type: 'stream_pause', channel, threadTs, streamTypes: ['main'] }).catch(() => {});
    },
    onInputReceived: () => {
      // No explicit resume — next stream_chunk triggers implicit start on gateway
    },
  });
  const bridge = new InteractiveBridge({ slack, logger });
  const mcpRegistry = new McpRegistry();

  // Register in-process MCP server factories
  mcpRegistry.registerFactory('slack-tools', (env) => {
    const e = env as { channel: string; threadTs: string; config: BuddyConfig };
    return createSlackToolsServer({
      proxy: {
        conversationsReplies: (args) => slack.conversationsReplies(args),
        conversationsHistory: (args) => slack.conversationsHistory(args),
        filesInfo: (args) => slack.filesInfo(args),
        uploadFile: (ch, ts, filename, filePath, caption) => slack.uploadFile(ch, ts, filename, filePath, caption),
        ...(e.config.slackUserToken ? { searchMessages: (args) => slack.searchMessages(args) } : {}),
      },
      token: e.config.slackBotToken,
      channelId: e.channel,
      threadTs: e.threadTs,
      projectDir: e.config.projectDir,
    });
  });
  mcpRegistry.registerFactory('vscode-tunnel', () => createVscodeTunnelServer());
  const interactiveBash = new InteractiveBashSession({ logger });
  mcpRegistry.registerFactory('interactive-bash', () => createInteractiveBashServer(interactiveBash));

  const claudeSession = new ClaudeSessionService({ logger, queryFn: query as any });

  // ── Orchestration ──────────────────────────────────────────────

  const workerLoop = new WorkerLoop({
    config,
    slack,
    persistence,
    claudeSession,
    progress,
    permissions,
    bridge,
    configOverrides,
    mcpRegistry,
    logger,
    threadKey,
    channel,
    threadTs,
  });

  const messageHandler = new MessageHandler({
    workerLoop,
    persistence,
    slack,
    config,
    logger,
    threadKey,
  });

  return {
    config,
    logger,
    slack,
    persistence,
    progress,
    permissions,
    bridge,
    interactiveBash,
    configOverrides,
    mcpRegistry,
    claudeSession,
    workerLoop,
    messageHandler,
    threadKey,
    channel,
    threadTs,
  };
}
