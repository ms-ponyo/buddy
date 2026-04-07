// tests/unit/services/claude-session.test.ts
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ClaudeSessionService } from '../../../src/services/claude-session';
import { mockLogger, type MockLogger } from '../../mocks/mock-logger';
import type { BuddyConfig, SessionCallbacks, ClaudeResult } from '../../../src/types';

// ── Mock SDK query ──────────────────────────────────────────────

interface MockQuery {
  messages: Array<Record<string, unknown>>;
  close: jest.Mock;
  setPermissionMode: jest.Mock;
  accountInfo: jest.Mock;
  [Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>>;
}

function createMockQuery(messages: Array<Record<string, unknown>>): MockQuery {
  let idx = 0;
  return {
    messages,
    close: jest.fn(),
    setPermissionMode: jest.fn(),
    accountInfo: jest.fn(() => Promise.resolve({})),
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          if (idx < messages.length) {
            return { value: messages[idx++], done: false };
          }
          return { value: undefined, done: true };
        },
      };
    },
  };
}

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
    triggerEmoji: 'robot_face',
    projectMappingsFile: '',
    mcpServers: {},
    plugins: [],
    interactiveBridgePatterns: [],
    socketPath: '/tmp/sock',
    persistenceSocket: '/tmp/persist',
    gatewaySocket: '/tmp/gateway',
    ...overrides,
  };
}

function makeCallbacks(overrides: Partial<SessionCallbacks> = {}): SessionCallbacks {
  return {
    onSessionInit: jest.fn(),
    onAssistantText: jest.fn(),
    onToolUse: jest.fn(),
    onToolResult: jest.fn(),
    onToolProgress: jest.fn(),
    onStreamDelta: jest.fn(),
    onThinkingDelta: jest.fn(),
    onStatusChange: jest.fn(),
    onImageContent: jest.fn(),
    onTurnResult: jest.fn(() => false),
    ...overrides,
  };
}

// A minimal async input queue for tests
function createTestQueue(messages: string[]) {
  let idx = 0;
  let closed = false;
  return {
    push(_item: unknown) { /* no-op for test */ },
    done() { closed = true; },
    close() { closed = true; },
    get closed() { return closed; },
    get pending() { return 0; },
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          if (idx < messages.length) {
            return { value: { content: messages[idx++] }, done: false };
          }
          return { value: undefined, done: true };
        },
      };
    },
  };
}

describe('ClaudeSessionService', () => {
  let logger: MockLogger;
  let service: ClaudeSessionService;
  let mockQueryFn: jest.Mock;

  beforeEach(() => {
    logger = mockLogger();
    mockQueryFn = jest.fn();
    service = new ClaudeSessionService({
      logger: logger as any,
      queryFn: mockQueryFn as any,
    });
  });

  // ── invoke — basic flow ───────────────────────────────────────────

  describe('invoke()', () => {
    it('streams through init → assistant → result messages and returns ClaudeResult', async () => {
      const mockQ = createMockQuery([
        {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-001',
          tools: [],
          mcp_servers: [],
          plugins: [],
          skills: [],
          slash_commands: [],
          claude_code_version: '2.1.0',
          cwd: '/tmp',
          model: 'claude-sonnet-4-6',
          permissionMode: 'default',
        },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Hello from Claude' },
            ],
            usage: {},
          },
        },
        {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-001',
          result: 'Hello from Claude',
          is_error: false,
          total_cost_usd: 0.01,
          num_turns: 1,
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          modelUsage: {
            'claude-sonnet-4-6': { contextWindow: 200000 },
          },
        },
      ]);

      mockQueryFn.mockReturnValue(mockQ);

      const callbacks = makeCallbacks();
      const queue = createTestQueue(['hello']);

      const result = await service.invoke({
        queue: queue as any,
        config: makeConfig(),
        callbacks,
      });

      expect(result.sessionId).toBe('sess-001');
      expect(result.result).toBe('Hello from Claude');
      expect(result.isError).toBe(false);
      expect(result.costUsd).toBe(0.01);
      expect(result.usage.numTurns).toBe(1);
    });

    it('calls onSessionInit callback with sessionId', async () => {
      const mockQ = createMockQuery([
        {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-002',
          tools: [],
          mcp_servers: [],
          plugins: [],
          skills: [],
          slash_commands: [],
          claude_code_version: '2.1.0',
          cwd: '/tmp',
          model: 'claude-sonnet-4-6',
          permissionMode: 'default',
        },
        {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-002',
          result: 'done',
          is_error: false,
          total_cost_usd: 0,
          num_turns: 1,
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          modelUsage: {},
        },
      ]);
      mockQueryFn.mockReturnValue(mockQ);

      const callbacks = makeCallbacks();
      const queue = createTestQueue(['test']);

      await service.invoke({ queue: queue as any, config: makeConfig(), callbacks });

      expect(callbacks.onSessionInit).toHaveBeenCalledWith('sess-002');
    });

    it('calls onAssistantText for text blocks', async () => {
      const mockQ = createMockQuery([
        {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-003',
          tools: [], mcp_servers: [], plugins: [], skills: [], slash_commands: [],
          claude_code_version: '2.1.0', cwd: '/tmp', model: 'test', permissionMode: 'default',
        },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'First block' },
              { type: 'text', text: 'Second block' },
            ],
            usage: {},
          },
        },
        {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-003',
          result: 'done',
          is_error: false,
          total_cost_usd: 0,
          num_turns: 1,
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          modelUsage: {},
        },
      ]);
      mockQueryFn.mockReturnValue(mockQ);

      const callbacks = makeCallbacks();
      await service.invoke({ queue: createTestQueue([]) as any, config: makeConfig(), callbacks });

      expect(callbacks.onAssistantText).toHaveBeenCalledWith('First block');
      expect(callbacks.onAssistantText).toHaveBeenCalledWith('Second block');
    });

    it('calls onToolUse for tool_use blocks', async () => {
      const mockQ = createMockQuery([
        {
          type: 'system', subtype: 'init', session_id: 's4',
          tools: [], mcp_servers: [], plugins: [], skills: [], slash_commands: [],
          claude_code_version: '2.1.0', cwd: '/tmp', model: 'test', permissionMode: 'default',
        },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'Bash', id: 'tu-1', input: { command: 'ls' } },
            ],
            usage: {},
          },
        },
        {
          type: 'result', subtype: 'success', session_id: 's4', result: 'done',
          is_error: false, total_cost_usd: 0, num_turns: 1,
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          modelUsage: {},
        },
      ]);
      mockQueryFn.mockReturnValue(mockQ);

      const callbacks = makeCallbacks();
      await service.invoke({ queue: createTestQueue([]) as any, config: makeConfig(), callbacks });

      expect(callbacks.onToolUse).toHaveBeenCalledWith('Bash', { command: 'ls' }, 'tu-1');
    });

    it('handles error results', async () => {
      const mockQ = createMockQuery([
        {
          type: 'system', subtype: 'init', session_id: 's5',
          tools: [], mcp_servers: [], plugins: [], skills: [], slash_commands: [],
          claude_code_version: '2.1.0', cwd: '/tmp', model: 'test', permissionMode: 'default',
        },
        {
          type: 'result',
          subtype: 'error',
          session_id: 's5',
          result: '',
          errors: ['Something went wrong', 'Another error'],
          is_error: true,
          total_cost_usd: 0.005,
          num_turns: 0,
          usage: { input_tokens: 50, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          modelUsage: {},
        },
      ]);
      mockQueryFn.mockReturnValue(mockQ);

      const callbacks = makeCallbacks();
      const result = await service.invoke({ queue: createTestQueue([]) as any, config: makeConfig(), callbacks });

      expect(result.isError).toBe(true);
      expect(result.result).toBe('Something went wrong\nAnother error');
    });

    it('resumes a session using sessionId', async () => {
      const mockQ = createMockQuery([
        {
          type: 'system', subtype: 'init', session_id: 'resumed-sess',
          tools: [], mcp_servers: [], plugins: [], skills: [], slash_commands: [],
          claude_code_version: '2.1.0', cwd: '/tmp', model: 'test', permissionMode: 'default',
        },
        {
          type: 'result', subtype: 'success', session_id: 'resumed-sess',
          result: 'resumed', is_error: false, total_cost_usd: 0, num_turns: 1,
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          modelUsage: {},
        },
      ]);
      mockQueryFn.mockReturnValue(mockQ);

      const callbacks = makeCallbacks();
      await service.invoke({
        queue: createTestQueue([]) as any,
        config: makeConfig(),
        sessionId: 'existing-session-id',
        callbacks,
      });

      // The queryFn should have been called with resume option
      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            resume: 'existing-session-id',
          }),
        }),
      );
    });
  });

  // ── getSessionId ──────────────────────────────────────────────────

  describe('getSessionId()', () => {
    it('returns undefined before any invocation', () => {
      expect(service.getSessionId()).toBeUndefined();
    });

    it('returns session ID after invocation', async () => {
      const mockQ = createMockQuery([
        {
          type: 'system', subtype: 'init', session_id: 'tracked-sess',
          tools: [], mcp_servers: [], plugins: [], skills: [], slash_commands: [],
          claude_code_version: '2.1.0', cwd: '/tmp', model: 'test', permissionMode: 'default',
        },
        {
          type: 'result', subtype: 'success', session_id: 'tracked-sess',
          result: 'ok', is_error: false, total_cost_usd: 0, num_turns: 1,
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          modelUsage: {},
        },
      ]);
      mockQueryFn.mockReturnValue(mockQ);

      await service.invoke({
        queue: createTestQueue([]) as any,
        config: makeConfig(),
        callbacks: makeCallbacks(),
      });

      expect(service.getSessionId()).toBe('tracked-sess');
    });
  });

  // ── interrupt ─────────────────────────────────────────────────────

  describe('interrupt()', () => {
    it('returns false when no active query', () => {
      expect(service.interrupt()).toBe(false);
    });

    it('returns true and closes query when active', async () => {
      // Create a mock query that blocks until close is called
      let resolveBlock: (() => void) | undefined;
      const blockPromise = new Promise<void>((resolve) => { resolveBlock = resolve; });

      const mockQ = {
        close: jest.fn(() => { resolveBlock?.(); }),
        setPermissionMode: jest.fn(),
        accountInfo: jest.fn(() => Promise.resolve({})),
        [Symbol.asyncIterator]() {
          let emittedInit = false;
          return {
            next: async () => {
              if (!emittedInit) {
                emittedInit = true;
                return {
                  value: {
                    type: 'system', subtype: 'init', session_id: 'int-sess',
                    tools: [], mcp_servers: [], plugins: [], skills: [], slash_commands: [],
                    claude_code_version: '2.1.0', cwd: '/tmp', model: 'test', permissionMode: 'default',
                  },
                  done: false,
                };
              }
              // Block until close is called
              await blockPromise;
              return { value: undefined, done: true };
            },
          };
        },
      };

      mockQueryFn.mockReturnValue(mockQ);

      const invokePromise = service.invoke({
        queue: createTestQueue([]) as any,
        config: makeConfig(),
        callbacks: makeCallbacks(),
      });

      // Wait a tick for the query to start
      await new Promise((resolve) => setTimeout(resolve, 10));

      const interrupted = service.interrupt();
      expect(interrupted).toBe(true);
      expect(mockQ.close).toHaveBeenCalled();

      // Await the invoke to finish
      const result = await invokePromise;
      expect(result.interrupted).toBe(true);
    });
  });

  // ── setPermissionMode ─────────────────────────────────────────────

  describe('setPermissionMode()', () => {
    it('delegates to active query setPermissionMode', async () => {
      // Set up a query that blocks so we can call setPermissionMode mid-flight
      let resolveBlock: (() => void) | undefined;
      const blockPromise = new Promise<void>((resolve) => { resolveBlock = resolve; });

      const mockQ = {
        close: jest.fn(() => { resolveBlock?.(); }),
        setPermissionMode: jest.fn(),
        accountInfo: jest.fn(() => Promise.resolve({})),
        [Symbol.asyncIterator]() {
          let emittedInit = false;
          return {
            next: async () => {
              if (!emittedInit) {
                emittedInit = true;
                return {
                  value: {
                    type: 'system', subtype: 'init', session_id: 'mode-sess',
                    tools: [], mcp_servers: [], plugins: [], skills: [], slash_commands: [],
                    claude_code_version: '2.1.0', cwd: '/tmp', model: 'test', permissionMode: 'default',
                  },
                  done: false,
                };
              }
              await blockPromise;
              return { value: undefined, done: true };
            },
          };
        },
      };

      mockQueryFn.mockReturnValue(mockQ);

      const invokePromise = service.invoke({
        queue: createTestQueue([]) as any,
        config: makeConfig(),
        callbacks: makeCallbacks(),
      });

      // Wait for query to start
      await new Promise((resolve) => setTimeout(resolve, 10));

      service.setPermissionMode('bypassPermissions');
      expect(mockQ.setPermissionMode).toHaveBeenCalledWith('bypassPermissions');

      // Clean up: close the query so invoke returns
      mockQ.close();
      await invokePromise;
    });

    it('does nothing when no active query', () => {
      // Should not throw
      expect(() => service.setPermissionMode('plan')).not.toThrow();
    });
  });

  // ── thinking deltas ──────────────────────────────────────────────

  describe('thinking deltas', () => {
    it('calls onThinkingDelta for thinking_delta stream events', async () => {
      const mockQ = createMockQuery([
        {
          type: 'system', subtype: 'init', session_id: 's-think',
          tools: [], mcp_servers: [], plugins: [], skills: [], slash_commands: [],
          claude_code_version: '2.1.0', cwd: '/tmp', model: 'test', permissionMode: 'default',
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'thinking_delta', thinking: 'Let me analyze this' },
          },
        },
        {
          type: 'result', subtype: 'success', session_id: 's-think',
          result: 'done', is_error: false, total_cost_usd: 0, num_turns: 1,
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          modelUsage: {},
        },
      ]);
      mockQueryFn.mockReturnValue(mockQ);

      const callbacks = makeCallbacks();
      await service.invoke({ queue: createTestQueue([]) as any, config: makeConfig(), callbacks });

      expect(callbacks.onThinkingDelta).toHaveBeenCalledWith('Let me analyze this');
    });

    it('calls onThinkingDelta for thinking blocks in assistant messages', async () => {
      const mockQ = createMockQuery([
        {
          type: 'system', subtype: 'init', session_id: 's-think2',
          tools: [], mcp_servers: [], plugins: [], skills: [], slash_commands: [],
          claude_code_version: '2.1.0', cwd: '/tmp', model: 'test', permissionMode: 'default',
        },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'thinking', thinking: 'I should read the config file' },
              { type: 'tool_use', name: 'Read', id: 'tu-think', input: { file_path: '/config.ts' } },
            ],
            usage: {},
          },
        },
        {
          type: 'result', subtype: 'success', session_id: 's-think2',
          result: 'done', is_error: false, total_cost_usd: 0, num_turns: 1,
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          modelUsage: {},
        },
      ]);
      mockQueryFn.mockReturnValue(mockQ);

      const callbacks = makeCallbacks();
      await service.invoke({ queue: createTestQueue([]) as any, config: makeConfig(), callbacks });

      expect(callbacks.onThinkingDelta).toHaveBeenCalledWith('I should read the config file');
      expect(callbacks.onToolUse).toHaveBeenCalledWith('Read', { file_path: '/config.ts' }, 'tu-think');
    });
  });

  // ── compaction status ─────────────────────────────────────────────

  describe('compaction status', () => {
    it('calls onStatusChange when system status message received', async () => {
      const mockQ = createMockQuery([
        {
          type: 'system', subtype: 'init', session_id: 's-compact',
          tools: [], mcp_servers: [], plugins: [], skills: [], slash_commands: [],
          claude_code_version: '2.1.0', cwd: '/tmp', model: 'test', permissionMode: 'default',
        },
        {
          type: 'system', subtype: 'status', status: 'compacting',
        },
        {
          type: 'result', subtype: 'success', session_id: 's-compact',
          result: 'ok', is_error: false, total_cost_usd: 0, num_turns: 1,
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          modelUsage: {},
        },
      ]);
      mockQueryFn.mockReturnValue(mockQ);

      const callbacks = makeCallbacks();
      await service.invoke({
        queue: createTestQueue([]) as any,
        config: makeConfig(),
        callbacks,
      });

      expect(callbacks.onStatusChange).toHaveBeenCalledWith('compacting');
    });
  });

  // ── getInitInfo ───────────────────────────────────────────────────

  describe('getInitInfo()', () => {
    it('returns null before any invocation', () => {
      expect(service.getInitInfo()).toBeNull();
    });

    it('caches init info from SDK init message', async () => {
      const mockQ = createMockQuery([
        {
          type: 'system',
          subtype: 'init',
          session_id: 'init-info-sess',
          tools: [],
          mcp_servers: [
            { name: 'filesystem', status: 'connected' },
            { name: 'slack', status: 'needs-auth' },
          ],
          plugins: [
            { name: 'superpowers', path: '/plugins/superpowers' },
          ],
          skills: [],
          slash_commands: [],
          claude_code_version: '2.3.0',
          cwd: '/home/user/project',
          model: 'claude-opus-4-6',
          permissionMode: 'bypassPermissions',
        },
        {
          type: 'result',
          subtype: 'success',
          session_id: 'init-info-sess',
          result: 'ok',
          is_error: false,
          total_cost_usd: 0,
          num_turns: 1,
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          modelUsage: {},
        },
      ]);
      mockQueryFn.mockReturnValue(mockQ);

      await service.invoke({
        queue: createTestQueue([]) as any,
        config: makeConfig(),
        callbacks: makeCallbacks(),
      });

      const info = service.getInitInfo();
      expect(info).not.toBeNull();
      expect(info!.claudeCodeVersion).toBe('2.3.0');
      expect(info!.cwd).toBe('/home/user/project');
      expect(info!.model).toBe('claude-opus-4-6');
      expect(info!.permissionMode).toBe('bypassPermissions');
      expect(info!.mcpServers).toEqual([
        { name: 'filesystem', status: 'connected' },
        { name: 'slack', status: 'needs-auth' },
      ]);
      expect(info!.plugins).toEqual([
        { name: 'superpowers', path: '/plugins/superpowers' },
      ]);
    });

    it('defaults mcpServers and plugins to empty arrays when missing', async () => {
      const mockQ = createMockQuery([
        {
          type: 'system',
          subtype: 'init',
          session_id: 'init-empty',
          tools: [],
          skills: [],
          slash_commands: [],
          claude_code_version: '2.3.0',
          cwd: '/tmp',
          model: 'test',
          permissionMode: 'default',
          // no mcp_servers or plugins
        },
        {
          type: 'result',
          subtype: 'success',
          session_id: 'init-empty',
          result: 'ok',
          is_error: false,
          total_cost_usd: 0,
          num_turns: 1,
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          modelUsage: {},
        },
      ]);
      mockQueryFn.mockReturnValue(mockQ);

      await service.invoke({
        queue: createTestQueue([]) as any,
        config: makeConfig(),
        callbacks: makeCallbacks(),
      });

      const info = service.getInitInfo();
      expect(info!.mcpServers).toEqual([]);
      expect(info!.plugins).toEqual([]);
    });
  });

  // ── getAccountInfo ────────────────────────────────────────────────

  describe('getAccountInfo()', () => {
    it('returns null before any invocation', () => {
      expect(service.getAccountInfo()).toBeNull();
    });

    it('caches account info fetched from SDK', async () => {
      const mockQ = createMockQuery([
        {
          type: 'system',
          subtype: 'init',
          session_id: 'acct-sess',
          tools: [],
          mcp_servers: [],
          plugins: [],
          skills: [],
          slash_commands: [],
          claude_code_version: '2.3.0',
          cwd: '/tmp',
          model: 'test',
          permissionMode: 'default',
        },
        {
          type: 'result',
          subtype: 'success',
          session_id: 'acct-sess',
          result: 'ok',
          is_error: false,
          total_cost_usd: 0,
          num_turns: 1,
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          modelUsage: {},
        },
      ]);
      // Configure accountInfo to return real data
      mockQ.accountInfo.mockResolvedValue({
        email: 'user@example.com',
        organization: 'Acme Corp',
        subscriptionType: 'pro',
      });
      mockQueryFn.mockReturnValue(mockQ);

      await service.invoke({
        queue: createTestQueue([]) as any,
        config: makeConfig(),
        callbacks: makeCallbacks(),
      });

      // accountInfo is fetched asynchronously — wait a tick
      await new Promise((resolve) => setTimeout(resolve, 10));

      const acct = service.getAccountInfo();
      expect(acct).not.toBeNull();
      expect(acct!.email).toBe('user@example.com');
      expect(acct!.organization).toBe('Acme Corp');
      expect(acct!.subscriptionType).toBe('pro');
    });

    it('handles accountInfo failure gracefully', async () => {
      const mockQ = createMockQuery([
        {
          type: 'system',
          subtype: 'init',
          session_id: 'acct-fail',
          tools: [],
          mcp_servers: [],
          plugins: [],
          skills: [],
          slash_commands: [],
          claude_code_version: '2.3.0',
          cwd: '/tmp',
          model: 'test',
          permissionMode: 'default',
        },
        {
          type: 'result',
          subtype: 'success',
          session_id: 'acct-fail',
          result: 'ok',
          is_error: false,
          total_cost_usd: 0,
          num_turns: 1,
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          modelUsage: {},
        },
      ]);
      // Simulate accountInfo failure
      mockQ.accountInfo.mockRejectedValue(new Error('auth failed'));
      mockQueryFn.mockReturnValue(mockQ);

      await service.invoke({
        queue: createTestQueue([]) as any,
        config: makeConfig(),
        callbacks: makeCallbacks(),
      });

      // Wait for the rejected promise to settle
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should remain null on failure, not throw
      expect(service.getAccountInfo()).toBeNull();
    });
  });
});
