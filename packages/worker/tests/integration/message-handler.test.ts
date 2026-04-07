// tests/integration/message-handler.test.ts — Integration test for MessageHandler routing.
// Verifies regular message routing through WorkerLoop.

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mockWorkerContext } from '../mocks/mock-context.js';
import type { WorkerContext } from '../../src/context.js';
import type { QueueMessage } from '@buddy/shared';
import type { ClaudeResult } from '../../src/types.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeQueueMessage(overrides: Partial<QueueMessage> & { payload?: Record<string, unknown> } = {}): QueueMessage {
  return {
    id: 'msg-1',
    queue: 'inbound',
    threadKey: 'C_TEST:1700000000.000000',
    status: 'pending',
    payload: { prompt: 'hello world' },
    retryCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const DEFAULT_RESULT: ClaudeResult = {
  result: 'Done.',
  sessionId: 'session-int-1',
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

// ── Tests ────────────────────────────────────────────────────────────

describe('MessageHandler routing integration', () => {
  let ctx: WorkerContext;
  let invokeStub: jest.Mock;

  beforeEach(() => {
    ctx = mockWorkerContext();
    invokeStub = jest.fn(async () => DEFAULT_RESULT) as any;
    (ctx.claudeSession as any).invoke = invokeStub;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── Regular messages → WorkerLoop ─────────────────────────────────

  describe('regular message routing', () => {
    it('routes a regular message through WorkerLoop to Claude', async () => {
      const msg = makeQueueMessage({ payload: { prompt: 'explain this code' } });
      await ctx.messageHandler.handleInbound([msg]);

      // Claude session should have been invoked
      expect(invokeStub).toHaveBeenCalledTimes(1);

      // Message should be acked
      expect(ctx.persistence.ack).toHaveBeenCalledWith('inbound', 'msg-1');
    });

    it('processes multiple messages sequentially', async () => {
      const msg1 = makeQueueMessage({ id: 'msg-1', payload: { prompt: 'first' } });
      const msg2 = makeQueueMessage({ id: 'msg-2', payload: { prompt: 'second' } });

      invokeStub
        .mockResolvedValueOnce({ ...DEFAULT_RESULT, sessionId: 'session-1' })
        .mockResolvedValueOnce({ ...DEFAULT_RESULT, sessionId: 'session-2' });

      await ctx.messageHandler.handleInbound([msg1, msg2]);

      expect(invokeStub).toHaveBeenCalledTimes(2);
      expect(ctx.persistence.ack).toHaveBeenCalledWith('inbound', 'msg-1');
      expect(ctx.persistence.ack).toHaveBeenCalledWith('inbound', 'msg-2');
    });

  });

  // ── Error handling ────────────────────────────────────────────────

  describe('error handling', () => {
    it('acks a message even when Claude errors (WorkerLoop catches internally)', async () => {
      // WorkerLoop catches SDK errors internally and posts error messages to Slack.
      // The handleMessage() method itself does NOT throw, so the message gets acked.
      invokeStub.mockRejectedValueOnce(new Error('SDK error'));

      const msg = makeQueueMessage({ id: 'sdk-err', payload: { prompt: 'will fail' } });
      await ctx.messageHandler.handleInbound([msg]);

      // WorkerLoop handles the error internally, so MessageHandler acks
      expect(ctx.persistence.ack).toHaveBeenCalledWith('inbound', 'sdk-err');
      expect(ctx.persistence.nack).not.toHaveBeenCalled();

      // Error message should be posted to Slack
      const posted = (ctx.slack as any).posted;
      const errorMsg = posted.find((p: any) => p.text.includes(':x:'));
      expect(errorMsg).toBeDefined();
    });

    it('continues processing remaining messages after a failure', async () => {
      const handleSpy = jest.spyOn(ctx.workerLoop, 'handleMessage');
      handleSpy
        .mockRejectedValueOnce(new Error('first fails'))
        .mockResolvedValueOnce(undefined);

      const msg1 = makeQueueMessage({ id: 'fail', payload: { prompt: 'first' } });
      const msg2 = makeQueueMessage({ id: 'ok', payload: { prompt: 'second' } });

      await ctx.messageHandler.handleInbound([msg1, msg2]);

      expect(ctx.persistence.nack).toHaveBeenCalledWith('inbound', 'fail');
      expect(ctx.persistence.ack).toHaveBeenCalledWith('inbound', 'ok');
    });
  });

  // ── Empty array ───────────────────────────────────────────────────

  describe('empty array', () => {
    it('does nothing for an empty message array', async () => {
      await ctx.messageHandler.handleInbound([]);

      expect(invokeStub).not.toHaveBeenCalled();
      expect(ctx.persistence.ack).not.toHaveBeenCalled();
      expect(ctx.persistence.nack).not.toHaveBeenCalled();
    });
  });
});
