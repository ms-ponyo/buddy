// tests/integration/worker-loop.test.ts — Integration test for WorkerLoop.
// Verifies the full message → session → completion flow using mockWorkerContext.

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mockWorkerContext } from '../mocks/mock-context.js';
import type { WorkerContext } from '../../src/context.js';
import type { QueueMessage } from '@buddy/shared';
import type { ClaudeResult } from '../../src/types.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeQueueMessage(prompt: string, overrides: Partial<QueueMessage> = {}): QueueMessage {
  return {
    id: 'msg-1',
    queue: 'inbound',
    threadKey: 'C_TEST:1700000000.000000',
    status: 'pending',
    payload: { prompt, messageTs: '1700000001.000000', userId: 'U_TEST' },
    retryCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const MOCK_RESULT: ClaudeResult = {
  result: 'Hello, this is the response.',
  sessionId: 'session-abc-123',
  isError: false,
  costUsd: 0.05,
  usage: {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    contextWindowPercent: 5,
    numTurns: 1,
  },
};

// ── Tests ────────────────────────────────────────────────────────────

describe('WorkerLoop integration', () => {
  let ctx: WorkerContext;
  let invokeStub: jest.Mock;

  beforeEach(() => {
    // Create a mock context with a stubbed claudeSession.invoke.
    // The stub must call onTurnResult (as the real SDK does) so that
    // per-turn side-effects (persistence, usage posting) fire and
    // the turn-completion promise resolves.
    invokeStub = jest.fn(async (params: any) => {
      if (params.callbacks?.onTurnResult) {
        params.callbacks.onTurnResult(MOCK_RESULT);
      }
      return MOCK_RESULT;
    }) as any;

    ctx = mockWorkerContext();

    // Override claudeSession.invoke to return our mock result
    (ctx.claudeSession as any).invoke = invokeStub;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── Full message → session → completion flow ──────────────────────

  describe('handleMessage() — full flow', () => {
    it('invokes ClaudeSession, stops stream, posts usage summary, and persists session', async () => {
      const msg = makeQueueMessage('Build a hello world app');

      await ctx.workerLoop.handleMessage(msg);

      // 1. ClaudeSession.invoke() was called
      expect(invokeStub).toHaveBeenCalledTimes(1);
      const invokeCall = invokeStub.mock.calls[0][0];
      expect(invokeCall).toBeDefined();
      expect(invokeCall.config).toBeDefined();
      expect(invokeCall.callbacks).toBeDefined();

      // 2. Session ID was persisted
      expect(ctx.persistence.setSessionId).toHaveBeenCalledWith(
        'C_TEST',
        '1700000000.000000',
        'session-abc-123',
      );

      // 3. Cost was persisted
      expect(ctx.persistence.addCost).toHaveBeenCalledWith(
        'C_TEST',
        '1700000000.000000',
        0.05,
      );

      // 4. Result text was posted to Slack by onTurnResult
      const posted = (ctx.slack as any).posted;
      const resultMsg = posted.find((p: any) => p.text === 'Hello, this is the response.');
      expect(resultMsg).toBeDefined();
      expect(resultMsg.channel).toBe('C_TEST');
      expect(resultMsg.threadTs).toBe('1700000000.000000');

      // 5. Usage footer was appended via appendToLastMessage
      expect((ctx.slack as any).appendToLastMessage).toHaveBeenCalled();
    });

    it('posts usage summary even when ClaudeSession returns isError=true', async () => {
      const errorResult: ClaudeResult = {
        ...MOCK_RESULT,
        isError: true,
        result: 'Something went wrong during execution',
      };
      invokeStub.mockImplementationOnce(async (params: any) => {
        if (params.callbacks?.onTurnResult) params.callbacks.onTurnResult(errorResult);
        return errorResult;
      });

      const msg = makeQueueMessage('do something dangerous');
      await ctx.workerLoop.handleMessage(msg);

      // onTurnResult posts error text and usage footer
      const posted = (ctx.slack as any).posted;
      const errorMsg = posted.find((p: any) => p.text.includes('Something went wrong'));
      expect(errorMsg).toBeDefined();
      expect((ctx.slack as any).appendToLastMessage).toHaveBeenCalled();
    });

    it('handles SDK invoke throwing an error', async () => {
      invokeStub.mockRejectedValueOnce(new Error('SDK connection failed'));

      const msg = makeQueueMessage('hello');
      await ctx.workerLoop.handleMessage(msg);


      const posted = (ctx.slack as any).posted;
      const errorMsg = posted.find((p: any) => p.text.includes(':x:'));
      expect(errorMsg).toBeDefined();
      expect(errorMsg.text).toContain('SDK connection failed');
    });

    it('does not post result when session was interrupted', async () => {
      const interruptedResult: ClaudeResult = {
        ...MOCK_RESULT,
        interrupted: true,
      };
      invokeStub.mockResolvedValueOnce(interruptedResult);

      const msg = makeQueueMessage('hello');
      await ctx.workerLoop.handleMessage(msg);


      const posted = (ctx.slack as any).posted;
      const resultMsg = posted.find((p: any) => p.text === 'Hello, this is the response.');
      expect(resultMsg).toBeUndefined();
    });

    it('does not post result text when result is empty', async () => {
      const emptyResult: ClaudeResult = {
        ...MOCK_RESULT,
        result: '   ',
      };
      invokeStub.mockImplementationOnce(async (params: any) => {
        if (params.callbacks?.onTurnResult) params.callbacks.onTurnResult(emptyResult);
        return emptyResult;
      });

      const msg = makeQueueMessage('hello');
      await ctx.workerLoop.handleMessage(msg);

      // No result text should be posted (whitespace-only is skipped)
      const posted = (ctx.slack as any).posted;
      const resultMsg = posted.find((p: any) => p.text.trim());
      expect(resultMsg).toBeUndefined();

      // Usage footer is still appended
      expect((ctx.slack as any).appendToLastMessage).toHaveBeenCalled();
    });
  });

  // ── Execution state lifecycle ─────────────────────────────────────

  describe('execution state', () => {
    it('currentExecution is null after session completes', async () => {
      const msg = makeQueueMessage('hello');
      await ctx.workerLoop.handleMessage(msg);
      // handleMessage resolves when onTurnResult fires; the session's
      // finally block (which clears currentExecution) runs right after
      await new Promise((r) => setTimeout(r, 10));
      expect(ctx.workerLoop.currentExecution).toBeNull();
    });

    it('currentExecution is null after session errors', async () => {
      invokeStub.mockRejectedValueOnce(new Error('fail'));
      const msg = makeQueueMessage('hello');
      await ctx.workerLoop.handleMessage(msg);
      expect(ctx.workerLoop.currentExecution).toBeNull();
    });
  });

  // ── init() hydrates session from persistence ──────────────────────

  describe('init()', () => {
    it('hydrates sessionId from persistence', async () => {
      // Pre-populate persistence with a session
      await ctx.persistence.setSessionId('C_TEST', '1700000000.000000', 'existing-session');

      await ctx.workerLoop.init();

      // Now handleMessage should invoke with the existing session ID
      const msg = makeQueueMessage('continue');
      await ctx.workerLoop.handleMessage(msg);

      const invokeCall = invokeStub.mock.calls[0][0];
      expect(invokeCall.sessionId).toBe('existing-session');
    });

    it('works when no session exists', async () => {
      await ctx.workerLoop.init();

      const msg = makeQueueMessage('fresh start');
      await ctx.workerLoop.handleMessage(msg);

      const invokeCall = invokeStub.mock.calls[0][0];
      expect(invokeCall.sessionId).toBeNull();
    });
  });
});
