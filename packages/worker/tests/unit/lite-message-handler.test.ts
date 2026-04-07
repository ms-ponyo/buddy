// tests/unit/lite-message-handler.test.ts
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { LiteMessageHandler } from '../../src/lite-message-handler';
import { mockLogger, type MockLogger } from '../mocks/mock-logger';
import { mockPersistenceAdapter, type MockPersistenceAdapter } from '../mocks/mock-persistence-adapter';
import { mockSlackAdapter, type MockSlackAdapter } from '../mocks/mock-slack-adapter';
import type { QueueMessage } from '@buddy/shared';

// ── Helpers ──────────────────────────────────────────────────────────

function makeQueueMessage(overrides: Partial<QueueMessage> & { payload?: Record<string, unknown> } = {}): QueueMessage {
  return {
    id: 'msg-1',
    queue: 'inbound-lite',
    threadKey: 'C123:1111.2222',
    status: 'pending',
    payload: {},
    retryCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Mock types ────────────────────────────────────────────────────────

interface MockBotCommandRouter {
  parse: jest.Mock<{ command: string; args: string } | undefined, [string]>;
  hasCommand: jest.Mock<boolean, [string]>;
  execute: jest.Mock<Promise<{ type: string; reply?: string; clearSession?: boolean }>, [{ command: string; args: string }]>;
  rewriteSlashCommand: jest.Mock<string, [string]>;
  isSDKSlashCommand: jest.Mock<boolean, [string]>;
}

interface MockDispatchHandler {
  feed: jest.Mock<Promise<void>, [string]>;
  stop: jest.Mock<Promise<void>, []>;
  running: boolean;
}

// ── Mock factories ───────────────────────────────────────────────────

function makeBotCommandRouter(): MockBotCommandRouter {
  return {
    parse: jest.fn((_text: string) => undefined),
    hasCommand: jest.fn((_name: string) => true),
    execute: jest.fn(async (_cmd: { command: string; args: string }) => ({
      type: 'handled' as const,
      reply: 'ok',
    })),
    rewriteSlashCommand: jest.fn((text: string) => text.replace(/^!/, '/')),
    isSDKSlashCommand: jest.fn((_name: string) => false),
  };
}

function makeDispatchHandler(): MockDispatchHandler {
  return {
    feed: jest.fn(async (_text: string) => {}),
    stop: jest.fn(async () => {}),
    running: false,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('LiteMessageHandler', () => {
  let logger: MockLogger;
  let persistence: MockPersistenceAdapter;
  let slack: MockSlackAdapter;
  let botCommandRouter: MockBotCommandRouter;
  let dispatchHandler: MockDispatchHandler;
  let onShutdown: jest.Mock<void, []>;
  let handler: LiteMessageHandler;

  beforeEach(() => {
    logger = mockLogger();
    persistence = mockPersistenceAdapter();
    slack = mockSlackAdapter();
    botCommandRouter = makeBotCommandRouter();
    dispatchHandler = makeDispatchHandler();
    onShutdown = jest.fn(() => {});

    handler = new LiteMessageHandler({
      botCommandRouter: botCommandRouter as any,
      dispatchHandler: dispatchHandler as any,
      persistence: persistence as any,
      slack: slack as any,
      config: { adminUserIds: [], allowedUserIds: [], allowedChannelIds: [] } as any,
      logger: logger as any,
      channel: 'C123',
      threadTs: '1111.2222',
      onShutdown,
    });
  });

  // ── Construction ──────────────────────────────────────────────────

  describe('constructor', () => {
    it('creates a LiteMessageHandler without throwing', () => {
      expect(handler).toBeDefined();
    });
  });

  // ── handleInbound: empty array ────────────────────────────────────

  describe('handleInbound() — empty array', () => {
    it('does nothing when no messages provided', async () => {
      await handler.handleInbound([]);
      expect(botCommandRouter.parse).not.toHaveBeenCalled();
      expect(dispatchHandler.feed).not.toHaveBeenCalled();
      expect(onShutdown).not.toHaveBeenCalled();
    });
  });

  // ── haiku_done action → onShutdown ─────────────────────────────────

  describe('handleInbound() — haiku_done action', () => {
    it('calls onShutdown when action is haiku_done', async () => {
      const msg = makeQueueMessage({ payload: { action: 'haiku_done' } });
      await handler.handleInbound([msg]);
      expect(onShutdown).toHaveBeenCalledTimes(1);
    });

    it('acks the message after haiku_done', async () => {
      const msg = makeQueueMessage({ id: 'done-msg', payload: { action: 'haiku_done' } });
      await handler.handleInbound([msg]);
      expect(persistence.ack).toHaveBeenCalledWith('inbound-lite', 'done-msg');
    });

    it('does not feed to DispatchHandler on haiku_done', async () => {
      const msg = makeQueueMessage({ payload: { action: 'haiku_done' } });
      await handler.handleInbound([msg]);
      expect(dispatchHandler.feed).not.toHaveBeenCalled();
    });
  });

  // ── Dispatch input box text → DispatchHandler ──────────────────────

  describe('handleInbound() — dispatch input box text', () => {
    it('feeds text to DispatchHandler when payload has text field', async () => {
      const msg = makeQueueMessage({ payload: { text: 'user typed this' } });
      await handler.handleInbound([msg]);
      expect(dispatchHandler.feed).toHaveBeenCalledWith('user typed this');
    });

    it('acks the message after feeding text', async () => {
      const msg = makeQueueMessage({ id: 'text-msg', payload: { text: 'hello' } });
      await handler.handleInbound([msg]);
      expect(persistence.ack).toHaveBeenCalledWith('inbound-lite', 'text-msg');
    });

    it('does not invoke botCommandRouter for text', async () => {
      const msg = makeQueueMessage({ payload: { text: '!status' } });
      await handler.handleInbound([msg]);
      expect(botCommandRouter.parse).not.toHaveBeenCalled();
    });
  });

  // ── Bot commands (prompt starting with !) → BotCommandRouter ───────

  describe('handleInbound() — bot commands', () => {
    it('routes a recognized !command to BotCommandRouter', async () => {
      botCommandRouter.parse.mockReturnValue({ command: 'status', args: '' });
      botCommandRouter.execute.mockResolvedValue({ type: 'handled', reply: 'Status: idle' });

      const msg = makeQueueMessage({ payload: { prompt: '!status' } });
      await handler.handleInbound([msg]);

      expect(botCommandRouter.parse).toHaveBeenCalledWith('!status');
      expect(botCommandRouter.execute).toHaveBeenCalledWith({ command: 'status', args: '' });
    });

    it('posts reply to Slack when command is handled', async () => {
      botCommandRouter.parse.mockReturnValue({ command: 'status', args: '' });
      botCommandRouter.execute.mockResolvedValue({ type: 'handled', reply: 'Status: idle' });

      const msg = makeQueueMessage({ payload: { prompt: '!status' } });
      await handler.handleInbound([msg]);

      expect(slack.postMessage).toHaveBeenCalledWith(
        'C123',
        '1111.2222',
        'Status: idle',
        expect.any(Array),
      );
    });

    it('does not feed to DispatchHandler when command is handled', async () => {
      botCommandRouter.parse.mockReturnValue({ command: 'status', args: '' });
      botCommandRouter.execute.mockResolvedValue({ type: 'handled', reply: 'ok' });

      const msg = makeQueueMessage({ payload: { prompt: '!status' } });
      await handler.handleInbound([msg]);

      expect(dispatchHandler.feed).not.toHaveBeenCalled();
    });

    it('feeds to DispatchHandler when command result is dispatch', async () => {
      botCommandRouter.parse.mockReturnValue({ command: 'help', args: '' });
      botCommandRouter.execute.mockResolvedValue({ type: 'dispatch', reply: 'Here are the commands...' });

      const msg = makeQueueMessage({ payload: { prompt: '!help' } });
      await handler.handleInbound([msg]);

      expect(dispatchHandler.feed).toHaveBeenCalledWith('Here are the commands...');
    });

    it('falls back to prompt when dispatch result has no reply', async () => {
      botCommandRouter.parse.mockReturnValue({ command: 'help', args: '' });
      botCommandRouter.execute.mockResolvedValue({ type: 'dispatch' });

      const msg = makeQueueMessage({ payload: { prompt: '!help' } });
      await handler.handleInbound([msg]);

      expect(dispatchHandler.feed).toHaveBeenCalledWith('!help');
    });

    it('feeds command + error to DispatchHandler when execute throws', async () => {
      botCommandRouter.parse.mockReturnValue({ command: 'status', args: '' });
      botCommandRouter.execute.mockRejectedValue(new Error('connection error'));

      const msg = makeQueueMessage({ payload: { prompt: '!status' } });
      await handler.handleInbound([msg]);

      expect(dispatchHandler.feed).toHaveBeenCalledWith(
        expect.stringContaining('connection error'),
      );
    });

    it('acks the message after successful bot command', async () => {
      botCommandRouter.parse.mockReturnValue({ command: 'status', args: '' });
      botCommandRouter.execute.mockResolvedValue({ type: 'handled', reply: 'ok' });

      const msg = makeQueueMessage({ id: 'cmd-msg', payload: { prompt: '!status' } });
      await handler.handleInbound([msg]);

      expect(persistence.ack).toHaveBeenCalledWith('inbound-lite', 'cmd-msg');
    });
  });

  // ── Non-command prompts → DispatchHandler ──────────────────────────

  describe('handleInbound() — non-command prompts (needs LLM)', () => {
    it('feeds non-command prompt to DispatchHandler', async () => {
      botCommandRouter.parse.mockReturnValue(undefined);

      const msg = makeQueueMessage({ payload: { prompt: 'what model am I using?' } });
      await handler.handleInbound([msg]);

      expect(dispatchHandler.feed).toHaveBeenCalledWith('what model am I using?');
    });

    it('acks the message after feeding to dispatch', async () => {
      botCommandRouter.parse.mockReturnValue(undefined);

      const msg = makeQueueMessage({ id: 'llm-msg', payload: { prompt: 'hello' } });
      await handler.handleInbound([msg]);

      expect(persistence.ack).toHaveBeenCalledWith('inbound-lite', 'llm-msg');
    });
  });

  // ── Error handling ─────────────────────────────────────────────────

  describe('handleInbound() — error handling', () => {
    it('nacks a message when DispatchHandler.feed() throws', async () => {
      botCommandRouter.parse.mockReturnValue(undefined);
      dispatchHandler.feed.mockRejectedValue(new Error('feed failed'));

      const msg = makeQueueMessage({ id: 'fail-msg', payload: { prompt: 'test' } });
      await handler.handleInbound([msg]);

      expect(persistence.nack).toHaveBeenCalledWith('inbound-lite', 'fail-msg');
      expect(persistence.ack).not.toHaveBeenCalled();
    });

    it('continues processing remaining messages after a failure', async () => {
      botCommandRouter.parse.mockReturnValue(undefined);
      dispatchHandler.feed
        .mockRejectedValueOnce(new Error('first fails'))
        .mockResolvedValueOnce(undefined);

      const msg1 = makeQueueMessage({ id: 'msg-fail', payload: { prompt: 'first' } });
      const msg2 = makeQueueMessage({ id: 'msg-ok', payload: { prompt: 'second' } });
      await handler.handleInbound([msg1, msg2]);

      expect(persistence.nack).toHaveBeenCalledWith('inbound-lite', 'msg-fail');
      expect(persistence.ack).toHaveBeenCalledWith('inbound-lite', 'msg-ok');
    });
  });

  // ── Priority: text field takes precedence over prompt ──────────────

  describe('routing priority', () => {
    it('text field takes precedence over prompt (dispatch input box)', async () => {
      const msg = makeQueueMessage({
        payload: { text: 'typed text', prompt: '!status' },
      });
      await handler.handleInbound([msg]);

      // Should route to dispatch via text, not bot command router
      expect(dispatchHandler.feed).toHaveBeenCalledWith('typed text');
      expect(botCommandRouter.parse).not.toHaveBeenCalled();
    });

    it('action takes precedence over text', async () => {
      const msg = makeQueueMessage({
        payload: { action: 'haiku_done', text: 'some text' },
      });
      await handler.handleInbound([msg]);

      expect(onShutdown).toHaveBeenCalled();
      expect(dispatchHandler.feed).not.toHaveBeenCalled();
    });
  });

  // ── Empty payload ──────────────────────────────────────────────────

  describe('handleInbound() — empty payload', () => {
    it('ignores a message with no actionable payload', async () => {
      const msg = makeQueueMessage({ payload: {} });
      await handler.handleInbound([msg]);

      expect(onShutdown).not.toHaveBeenCalled();
      expect(botCommandRouter.parse).not.toHaveBeenCalled();
      expect(dispatchHandler.feed).not.toHaveBeenCalled();
      // Should still ack the message
      expect(persistence.ack).toHaveBeenCalledWith('inbound-lite', 'msg-1');
    });
  });
});
