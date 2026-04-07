// tests/integration/worker-loop-multiturn.test.ts — Integration test for multi-turn sessions.
// Verifies: multiple messages → single session, queue stays open via onTurnResult.

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mockWorkerContext } from '../mocks/mock-context.js';
import type { WorkerContext } from '../../src/context.js';
import type { QueueMessage } from '@buddy/shared';
import type { ClaudeResult, SessionCallbacks } from '../../src/types.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeQueueMessage(prompt: string, id = 'msg-1'): QueueMessage {
  return {
    id,
    queue: 'inbound',
    threadKey: 'C_TEST:1700000000.000000',
    status: 'pending',
    payload: { prompt, messageTs: '1700000001.000000', userId: 'U_TEST' },
    retryCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('WorkerLoop multi-turn integration', () => {
  let ctx: WorkerContext;
  let invokeStub: jest.Mock;

  beforeEach(() => {
    ctx = mockWorkerContext();
    invokeStub = jest.fn() as any;
    (ctx.claudeSession as any).invoke = invokeStub;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── Second message enqueued while session is active ───────────────

  describe('enqueue during active session', () => {
    it('enqueues a second message to the SDK queue when session is active', async () => {
      let capturedCallbacks: SessionCallbacks | undefined;

      // Make invoke hang until we manually resolve it
      const invokePromise = new Promise<ClaudeResult>((resolve) => {
        invokeStub.mockImplementationOnce(async (params: any) => {
          capturedCallbacks = params.callbacks;

          // Wait for the second message to be enqueued, then simulate turn result
          await new Promise<void>((r) => setTimeout(r, 50));

          // The onTurnResult callback should return true if pending messages exist
          const shouldContinue = capturedCallbacks!.onTurnResult({
            result: 'first turn done',
            sessionId: 'session-mt-1',
            isError: false,
            costUsd: 0.02,
            usage: {
              inputTokens: 100,
              outputTokens: 50,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              contextWindowPercent: 5,
              numTurns: 1,
            },
          });
          // After the second message was enqueued, onTurnResult should return true
          expect(shouldContinue).toBe(true);

          return {
            result: 'Final multi-turn response.',
            sessionId: 'session-mt-1',
            isError: false,
            costUsd: 0.04,
            usage: {
              inputTokens: 200,
              outputTokens: 100,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              contextWindowPercent: 10,
              numTurns: 2,
            },
          };
        });
      });

      // Start the first message (this starts the session)
      const firstPromise = ctx.workerLoop.handleMessage(makeQueueMessage('First message', 'msg-1'));

      // Give the session a moment to start and capture the input queue
      await new Promise((r) => setTimeout(r, 10));

      // Send second message while session is active
      const secondPromise = ctx.workerLoop.handleMessage(makeQueueMessage('Second message', 'msg-2'));

      // The second call should return immediately (enqueued, not starting new session)
      await secondPromise;

      // Wait for the first session to complete
      await firstPromise;

      // invoke should only be called once (single session for both messages)
      expect(invokeStub).toHaveBeenCalledTimes(1);
    });
  });

  // ── onTurnResult returns false when no pending messages ──────────

  describe('onTurnResult with no pending messages', () => {
    it('returns false from onTurnResult when no additional messages are queued', async () => {
      let turnResultReturn: boolean | undefined;

      invokeStub.mockImplementationOnce(async (params: any) => {
        const callbacks: SessionCallbacks = params.callbacks;

        // Simulate SDK consuming the first (only) message from the queue
        const iter = params.queue[Symbol.asyncIterator]();
        await iter.next();

        turnResultReturn = callbacks.onTurnResult({
          result: 'single turn',
          sessionId: 'session-single',
          isError: false,
          costUsd: 0.01,
          usage: {
            inputTokens: 50,
            outputTokens: 25,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            contextWindowPercent: 3,
            numTurns: 1,
          },
        });

        return {
          result: 'Single turn response.',
          sessionId: 'session-single',
          isError: false,
          costUsd: 0.01,
          usage: {
            inputTokens: 50,
            outputTokens: 25,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            contextWindowPercent: 3,
            numTurns: 1,
          },
        };
      });

      const msg = makeQueueMessage('Only one message');
      await ctx.workerLoop.handleMessage(msg);

      // onTurnResult always returns true (session stays alive for next message)
      expect(turnResultReturn).toBe(true);
    });
  });

  // ── Messages after session completes start new session ────────────

  describe('new session after completion', () => {
    it('starts a new session for messages received after previous session ends', async () => {
      const result1: ClaudeResult = {
        result: 'First session done.',
        sessionId: 'session-1',
        isError: false,
        costUsd: 0.02,
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          contextWindowPercent: 5,
          numTurns: 1,
        },
      };

      const result2: ClaudeResult = {
        result: 'Second session done.',
        sessionId: 'session-2',
        isError: false,
        costUsd: 0.03,
        usage: {
          inputTokens: 150,
          outputTokens: 75,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          contextWindowPercent: 7,
          numTurns: 1,
        },
      };

      invokeStub
        .mockImplementationOnce(async (params: any) => {
          if (params.callbacks?.onTurnResult) params.callbacks.onTurnResult(result1);
          return result1;
        })
        .mockImplementationOnce(async (params: any) => {
          if (params.callbacks?.onTurnResult) params.callbacks.onTurnResult(result2);
          return result2;
        });

      // First message - first session
      await ctx.workerLoop.handleMessage(makeQueueMessage('First session', 'msg-1'));
      // Wait for background session cleanup (finally block sets inputQueue=null)
      await new Promise((r) => setTimeout(r, 10));

      // Second message - should start a new session
      await ctx.workerLoop.handleMessage(makeQueueMessage('Second session', 'msg-2'));

      expect(invokeStub).toHaveBeenCalledTimes(2);

      // Second call should have the session ID from the first result (session-1)
      const secondCall = invokeStub.mock.calls[1][0];
      expect(secondCall.sessionId).toBe('session-1');
    });
  });
});
