// tests/unit/context.test.ts — Tests for createWorkerContext factory
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { createWorkerContext, type WorkerContext } from '../../src/context.js';
import { SlackAdapter } from '../../src/adapters/slack-adapter.js';
import { PersistenceAdapter } from '../../src/adapters/persistence-adapter.js';
import { ProgressTracker } from '../../src/services/progress-tracker.js';
import { ConfigOverrides } from '../../src/services/config-overrides.js';
import { PermissionManager } from '../../src/services/permission-manager.js';
import { InteractiveBridge } from '../../src/services/interactive-bridge.js';
import { McpRegistry } from '../../src/services/mcp-registry.js';
import { ClaudeSessionService } from '../../src/services/claude-session.js';
import { WorkerLoop } from '../../src/orchestration/worker-loop.js';
import { MessageHandler } from '../../src/orchestration/message-handler.js';
import { Logger } from '../../src/logger.js';
import type { BuddyConfig } from '../../src/types.js';

// ── Mock the SDK query function ────────────────────────────────────────

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
}));

// ── Helpers ───────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<BuddyConfig> = {}): BuddyConfig {
  return {
    claudeModel: 'claude-sonnet-4-6',
    dispatchModel: 'claude-haiku-4-5-20251001',
    permissionMode: 'default',
    permissionDestination: 'projectSettings',
    previewMode: 'moderate',
    logLevel: 'info',
    logFile: 'test.log',
    projectDir: '/tmp/project',
    slackBotToken: 'xoxb-test',
    allowedUserIds: [],
    allowedChannelIds: [],
    adminUserIds: [],
    triggerEmoji: 'eyes',
    projectMappingsFile: '',
    mcpServers: {},
    plugins: [],
    interactiveBridgePatterns: [],
    socketPath: '/tmp/test.sock',
    persistenceSocket: '/tmp/persistence.sock',
    gatewaySocket: '/tmp/gateway.sock',
    ...overrides,
  };
}

function makeRpcClient() {
  return {
    call: jest.fn<() => Promise<unknown>>().mockResolvedValue({}),
    notify: jest.fn(),
    connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    isConnected: true,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('createWorkerContext', () => {
  let config: BuddyConfig;
  let gatewayClient: ReturnType<typeof makeRpcClient>;
  let persistenceClient: ReturnType<typeof makeRpcClient>;
  const threadKey = 'C123:1234.5678';
  let ctx: WorkerContext;

  beforeEach(() => {
    config = makeConfig();
    gatewayClient = makeRpcClient();
    persistenceClient = makeRpcClient();
    ctx = createWorkerContext(config, gatewayClient as any, persistenceClient as any, threadKey);
  });

  // ── Returns all expected fields ──────────────────────────────────

  it('returns an object with all expected fields', () => {
    expect(ctx).toBeDefined();
    expect(ctx.config).toBeDefined();
    expect(ctx.logger).toBeDefined();
    expect(ctx.slack).toBeDefined();
    expect(ctx.persistence).toBeDefined();
    expect(ctx.progress).toBeDefined();
    expect(ctx.permissions).toBeDefined();
    expect(ctx.bridge).toBeDefined();
    expect(ctx.configOverrides).toBeDefined();
    expect(ctx.mcpRegistry).toBeDefined();
    expect(ctx.claudeSession).toBeDefined();
    expect(ctx.workerLoop).toBeDefined();
    expect(ctx.messageHandler).toBeDefined();
    expect(ctx.threadKey).toBeDefined();
    expect(ctx.channel).toBeDefined();
    expect(ctx.threadTs).toBeDefined();
  });

  // ── Thread key parsing ───────────────────────────────────────────

  it('parses threadKey into channel and threadTs', () => {
    expect(ctx.threadKey).toBe('C123:1234.5678');
    expect(ctx.channel).toBe('C123');
    expect(ctx.threadTs).toBe('1234.5678');
  });

  it('passes config through unchanged', () => {
    expect(ctx.config).toBe(config);
  });

  // ── Logger ───────────────────────────────────────────────────────

  it('creates a Logger instance', () => {
    expect(ctx.logger).toBeInstanceOf(Logger);
  });

  // ── Adapters are correctly typed ─────────────────────────────────

  it('creates a SlackAdapter instance', () => {
    expect(ctx.slack).toBeInstanceOf(SlackAdapter);
  });

  it('creates a PersistenceAdapter instance', () => {
    expect(ctx.persistence).toBeInstanceOf(PersistenceAdapter);
  });

  // ── Services are correctly typed ─────────────────────────────────

  it('creates a ProgressTracker instance', () => {
    expect(ctx.progress).toBeInstanceOf(ProgressTracker);
  });

  it('creates a ConfigOverrides instance', () => {
    expect(ctx.configOverrides).toBeInstanceOf(ConfigOverrides);
  });

  it('creates a PermissionManager instance', () => {
    expect(ctx.permissions).toBeInstanceOf(PermissionManager);
  });

  it('creates an InteractiveBridge instance', () => {
    expect(ctx.bridge).toBeInstanceOf(InteractiveBridge);
  });

  it('creates a McpRegistry instance', () => {
    expect(ctx.mcpRegistry).toBeInstanceOf(McpRegistry);
  });

  it('creates a ClaudeSessionService instance', () => {
    expect(ctx.claudeSession).toBeInstanceOf(ClaudeSessionService);
  });

  // ── Orchestration is correctly typed ────────────────────────────

  it('creates a WorkerLoop instance', () => {
    expect(ctx.workerLoop).toBeInstanceOf(WorkerLoop);
  });

  it('creates a MessageHandler instance', () => {
    expect(ctx.messageHandler).toBeInstanceOf(MessageHandler);
  });

  // ── Wiring verification ──────────────────────────────────────────

  it('SlackAdapter is wired with both RPC clients', () => {
    // SlackAdapter uses gatewayClient for direct calls, persistenceClient for queue
    // We can verify by checking it's the right instance type with correct clients
    expect(ctx.slack).toBeInstanceOf(SlackAdapter);
    expect(ctx.slack.isGatewayConnected()).toBe(true);
    expect(ctx.slack.isPersistenceConnected()).toBe(true);
  });

  // ── Different threadKey formats ───────────────────────────────────

  it('parses threadKey with complex threadTs', () => {
    const ctx2 = createWorkerContext(
      config,
      gatewayClient as any,
      persistenceClient as any,
      'CABCDEF:9999.0001',
    );
    expect(ctx2.channel).toBe('CABCDEF');
    expect(ctx2.threadTs).toBe('9999.0001');
    expect(ctx2.threadKey).toBe('CABCDEF:9999.0001');
  });

  it('throws on invalid threadKey', () => {
    expect(() => {
      createWorkerContext(config, gatewayClient as any, persistenceClient as any, 'invalid');
    }).toThrow();
  });

  it('each call to createWorkerContext returns distinct instances', () => {
    const ctx2 = createWorkerContext(
      config,
      makeRpcClient() as any,
      makeRpcClient() as any,
      threadKey,
    );
    expect(ctx.slack).not.toBe(ctx2.slack);
    expect(ctx.persistence).not.toBe(ctx2.persistence);
    expect(ctx.progress).not.toBe(ctx2.progress);
  });
});
