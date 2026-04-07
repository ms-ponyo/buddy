// tests/mocks/mock-context.ts — Factory that assembles a full WorkerContext for integration tests.
// Uses mock adapters (mock-slack-adapter, mock-persistence-adapter, mock-logger) and wires
// real service instances to them in the same order as createWorkerContext().

import { jest } from '@jest/globals';
import type { WorkerContext } from '../../src/context.js';
import { ProgressTracker } from '../../src/services/progress-tracker.js';
import { ConfigOverrides } from '../../src/services/config-overrides.js';
import { PermissionManager } from '../../src/services/permission-manager.js';
import { InteractiveBridge } from '../../src/services/interactive-bridge.js';
import { McpRegistry } from '../../src/services/mcp-registry.js';
import { ClaudeSessionService } from '../../src/services/claude-session.js';
import { WorkerLoop } from '../../src/orchestration/worker-loop.js';
import { MessageHandler } from '../../src/orchestration/message-handler.js';
import { mockSlackAdapter } from './mock-slack-adapter.js';
import { mockPersistenceAdapter } from './mock-persistence-adapter.js';
import { mockLogger } from './mock-logger.js';
import type { BuddyConfig } from '../../src/types.js';
import type { QueryFn } from '../../src/services/claude-session.js';

// ── Default config ─────────────────────────────────────────────────

const DEFAULT_CONFIG: BuddyConfig = {
  claudeModel: 'claude-opus-4-5',
  dispatchModel: 'claude-haiku-3-5',
  permissionMode: 'default',
  permissionDestination: 'thread',
  previewMode: 'off',
  logLevel: 'warn',
  logFile: '/tmp/test.log',
  projectDir: '/tmp/test-project',
  slackBotToken: 'xoxb-test-token',
  allowedUserIds: [],
  allowedChannelIds: [],
  adminUserIds: [],
  triggerEmoji: 'robot_face',
  projectMappingsFile: '',
  mcpServers: {},
  plugins: [],
  interactiveBridgePatterns: [],
  socketPath: '/tmp/test.sock',
  persistenceSocket: '/tmp/persistence.sock',
  gatewaySocket: '/tmp/gateway.sock',
};

// ── Default thread coordinates ─────────────────────────────────────

const DEFAULT_THREAD_KEY = 'C_TEST:1700000000.000000';
const DEFAULT_CHANNEL = 'C_TEST';
const DEFAULT_THREAD_TS = '1700000000.000000';

// ── mockWorkerContext ──────────────────────────────────────────────

/**
 * Assembles a full WorkerContext for use in integration tests.
 *
 * Creates mock adapters (slack, persistence, logger) and wires real
 * service instances to them in the same dependency order as
 * createWorkerContext(). Accepts Partial<WorkerContext> for overrides
 * so individual tests can replace specific services or fields.
 */
export function mockWorkerContext(overrides?: Partial<WorkerContext>): WorkerContext {
  const config = DEFAULT_CONFIG;
  const threadKey = DEFAULT_THREAD_KEY;
  const channel = DEFAULT_CHANNEL;
  const threadTs = DEFAULT_THREAD_TS;

  // ── Adapters ──────────────────────────────────────────────────

  const slack = mockSlackAdapter() as unknown as WorkerContext['slack'];
  const persistence = mockPersistenceAdapter() as unknown as WorkerContext['persistence'];
  const logger = mockLogger() as unknown as WorkerContext['logger'];

  // ── Services (order matches createWorkerContext) ───────────────

  const progress = new ProgressTracker();
  const configOverrides = new ConfigOverrides();
  const permissions = new PermissionManager({ slack, logger });
  const bridge = new InteractiveBridge({ slack, logger });
  const mcpRegistry = new McpRegistry();

  // ClaudeSessionService needs a queryFn; provide a no-op stub for tests.
  // Tests that actually invoke Claude should override claudeSession via the overrides parameter.
  const noopQueryFn: QueryFn = () => {
    throw new Error('queryFn not implemented in mock context — override claudeSession');
  };
  const claudeSession = new ClaudeSessionService({ logger, queryFn: noopQueryFn });

  // ── Orchestration ────────────────────────────────────────────

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

  // ── Assembled context ─────────────────────────────────────────

  const assembled: WorkerContext = {
    config,
    logger,
    slack,
    persistence,
    progress,
    permissions,
    bridge,
    configOverrides,
    mcpRegistry,
    claudeSession,
    workerLoop,
    messageHandler,
    threadKey,
    channel,
    threadTs,
  };

  return { ...assembled, ...overrides };
}
