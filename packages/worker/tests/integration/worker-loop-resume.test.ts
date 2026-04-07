// tests/integration/worker-loop-resume.test.ts — Integration test for session resume logic.
// Verifies: cached sessionId → SDK resume → fallback on failure (zero-token crash guard).

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mockWorkerContext } from '../mocks/mock-context.js';
import type { WorkerContext } from '../../src/context.js';
import type { QueueMessage } from '@buddy/shared';
import type { ClaudeResult } from '../../src/types.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeQueueMessage(prompt: string): QueueMessage {
  return {
    id: 'msg-resume',
    queue: 'inbound',
    threadKey: 'C_TEST:1700000000.000000',
    status: 'pending',
    payload: { prompt, messageTs: '1700000001.000000', userId: 'U_TEST' },
    retryCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const GOOD_RESULT: ClaudeResult = {
  result: 'Resumed successfully.',
  sessionId: 'session-resumed-456',
  isError: false,
  costUsd: 0.03,
  usage: {
    inputTokens: 200,
    outputTokens: 80,
    cacheReadTokens: 50,
    cacheCreationTokens: 0,
    contextWindowPercent: 10,
    numTurns: 2,
  },
};

const ZERO_TOKEN_RESULT: ClaudeResult = {
  result: 'An error occurred during resume',
  sessionId: 'session-old',
  isError: true,
  costUsd: 0,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    contextWindowPercent: 0,
    numTurns: 0,
  },
};

const SESSION_NOT_FOUND_RESULT: ClaudeResult = {
  result: 'No conversation found with session ID: abc-123',
  sessionId: 'session-old',
  isError: true,
  costUsd: 0,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    contextWindowPercent: 0,
    numTurns: 0,
  },
};

// ── Tests ────────────────────────────────────────────────────────────

describe('WorkerLoop resume integration', () => {
  let ctx: WorkerContext;
  let invokeStub: jest.Mock;

  beforeEach(async () => {
    ctx = mockWorkerContext();
    invokeStub = jest.fn() as any;
    (ctx.claudeSession as any).invoke = invokeStub;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── Successful resume with existing session ───────────────────────

  describe('successful resume', () => {
    it('passes cached sessionId to invoke when session exists', async () => {
      // Pre-seed a session ID
      await ctx.persistence.setSessionId('C_TEST', '1700000000.000000', 'cached-session-id');
      await ctx.workerLoop.init();

      invokeStub.mockResolvedValueOnce(GOOD_RESULT);

      const msg = makeQueueMessage('continue the conversation');
      await ctx.workerLoop.handleMessage(msg);

      expect(invokeStub).toHaveBeenCalledTimes(1);
      const invokeCall = invokeStub.mock.calls[0][0];
      expect(invokeCall.sessionId).toBe('cached-session-id');
    });

    it('uses new sessionId from result for subsequent invocations', async () => {
      await ctx.persistence.setSessionId('C_TEST', '1700000000.000000', 'old-session');
      await ctx.workerLoop.init();

      // First call: resume with old session, SDK returns new sessionId
      invokeStub.mockImplementationOnce(async (params: any) => {
        if (params.callbacks?.onTurnResult) params.callbacks.onTurnResult(GOOD_RESULT);
        return GOOD_RESULT;
      });

      const msg = makeQueueMessage('resume');
      await ctx.workerLoop.handleMessage(msg);

      // sessionId is only persisted on first set (guard: !this.sessionId),
      // but the in-memory value is updated. Verify by sending another message.
      invokeStub.mockImplementationOnce(async (params: any) => {
        if (params.callbacks?.onTurnResult) params.callbacks.onTurnResult(GOOD_RESULT);
        return GOOD_RESULT;
      });

      await new Promise((r) => setTimeout(r, 10));
      await ctx.workerLoop.handleMessage(makeQueueMessage('follow up'));

      const secondCall = invokeStub.mock.calls[1][0];
      expect(secondCall.sessionId).toBe('session-resumed-456');
    });
  });

  // ── Resume error guard (broadened from zero-token only) ──────────

  describe('resume error guard', () => {
    it('retries as new session when resume returns error result', async () => {
      await ctx.persistence.setSessionId('C_TEST', '1700000000.000000', 'old-crashed-session');
      await ctx.workerLoop.init();

      // First call returns zero-token error (resume crash), second call succeeds
      invokeStub
        .mockResolvedValueOnce(ZERO_TOKEN_RESULT)
        .mockResolvedValueOnce(GOOD_RESULT);

      const msg = makeQueueMessage('try again');
      await ctx.workerLoop.handleMessage(msg);

      // invoke should be called twice: first resume attempt, then fresh session
      expect(invokeStub).toHaveBeenCalledTimes(2);

      // Second call should NOT have the old session ID (fresh session)
      const secondCall = invokeStub.mock.calls[1][0];
      expect(secondCall.sessionId).toBeUndefined();

      // Old session should be deleted from persistence
      expect(ctx.persistence.deleteSession).toHaveBeenCalledWith(
        'C_TEST',
        '1700000000.000000',
      );

      // Warning about resume failure should be posted
      const posted = (ctx.slack as any).posted;
      const warningMsg = posted.find((p: any) => p.text.includes(':warning:') && p.text.includes('could not be resumed'));
      expect(warningMsg).toBeDefined();
    });
  });

  // ── SDK error-then-throw fallback ────────────────────────────────

  describe('SDK emits error result then throws', () => {
    it('retries as new session when SDK emits error via onTurnResult then throws', async () => {
      // This reproduces the exact bug: SDK returns a result message with
      // is_error: true (processed by onTurnResult), then the process exits
      // and the SDK throws "Claude Code returned an error result: ..."
      await ctx.persistence.setSessionId('C_TEST', '1700000000.000000', 'stale-session');
      await ctx.workerLoop.init();

      // First call: SDK emits error result via callback, then throws
      invokeStub
        .mockImplementationOnce(async (params: any) => {
          // SDK emits the error result through onTurnResult (just like the real SDK does)
          if (params.callbacks?.onTurnResult) {
            params.callbacks.onTurnResult(SESSION_NOT_FOUND_RESULT);
          }
          // Then the SDK throws (process exit wraps the error)
          throw new Error('Claude Code returned an error result: No conversation found with session ID: abc-123');
        })
        .mockImplementationOnce(async (params: any) => {
          if (params.callbacks?.onTurnResult) params.callbacks.onTurnResult(GOOD_RESULT);
          return GOOD_RESULT;
        });

      const msg = makeQueueMessage('hello');
      await ctx.workerLoop.handleMessage(msg);

      // handleMessage returns after onTurnResult resolves the turn promise,
      // but the retry/fallback runs asynchronously in the background session.
      // Wait for the background session to complete.
      await (ctx.workerLoop as any)._activeSessionPromise;

      // Should have attempted twice: failed resume, then fresh session
      expect(invokeStub).toHaveBeenCalledTimes(2);

      // Second call should be without session ID (fresh session)
      const secondCall = invokeStub.mock.calls[1][0];
      expect(secondCall.sessionId).toBeUndefined();

      // Old session should be deleted
      expect(ctx.persistence.deleteSession).toHaveBeenCalledWith('C_TEST', '1700000000.000000');

      // Recovery warning should be posted
      const posted = (ctx.slack as any).posted;
      const warningMsg = posted.find((p: any) => p.text.includes(':warning:') && p.text.includes('could not be resumed'));
      expect(warningMsg).toBeDefined();

      // Should NOT have the fatal :x: error
      const fatalError = posted.find((p: any) => p.text.includes(':x:'));
      expect(fatalError).toBeUndefined();
    });
  });

  // ── Resume error fallback ─────────────────────────────────────────

  describe('resume error fallback', () => {
    it('retries as new session when resume throws a non-auth error', async () => {
      await ctx.persistence.setSessionId('C_TEST', '1700000000.000000', 'broken-session');
      await ctx.workerLoop.init();

      // First call throws, second succeeds
      invokeStub
        .mockRejectedValueOnce(new Error('session not found'))
        .mockImplementationOnce(async (params: any) => {
          if (params.callbacks?.onTurnResult) params.callbacks.onTurnResult(GOOD_RESULT);
          return GOOD_RESULT;
        });

      const msg = makeQueueMessage('recover');
      await ctx.workerLoop.handleMessage(msg);

      // Should have attempted twice: once with resume, once without
      expect(invokeStub).toHaveBeenCalledTimes(2);

      // Second call should be without session ID
      const secondCall = invokeStub.mock.calls[1][0];
      expect(secondCall.sessionId).toBeUndefined();

      // Fresh session result should be persisted
      expect(ctx.persistence.setSessionId).toHaveBeenCalledWith(
        'C_TEST',
        '1700000000.000000',
        'session-resumed-456',
      );
    });

    it('propagates auth errors without fallback', async () => {
      await ctx.persistence.setSessionId('C_TEST', '1700000000.000000', 'session-auth');
      await ctx.workerLoop.init();

      invokeStub.mockRejectedValueOnce(new Error('User does not have access to this API'));

      const msg = makeQueueMessage('hello');
      await ctx.workerLoop.handleMessage(msg);

      // Should only call invoke once (no fallback for auth errors)
      expect(invokeStub).toHaveBeenCalledTimes(1);

      // Error should be posted to Slack
      const posted = (ctx.slack as any).posted;
      const errorMsg = posted.find((p: any) => p.text.includes(':x:'));
      expect(errorMsg).toBeDefined();
    });
  });

  // ── No session (fresh start) ──────────────────────────────────────

  describe('no cached session', () => {
    it('passes null sessionId when no session exists', async () => {
      await ctx.workerLoop.init();

      invokeStub.mockResolvedValueOnce(GOOD_RESULT);

      const msg = makeQueueMessage('brand new');
      await ctx.workerLoop.handleMessage(msg);

      const invokeCall = invokeStub.mock.calls[0][0];
      expect(invokeCall.sessionId).toBeNull();
    });
  });
});
