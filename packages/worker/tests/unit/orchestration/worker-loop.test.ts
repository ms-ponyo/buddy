// tests/unit/orchestration/worker-loop.test.ts
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { WorkerLoop, AsyncInputQueue } from '../../../src/orchestration/worker-loop';
import { mockLogger, type MockLogger } from '../../mocks/mock-logger';
import { mockSlackAdapter, type MockSlackAdapter } from '../../mocks/mock-slack-adapter';
import { mockPersistenceAdapter, type MockPersistenceAdapter } from '../../mocks/mock-persistence-adapter';
import type { BuddyConfig, ClaudeResult, ActiveExecution } from '../../../src/types';
import type { QueueMessage } from '@buddy/shared';

// ── Helpers ──────────────────────────────────────────────────────────

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
    enabledMcpServers: [],
    plugins: [],
    socketPath: '/tmp/test.sock',
    persistenceSocket: '/tmp/persistence.sock',
    gatewaySocket: '/tmp/gateway.sock',
    ...overrides,
  };
}

function makeQueueMessage(prompt: string, overrides: Partial<QueueMessage['payload']> = {}): QueueMessage {
  return {
    id: `msg-${Date.now()}`,
    queue: 'inbound',
    threadKey: 'C123:1234.5678',
    status: 'pending',
    payload: { prompt, messageTs: '1234.0001', ...overrides },
    retryCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeClaudeResult(overrides: Partial<ClaudeResult> = {}): ClaudeResult {
  return {
    result: 'Done!',
    isError: false,
    sessionId: 'sess-abc123',
    costUsd: 0.01,
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      contextWindowPercent: 10,
      numTurns: 1,
    },
    ...overrides,
  };
}

// ── Mock services factory ────────────────────────────────────────────

interface MockServices {
  config: BuddyConfig;
  slack: MockSlackAdapter;
  persistence: MockPersistenceAdapter;
  claudeSession: {
    invoke: jest.Mock;
    interrupt: jest.Mock;
    getSessionId: jest.Mock;
    setPermissionMode: jest.Mock;
  };
  progress: {
    finalizeCurrentCard: jest.Mock;
    onToolUse: jest.Mock;
    onToolResult: jest.Mock;
    onCompactionStatus: jest.Mock;
    onReasoningText: jest.Mock;
    onTodoUpdate: jest.Mock;
    onTaskCreate: jest.Mock;
    onTaskUpdate: jest.Mock;
    buildMainChunks: jest.Mock;
    buildTodoChunks: jest.Mock;
    buildThinkingText: jest.Mock;
  };
  permissions: {
    hasPending: boolean;
    requestPermission: jest.Mock;
    clearAll: jest.Mock;
    resolveInteraction: jest.Mock;
    staleCount: jest.Mock;
  };
  configOverrides: {
    resolveConfig: jest.Mock;
    getModel: jest.Mock;
    getEffort: jest.Mock;
    getBudget: jest.Mock;
    getPermissionMode: jest.Mock;
    setModel: jest.Mock;
    setEffort: jest.Mock;
    setBudget: jest.Mock;
    setPermissionMode: jest.Mock;
    reset: jest.Mock;
  };
  mcpRegistry: {
    createServers: jest.Mock;
    registerFactory: jest.Mock;
    getServerNames: jest.Mock;
  };
  logger: MockLogger;
}

function createMockServices(overrides: Partial<{ config: Partial<BuddyConfig> }> = {}): MockServices {
  const config = makeConfig(overrides.config);
  const logger = mockLogger();

  return {
    config,
    slack: mockSlackAdapter(),
    persistence: mockPersistenceAdapter(),
    claudeSession: {
      invoke: jest.fn(mockInvokeWithCallback(makeClaudeResult())),
      interrupt: jest.fn(() => true),
      getSessionId: jest.fn(() => undefined),
      setPermissionMode: jest.fn(),
    },
    progress: {
      finalizeCurrentCard: jest.fn(),
      onToolUse: jest.fn(),
      onToolResult: jest.fn(),
      onCompactionStatus: jest.fn(),
      onReasoningText: jest.fn(),
      onTodoUpdate: jest.fn(),
      onTaskCreate: jest.fn(),
      onTaskUpdate: jest.fn(),
      buildMainChunks: jest.fn(() => []),
      buildTodoChunks: jest.fn(() => []),
      buildThinkingText: jest.fn(() => 'is thinking...'),
    },
    permissions: {
      hasPending: false,
      requestPermission: jest.fn(),
      clearAll: jest.fn(),
      resolveInteraction: jest.fn(() => false),
      staleCount: jest.fn(() => 0),
    },
    configOverrides: {
      resolveConfig: jest.fn((base: BuddyConfig) => base),
      getModel: jest.fn(() => undefined),
      getEffort: jest.fn(() => undefined),
      getBudget: jest.fn(() => undefined),
      getPermissionMode: jest.fn(() => undefined),
      setModel: jest.fn(),
      setEffort: jest.fn(),
      setBudget: jest.fn(),
      setPermissionMode: jest.fn(),
      reset: jest.fn(),
    },
    mcpRegistry: {
      createServers: jest.fn(() => ({})),
      registerFactory: jest.fn(),
      getServerNames: jest.fn(() => []),
    },
    logger,
  };
}

function createWorkerLoop(services: MockServices): WorkerLoop {
  return new WorkerLoop({
    config: services.config,
    slack: services.slack as any,
    persistence: services.persistence as any,
    claudeSession: services.claudeSession as any,
    progress: services.progress as any,
    permissions: services.permissions as any,
    configOverrides: services.configOverrides as any,
    mcpRegistry: services.mcpRegistry as any,
    logger: services.logger as any,
    threadKey: 'C123:1234.5678',
    channel: 'C123',
    threadTs: '1234.5678',
  });
}

/**
 * Helper: creates a mock invoke implementation that fires onTurnResult
 * (as the real SDK would) before returning. Without this, the turn
 * completion promise in handleMessage never resolves.
 */
function mockInvokeWithCallback(result: ClaudeResult) {
  return async (params: any) => {
    if (params.callbacks?.onTurnResult) {
      params.callbacks.onTurnResult(result);
    }
    return result;
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('WorkerLoop', () => {
  let services: MockServices;
  let loop: WorkerLoop;

  beforeEach(() => {
    services = createMockServices();
    loop = createWorkerLoop(services);
  });

  // ── 1. handleMessage with no active session → starts new session ──

  describe('handleMessage with no active session', () => {
    it('invokes ClaudeSessionService and persists session ID', async () => {
      const msg = makeQueueMessage('Hello world');
      const expectedResult = makeClaudeResult({ sessionId: 'sess-new-123' });
      services.claudeSession.invoke.mockImplementation(mockInvokeWithCallback(expectedResult));

      await loop.handleMessage(msg);

      expect(services.claudeSession.invoke).toHaveBeenCalledTimes(1);
      expect(services.persistence.setSessionId).toHaveBeenCalledWith('C123', '1234.5678', 'sess-new-123');
    });

    it('passes the prompt to the SDK via the queue', async () => {
      const msg = makeQueueMessage('Build a feature');
      services.claudeSession.invoke.mockImplementation(async (params: any) => {
        // Consume the queue to verify content
        const iter = params.queue[Symbol.asyncIterator]();
        const first = await iter.next();
        expect(first.done).toBe(false);
        expect(first.value.message.content).toBe('Build a feature');
        // Close queue so iteration ends
        params.queue.close();
        return makeClaudeResult();
      });

      await loop.handleMessage(msg);
      expect(services.claudeSession.invoke).toHaveBeenCalledTimes(1);
    });

    it('posts usage summary to Slack on success', async () => {
      const msg = makeQueueMessage('Do something');
      services.claudeSession.invoke.mockImplementation(
        mockInvokeWithCallback(makeClaudeResult({ result: 'Task complete', isError: false })),
      );

      await loop.handleMessage(msg);

      // onTurnResult posts result text and usage summary
      expect(services.slack.postMessage).toHaveBeenCalled();
      expect(services.slack.appendToLastMessage).toHaveBeenCalled();
    });

    it('posts usage summary even on SDK error result', async () => {
      const msg = makeQueueMessage('Do something');
      services.claudeSession.invoke.mockImplementation(
        mockInvokeWithCallback(makeClaudeResult({ result: 'Something went wrong', isError: true })),
      );

      await loop.handleMessage(msg);

      // onTurnResult posts error text and usage summary
      expect(services.slack.postMessage).toHaveBeenCalled();
      expect(services.slack.appendToLastMessage).toHaveBeenCalled();
    });
  });

  // ── 2. handleMessage with active session → enqueues to SDK ────────

  describe('handleMessage with active session', () => {
    it('enqueues second message to the input queue instead of starting new session', async () => {
      let invokeResolve: (r: ClaudeResult) => void;
      const invokePromise = new Promise<ClaudeResult>((resolve) => {
        invokeResolve = resolve;
      });

      services.claudeSession.invoke.mockImplementation(async (params: any) => {
        // Signal that we're in the session — then wait
        return invokePromise;
      });

      // Start first message (will block on invoke)
      const firstMsg = makeQueueMessage('First message');
      const sessionPromise = loop.handleMessage(firstMsg);

      // Give the event loop a tick so the session starts
      await new Promise((r) => setTimeout(r, 10));

      // Second message should enqueue to the active queue (don't await —
      // turnDone won't resolve until the session ends)
      const secondMsg = makeQueueMessage('Second message');
      const secondPromise = loop.handleMessage(secondMsg);

      // Give the event loop a tick so the enqueue happens
      await new Promise((r) => setTimeout(r, 10));

      // invoke should have been called only once (for the first message)
      expect(services.claudeSession.invoke).toHaveBeenCalledTimes(1);

      // Resolve the invoke to complete — finally block drains turn completions
      invokeResolve!(makeClaudeResult());
      await sessionPromise;
      await secondPromise;
    });
  });

  // ── 3. init() hydrates sessionId from persistence ─────────────────

  describe('init', () => {
    it('hydrates session ID from persistence', async () => {
      services.persistence.getSessionId.mockResolvedValue('sess-hydrated-456');

      await loop.init();

      expect(services.persistence.getSessionId).toHaveBeenCalledWith('C123', '1234.5678');
    });

    it('logs when a session ID is found', async () => {
      services.persistence.getSessionId.mockResolvedValue('sess-hydrated-456');

      await loop.init();

      expect(services.logger.info).toHaveBeenCalledWith(
        'Hydrated session ID from persistence',
        expect.objectContaining({ sessionId: 'sess-hydrated-456' }),
      );
    });

    it('does not log when no session ID exists', async () => {
      services.persistence.getSessionId.mockResolvedValue(null);

      await loop.init();

      // info should NOT have been called with the hydration message
      const hydrationCalls = services.logger.info.mock.calls.filter(
        (c: any) => c[0] === 'Hydrated session ID from persistence',
      );
      expect(hydrationCalls).toHaveLength(0);
    });

    it('passes hydrated session ID to invoke on resume', async () => {
      services.persistence.getSessionId.mockResolvedValue('sess-resume-789');
      await loop.init();

      const msg = makeQueueMessage('Continue');
      services.claudeSession.invoke.mockResolvedValue(makeClaudeResult());
      await loop.handleMessage(msg);

      expect(services.claudeSession.invoke).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'sess-resume-789' }),
      );
    });
  });

  // ── 4. Multi-turn: onTurnResult returns true when pending ─────────

  describe('multi-turn via onTurnResult', () => {
    it('enqueues to active queue instead of starting new session when session is running', async () => {
      // Use a deferred promise to keep invoke blocked
      let resolveInvoke!: (r: ClaudeResult) => void;
      const invokeBlocker = new Promise<ClaudeResult>((resolve) => {
        resolveInvoke = resolve;
      });

      services.claudeSession.invoke.mockImplementation(async (_params: any) => {
        return invokeBlocker;
      });

      // Start first message — invoke will block
      const firstMsg = makeQueueMessage('First message');
      const sessionPromise = loop.handleMessage(firstMsg);

      // Give the event loop a tick so runSession has started and set inputQueue
      await new Promise((r) => setTimeout(r, 10));

      // While session is blocked, send a second message (don't await —
      // turnDone won't resolve until the session ends)
      const secondMsg = makeQueueMessage('Second message');
      const secondPromise = loop.handleMessage(secondMsg);

      // Give the event loop a tick so the enqueue happens
      await new Promise((r) => setTimeout(r, 10));

      // invoke should only have been called ONCE (for the first message)
      expect(services.claudeSession.invoke).toHaveBeenCalledTimes(1);

      // Now resolve the invoke to let the session complete
      resolveInvoke(makeClaudeResult());
      await sessionPromise;
      await secondPromise;
    });

    it('onTurnResult returns true when pending messages exist', async () => {
      let capturedOnTurnResult: ((result: ClaudeResult) => boolean) | null = null;
      let capturedIter: AsyncIterator<unknown> | null = null;
      let resolveInvoke!: (r: ClaudeResult) => void;
      const invokeBlocker = new Promise<ClaudeResult>((resolve) => {
        resolveInvoke = resolve;
      });

      services.claudeSession.invoke.mockImplementation(async (params: any) => {
        capturedOnTurnResult = params.callbacks.onTurnResult;
        // Simulate SDK consuming the first message from the queue
        capturedIter = params.queue[Symbol.asyncIterator]();
        await capturedIter!.next();
        return invokeBlocker;
      });

      const msg = makeQueueMessage('First');
      const sessionPromise = loop.handleMessage(msg);

      // Let runSession start and consume first message
      await new Promise((r) => setTimeout(r, 10));

      // Enqueue second message while session active (don't await — turnDone blocks)
      const secondPromise = loop.handleMessage(makeQueueMessage('Second'));
      await new Promise((r) => setTimeout(r, 10));

      // queue.pending = 1 (second message), so onTurnResult returns true
      expect(capturedOnTurnResult).not.toBeNull();
      const shouldContinue = capturedOnTurnResult!(makeClaudeResult());
      expect(shouldContinue).toBe(true);

      // Simulate SDK consuming the second message
      await capturedIter!.next();

      // onTurnResult always returns true (session stays alive for next message)
      const shouldStayAlive = capturedOnTurnResult!(makeClaudeResult());
      expect(shouldStayAlive).toBe(true);

      resolveInvoke(makeClaudeResult());
      await sessionPromise;
      await secondPromise;
    });
  });

  // ── 5. invokeWithResumeFallback: resume failure → new session ─────

  describe('invokeWithResumeFallback', () => {
    it('falls back to new session when resume fails', async () => {
      services.persistence.getSessionId.mockResolvedValue('sess-old');
      await loop.init();

      let callCount = 0;
      services.claudeSession.invoke.mockImplementation(async (params: any) => {
        callCount++;
        if (callCount === 1 && params.sessionId === 'sess-old') {
          throw new Error('Session not found');
        }
        const result = makeClaudeResult({ sessionId: 'sess-fresh' });
        if (params.callbacks?.onTurnResult) {
          params.callbacks.onTurnResult(result);
        }
        return result;
      });

      const msg = makeQueueMessage('Hello');
      await loop.handleMessage(msg);

      // Should have been called twice: once with resume, once fresh
      expect(services.claudeSession.invoke).toHaveBeenCalledTimes(2);
      // The second call should have sessionId=undefined (new session)
      const secondCall = services.claudeSession.invoke.mock.calls[1][0];
      expect(secondCall.sessionId).toBeUndefined();

      // Should have deleted the old session
      expect(services.persistence.deleteSession).toHaveBeenCalledWith('C123', '1234.5678');

      // Should persist the new session ID
      expect(services.persistence.setSessionId).toHaveBeenCalledWith('C123', '1234.5678', 'sess-fresh');
    });

    it('does not fall back on auth errors', async () => {
      services.persistence.getSessionId.mockResolvedValue('sess-old');
      await loop.init();

      services.claudeSession.invoke.mockRejectedValue(
        new Error('User does not have access to this resource'),
      );

      const msg = makeQueueMessage('Hello');
      await loop.handleMessage(msg);

      // Should only have tried once (auth errors are not retried as new session)
      expect(services.claudeSession.invoke).toHaveBeenCalledTimes(1);
      // Should have posted an error message
      expect(services.slack.postMessage).toHaveBeenCalled();
    });
  });

  // ── 6. Resume error detection → fallback ─────────────────────────

  describe('resume error fallback guard', () => {
    it('falls back to new session when resume returns error result', async () => {
      services.persistence.getSessionId.mockResolvedValue('sess-stale');
      await loop.init();

      let callCount = 0;
      services.claudeSession.invoke.mockImplementation(async (params: any) => {
        callCount++;
        if (callCount === 1) {
          // Return an error result (e.g. session not found)
          return makeClaudeResult({
            isError: true,
            result: 'Internal SDK error',
            sessionId: 'sess-stale',
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              contextWindowPercent: 0,
              numTurns: 0,
            },
          });
        }
        return makeClaudeResult({ sessionId: 'sess-recovered' });
      });

      const msg = makeQueueMessage('Hello');
      await loop.handleMessage(msg);

      // Should have invoked twice: first error, then fresh session
      expect(services.claudeSession.invoke).toHaveBeenCalledTimes(2);
      expect(services.persistence.deleteSession).toHaveBeenCalledWith('C123', '1234.5678');
    });

    it('falls back to new session even when error has non-zero tokens', async () => {
      services.persistence.getSessionId.mockResolvedValue('sess-active');
      await loop.init();

      let callCount = 0;
      services.claudeSession.invoke.mockImplementation(async (params: any) => {
        callCount++;
        if (callCount === 1) {
          // Return error with non-zero tokens (no successful response posted yet)
          return makeClaudeResult({
            isError: true,
            result: 'Tool execution failed',
            sessionId: 'sess-active',
            usage: {
              inputTokens: 500,
              outputTokens: 100,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              contextWindowPercent: 15,
              numTurns: 2,
            },
          });
        }
        return makeClaudeResult({ sessionId: 'sess-recovered' });
      });

      const msg = makeQueueMessage('Hello');
      await loop.handleMessage(msg);

      // Should fall back: error result with no successful response posted
      expect(services.claudeSession.invoke).toHaveBeenCalledTimes(2);
      expect(services.persistence.deleteSession).toHaveBeenCalledWith('C123', '1234.5678');
    });
  });

  // ── 7. awaitingUserInput checks all pending services ──────────────

  describe('awaitingUserInput', () => {
    it('returns false when no services have pending items', () => {
      expect(loop.awaitingUserInput).toBe(false);
    });

    it('returns true when permissions has pending', () => {
      (services.permissions as any).hasPending = true;
      // Need to create a new loop with updated services
      const loopWithPending = createWorkerLoop(services);
      expect(loopWithPending.awaitingUserInput).toBe(true);
    });

    it('returns false when permissions has no pending', () => {
      (services.permissions as any).hasPending = false;
      const loopNoPending = createWorkerLoop(services);
      expect(loopNoPending.awaitingUserInput).toBe(false);
    });
  });

  // ── 8. lastActivityAge computed correctly ─────────────────────────

  describe('lastActivityAge', () => {
    it('returns milliseconds since last activity', () => {
      // Fresh loop should have very low lastActivityAge
      const age = loop.lastActivityAge;
      expect(age).toBeGreaterThanOrEqual(0);
      expect(age).toBeLessThan(1000); // should be very recent
    });

    it('increases over time when no activity occurs', async () => {
      const initialAge = loop.lastActivityAge;
      await new Promise((r) => setTimeout(r, 50));
      const laterAge = loop.lastActivityAge;
      expect(laterAge).toBeGreaterThan(initialAge);
    });
  });

  // ── 9. interrupt() stops session ──────────────────────────────────

  describe('interrupt', () => {
    it('calls claudeSession.interrupt()', () => {
      loop.interrupt();
      expect(services.claudeSession.interrupt).toHaveBeenCalled();
    });

    it('logs the interruption', () => {
      loop.interrupt();
      expect(services.logger.info).toHaveBeenCalledWith('WorkerLoop interrupted');
    });
  });

  // ── currentExecution ──────────────────────────────────────────────

  describe('currentExecution', () => {
    it('is null when no session is running', () => {
      expect(loop.currentExecution).toBeNull();
    });

    it('is set during active session and null after completion', async () => {
      let execDuringSession: ActiveExecution | null = null;

      services.claudeSession.invoke.mockImplementation(async () => {
        execDuringSession = loop.currentExecution;
        return makeClaudeResult();
      });

      const msg = makeQueueMessage('Test');
      await loop.handleMessage(msg);

      // During session, currentExecution should have been set
      expect(execDuringSession).not.toBeNull();
      expect(execDuringSession!.channel).toBe('C123');
      expect(execDuringSession!.threadTs).toBe('1234.5678');

      // After session, should be null again
      expect(loop.currentExecution).toBeNull();
    });
  });

  // ── Session error handling ────────────────────────────────────────

  describe('session error handling', () => {
    it('posts error message on unrecoverable error', async () => {
      services.claudeSession.invoke.mockRejectedValue(new Error('Unrecoverable'));

      const msg = makeQueueMessage('Hello');
      await loop.handleMessage(msg);

      expect(services.slack.postMessage).toHaveBeenCalled();
      const calls = services.slack.postMessage.mock.calls;
      const errPost = calls.find((c: any) => typeof c[2] === 'string' && c[2].includes('Failed to run Claude Code'));
      expect(errPost).toBeDefined();
    });

    it('currentExecution is null after error', async () => {
      services.claudeSession.invoke.mockRejectedValue(new Error('Crash'));
      await loop.handleMessage(makeQueueMessage('Test'));
      expect(loop.currentExecution).toBeNull();
    });
  });

  // ── Config overrides integration ──────────────────────────────────

  describe('config overrides', () => {
    it('resolves config through configOverrides before invoking', async () => {
      const customConfig = makeConfig({ claudeModel: 'claude-opus-4-6' });
      services.configOverrides.resolveConfig.mockReturnValue(customConfig);
      services.claudeSession.invoke.mockResolvedValue(makeClaudeResult());

      await loop.handleMessage(makeQueueMessage('Test'));

      expect(services.configOverrides.resolveConfig).toHaveBeenCalledWith(services.config);
      const invokeCall = services.claudeSession.invoke.mock.calls[0][0];
      expect(invokeCall.config.claudeModel).toBe('claude-opus-4-6');
    });

    it('passes effort override as extraOptions', async () => {
      services.configOverrides.getEffort.mockReturnValue('high');
      services.claudeSession.invoke.mockResolvedValue(makeClaudeResult());

      await loop.handleMessage(makeQueueMessage('Test'));

      const invokeCall = services.claudeSession.invoke.mock.calls[0][0];
      expect(invokeCall.extraOptions).toEqual({ effort: 'high' });
    });

    it('passes budget override as extraOptions', async () => {
      services.configOverrides.getBudget.mockReturnValue(5.0);
      services.claudeSession.invoke.mockResolvedValue(makeClaudeResult());

      await loop.handleMessage(makeQueueMessage('Test'));

      const invokeCall = services.claudeSession.invoke.mock.calls[0][0];
      expect(invokeCall.extraOptions).toEqual({ maxBudgetUsd: 5.0 });
    });
  });

  // ── MCP registry integration ──────────────────────────────────────

  describe('MCP registry', () => {
    it('passes created MCP servers to invoke', async () => {
      const mockServers = { 'slack-tools': {} };
      services.mcpRegistry.createServers.mockReturnValue(mockServers);
      services.claudeSession.invoke.mockResolvedValue(makeClaudeResult());

      await loop.handleMessage(makeQueueMessage('Test'));

      expect(services.mcpRegistry.createServers).toHaveBeenCalled();
      const invokeCall = services.claudeSession.invoke.mock.calls[0][0];
      expect(invokeCall.mcpServers).toBe(mockServers);
    });
  });

  // ── Persistence operations ────────────────────────────────────────

  describe('persistence', () => {
    it('persists session ID and cost after successful completion', async () => {
      services.claudeSession.invoke.mockImplementation(
        mockInvokeWithCallback(makeClaudeResult({ sessionId: 'sess-persist', costUsd: 0.05 })),
      );

      await loop.handleMessage(makeQueueMessage('Test'));

      expect(services.persistence.setSessionId).toHaveBeenCalledWith('C123', '1234.5678', 'sess-persist');
      expect(services.persistence.addCost).toHaveBeenCalledWith('C123', '1234.5678', 0.05);
    });
  });

});

// ── AsyncInputQueue unit tests ──────────────────────────────────────

describe('AsyncInputQueue', () => {
  it('enqueue and iterate', async () => {
    const q = new AsyncInputQueue<string>();
    q.enqueue('a');
    q.enqueue('b');
    q.close();

    const items: string[] = [];
    for await (const item of q) {
      items.push(item);
    }
    expect(items).toEqual(['a', 'b']);
  });

  it('blocks until enqueue when empty', async () => {
    const q = new AsyncInputQueue<string>();
    const iter = q[Symbol.asyncIterator]();

    // Start waiting for next — should block
    const nextPromise = iter.next();

    // Enqueue after a tick
    setTimeout(() => q.enqueue('delayed'), 10);

    const result = await nextPromise;
    expect(result.done).toBe(false);
    expect(result.value).toBe('delayed');

    q.close();
  });

  it('returns done when closed', async () => {
    const q = new AsyncInputQueue<string>();
    q.close();

    const iter = q[Symbol.asyncIterator]();
    const result = await iter.next();
    expect(result.done).toBe(true);
  });

  it('enqueue returns false after close', () => {
    const q = new AsyncInputQueue<string>();
    q.close();
    expect(q.enqueue('x')).toBe(false);
  });

  it('tracks pending count', () => {
    const q = new AsyncInputQueue<string>();
    expect(q.pending).toBe(0);
    q.enqueue('a');
    expect(q.pending).toBe(1);
    q.enqueue('b');
    expect(q.pending).toBe(2);
  });

  it('throws if consumed twice', () => {
    const q = new AsyncInputQueue<string>();
    q[Symbol.asyncIterator]();
    expect(() => q[Symbol.asyncIterator]()).toThrow('already consumed');
  });

  it('closed getter reflects state', () => {
    const q = new AsyncInputQueue<string>();
    expect(q.closed).toBe(false);
    q.close();
    expect(q.closed).toBe(true);
  });
});
