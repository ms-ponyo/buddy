// tests/unit/orchestration/message-handler.test.ts
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { MessageHandler } from '../../../src/orchestration/message-handler';
import { mockLogger, type MockLogger } from '../../mocks/mock-logger';
import { mockPersistenceAdapter, type MockPersistenceAdapter } from '../../mocks/mock-persistence-adapter';
import { mockSlackAdapter, type MockSlackAdapter } from '../../mocks/mock-slack-adapter';
import type { BuddyConfig } from '../../../src/types';
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

function makeQueueMessage(overrides: Partial<QueueMessage> & { payload?: Record<string, unknown> } = {}): QueueMessage {
  return {
    id: 'msg-1',
    queue: 'inbound',
    threadKey: 'C123:1111.2222',
    status: 'pending',
    payload: { prompt: 'hello world' },
    retryCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Mocks ─────────────────────────────────────────────────────────────

interface MockWorkerLoop {
  handleMessage: jest.Mock<Promise<void>, [QueueMessage]>;
  interrupt: jest.Mock<void, []>;
}

function makeWorkerLoop(): MockWorkerLoop {
  return {
    handleMessage: jest.fn(async (_msg: QueueMessage) => {}),
    interrupt: jest.fn(),
  };
}

function makeHandler(overrides: {
  workerLoop?: any;
  persistence?: any;
  slack?: any;
} = {}): MessageHandler {
  return new MessageHandler({
    workerLoop: overrides.workerLoop ?? makeWorkerLoop() as any,
    persistence: overrides.persistence ?? mockPersistenceAdapter() as any,
    slack: overrides.slack ?? mockSlackAdapter() as any,
    config: makeConfig(),
    logger: mockLogger() as any,
    threadKey: 'C123:1111.2222',
  });
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('MessageHandler', () => {
  let logger: MockLogger;
  let persistence: MockPersistenceAdapter;
  let slack: MockSlackAdapter;
  let workerLoop: MockWorkerLoop;
  let config: BuddyConfig;
  let handler: MessageHandler;

  beforeEach(() => {
    logger = mockLogger();
    persistence = mockPersistenceAdapter();
    slack = mockSlackAdapter();
    workerLoop = makeWorkerLoop();
    config = makeConfig();

    handler = new MessageHandler({
      workerLoop: workerLoop as any,
      persistence: persistence as any,
      slack: slack as any,
      config,
      logger: logger as any,
      threadKey: 'C123:1111.2222',
    });
  });

  // ── Construction ──────────────────────────────────────────────────

  describe('constructor', () => {
    it('creates a MessageHandler without throwing', () => {
      expect(handler).toBeDefined();
    });
  });

  // ── handleInbound: empty array ────────────────────────────────────

  describe('handleInbound() — empty array', () => {
    it('does nothing when no messages provided', async () => {
      await handler.handleInbound([]);
      expect(workerLoop.handleMessage).not.toHaveBeenCalled();
    });
  });

  // ── handleInbound: regular message → WorkerLoop ───────────────────

  describe('handleInbound() — regular messages', () => {
    it('routes a regular message to WorkerLoop.handleMessage()', async () => {
      const msg = makeQueueMessage({ payload: { prompt: 'do something' } });
      await handler.handleInbound([msg]);
      expect(workerLoop.handleMessage).toHaveBeenCalledWith(msg, expect.any(Function));
    });

    it('acks the message after successful processing', async () => {
      const msg = makeQueueMessage({ id: 'msg-42', payload: { prompt: 'hello' } });
      await handler.handleInbound([msg]);
      expect(persistence.ack).toHaveBeenCalledWith('inbound', 'msg-42');
    });

    it('does not nack on success', async () => {
      const msg = makeQueueMessage();
      await handler.handleInbound([msg]);
      expect(persistence.nack).not.toHaveBeenCalled();
    });

    it('processes multiple messages in order', async () => {
      const msg1 = makeQueueMessage({ id: 'msg-1', payload: { prompt: 'first' } });
      const msg2 = makeQueueMessage({ id: 'msg-2', payload: { prompt: 'second' } });
      await handler.handleInbound([msg1, msg2]);
      expect(workerLoop.handleMessage).toHaveBeenCalledTimes(2);
      expect(workerLoop.handleMessage).toHaveBeenNthCalledWith(1, msg1, expect.any(Function));
      expect(workerLoop.handleMessage).toHaveBeenNthCalledWith(2, msg2, expect.any(Function));
    });

    it('routes any message (including those with ! prefix) to WorkerLoop', async () => {
      const msg = makeQueueMessage({ payload: { prompt: '!status' } });
      await handler.handleInbound([msg]);
      expect(workerLoop.handleMessage).toHaveBeenCalledWith(msg, expect.any(Function));
    });
  });

  // ── handleInbound: error handling — nack on failure ──────────────

  describe('handleInbound() — error handling', () => {
    it('nacks a message when WorkerLoop.handleMessage() throws', async () => {
      workerLoop.handleMessage.mockRejectedValue(new Error('processing failed'));

      const msg = makeQueueMessage({ id: 'fail-msg' });
      await handler.handleInbound([msg]);

      expect(persistence.nack).toHaveBeenCalledWith('inbound', 'fail-msg');
      expect(persistence.ack).not.toHaveBeenCalled();
    });

    it('continues processing remaining messages after a failure', async () => {
      const msg1 = makeQueueMessage({ id: 'msg-fail', payload: { prompt: 'first' } });
      const msg2 = makeQueueMessage({ id: 'msg-ok', payload: { prompt: 'second' } });

      workerLoop.handleMessage
        .mockRejectedValueOnce(new Error('first fails'))
        .mockResolvedValueOnce(undefined);

      await handler.handleInbound([msg1, msg2]);

      expect(persistence.nack).toHaveBeenCalledWith('inbound', 'msg-fail');
      expect(persistence.ack).toHaveBeenCalledWith('inbound', 'msg-ok');
    });
  });

  // ── consumeForkedHistory: checked on first message of new thread ──

  describe('consumeForkedHistory()', () => {
    it('does not throw when called on first message', async () => {
      // consumeForkedHistory is called internally; we just verify no errors
      const msg = makeQueueMessage({ payload: { prompt: 'first message in thread' } });
      await expect(handler.handleInbound([msg])).resolves.not.toThrow();
    });
  });
});
