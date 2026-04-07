// tests/unit/adapters/slack-adapter.test.ts
import { jest } from '@jest/globals';
import { SlackAdapter } from '../../../src/adapters/slack-adapter.js';

describe('SlackAdapter', () => {
  let adapter: SlackAdapter;
  let mockGatewayClient: { call: jest.Mock; notify: jest.Mock; connect: jest.Mock; close: jest.Mock; isConnected: boolean };
  let mockPersistenceClient: { call: jest.Mock; notify: jest.Mock; connect: jest.Mock; close: jest.Mock; isConnected: boolean };

  beforeEach(() => {
    mockGatewayClient = {
      call: jest.fn<() => Promise<unknown>>(),
      notify: jest.fn(),
      connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      isConnected: true,
    };
    mockPersistenceClient = {
      call: jest.fn<() => Promise<unknown>>(),
      notify: jest.fn(),
      connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      isConnected: true,
    };
    adapter = new SlackAdapter(mockGatewayClient as any, mockPersistenceClient as any, 'C123:ts');
  });

  // ── postMessage (persistence outbound queue) ─────────────────────

  it('postMessage enqueues to persistence outbound queue', async () => {
    mockPersistenceClient.call.mockResolvedValue({ id: 'q1' });
    const result = await adapter.postMessage('C123', 'ts', 'hello');
    expect(mockPersistenceClient.call).toHaveBeenCalledWith('queue.enqueue', {
      queue: 'outbound',
      threadKey: 'C123:ts',
      message: { type: 'postMessage', channel: 'C123', thread_ts: 'ts', text: 'hello', blocks: undefined },
    });
    expect(result).toEqual({ ts: '' });
  });

  it('postMessage passes blocks when provided', async () => {
    mockPersistenceClient.call.mockResolvedValue({ id: 'q2' });
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: 'hi' } }];
    await adapter.postMessage('C123', 'ts', 'hello', blocks);
    expect(mockPersistenceClient.call).toHaveBeenCalledWith('queue.enqueue', {
      queue: 'outbound',
      threadKey: 'C123:ts',
      message: { type: 'postMessage', channel: 'C123', thread_ts: 'ts', text: 'hello', blocks },
    });
  });

  // ── uploadFile (persistence outbound queue) ──────────────────────

  it('uploadFile enqueues to persistence outbound queue', async () => {
    mockPersistenceClient.call.mockResolvedValue({ id: 'q3' });
    const result = await adapter.uploadFile('C123', 'ts', 'file.txt', '/tmp/file.txt', 'a caption');
    expect(mockPersistenceClient.call).toHaveBeenCalledWith('queue.enqueue', {
      queue: 'outbound',
      threadKey: 'C123:ts',
      message: {
        type: 'fileUpload',
        channel_id: 'C123',
        thread_ts: 'ts',
        filename: 'file.txt',
        file_path: '/tmp/file.txt',
        initial_comment: 'a caption',
      },
    });
    expect(result).toEqual({ fileId: '' });
  });

  it('uploadFile omits initial_comment when caption is not provided', async () => {
    mockPersistenceClient.call.mockResolvedValue({ id: 'q4' });
    await adapter.uploadFile('C123', 'ts', 'file.txt', '/tmp/file.txt');
    const enqueueArgs = mockPersistenceClient.call.mock.calls[0][1] as Record<string, unknown>;
    const message = enqueueArgs.message as Record<string, unknown>;
    expect(message.initial_comment).toBeUndefined();
  });

  // ── updateMessage (direct gateway) ───────────────────────────────

  it('updateMessage calls gateway directly', async () => {
    mockGatewayClient.call.mockResolvedValue({ result: {} });
    await adapter.updateMessage('C123', 'ts', 'updated');
    expect(mockGatewayClient.call).toHaveBeenCalledWith('slack.apiCall', {
      method: 'chat.update',
      args: { channel: 'C123', ts: 'ts', text: 'updated', blocks: undefined },
    });
  });

  // ── addReaction (direct gateway) ─────────────────────────────────

  it('addReaction calls gateway directly', async () => {
    mockGatewayClient.call.mockResolvedValue({ result: {} });
    await adapter.addReaction('C123', 'ts', 'thumbsup');
    expect(mockGatewayClient.call).toHaveBeenCalledWith('slack.apiCall', {
      method: 'reactions.add',
      args: { channel: 'C123', timestamp: 'ts', name: 'thumbsup' },
    });
  });

  // ── removeReaction (direct gateway) ──────────────────────────────

  it('removeReaction calls gateway directly', async () => {
    mockGatewayClient.call.mockResolvedValue({ result: {} });
    await adapter.removeReaction('C123', 'ts', 'thumbsup');
    expect(mockGatewayClient.call).toHaveBeenCalledWith('slack.apiCall', {
      method: 'reactions.remove',
      args: { channel: 'C123', timestamp: 'ts', name: 'thumbsup' },
    });
  });

  // ── postEphemeral (direct gateway) ───────────────────────────────

  it('postEphemeral calls gateway directly', async () => {
    mockGatewayClient.call.mockResolvedValue({ result: {} });
    await adapter.postEphemeral('C123', 'ts', 'U456', 'secret');
    expect(mockGatewayClient.call).toHaveBeenCalledWith('slack.apiCall', {
      method: 'chat.postEphemeral',
      args: { channel: 'C123', thread_ts: 'ts', user: 'U456', text: 'secret', blocks: undefined },
    });
  });

  // ── setTypingStatus (direct gateway) ─────────────────────────────

  it('setTypingStatus calls gateway directly', async () => {
    mockGatewayClient.call.mockResolvedValue({ result: {} });
    await adapter.setTypingStatus('C123', 'ts', 'Thinking...');
    expect(mockGatewayClient.call).toHaveBeenCalledWith('slack.apiCall', {
      method: 'assistant.threads.setStatus',
      args: { channel_id: 'C123', thread_ts: 'ts', status: 'Thinking...' },
    });
  });

  // ── openView (direct gateway) ────────────────────────────────────

  it('openView calls gateway and returns viewId', async () => {
    mockGatewayClient.call.mockResolvedValue({ result: { view: { id: 'V123' } } });
    const result = await adapter.openView('T123', { type: 'modal' });
    expect(mockGatewayClient.call).toHaveBeenCalledWith('slack.apiCall', {
      method: 'views.open',
      args: { trigger_id: 'T123', view: { type: 'modal' } },
    });
    expect(result).toEqual({ viewId: 'V123' });
  });

  it('openView returns empty viewId when result has no view', async () => {
    mockGatewayClient.call.mockResolvedValue({ result: {} });
    const result = await adapter.openView('T123', { type: 'modal' });
    expect(result).toEqual({ viewId: '' });
  });

  // ── updateView (direct gateway) ──────────────────────────────────

  it('updateView calls gateway directly', async () => {
    mockGatewayClient.call.mockResolvedValue({ result: {} });
    await adapter.updateView('V123', { type: 'modal', title: { type: 'plain_text', text: 'Updated' } });
    expect(mockGatewayClient.call).toHaveBeenCalledWith('slack.apiCall', {
      method: 'views.update',
      args: { view_id: 'V123', view: { type: 'modal', title: { type: 'plain_text', text: 'Updated' } } },
    });
  });

  // ── apiCall (direct gateway) ─────────────────────────────────────

  it('apiCall calls gateway and returns result', async () => {
    mockGatewayClient.call.mockResolvedValue({ result: { ok: true, channels: [] } });
    const result = await adapter.apiCall('conversations.list', { limit: 10 });
    expect(mockGatewayClient.call).toHaveBeenCalledWith('slack.apiCall', {
      method: 'conversations.list',
      args: { limit: 10 },
    });
    expect(result).toEqual({ ok: true, channels: [] });
  });

  // ── sendInteractivePrompt (persistence outbound queue) ───────────

  it('sendInteractivePrompt enqueues to persistence outbound queue', async () => {
    mockPersistenceClient.call.mockResolvedValue({ id: 'q5' });
    const display = { tool: 'bash', command: 'ls' };
    await adapter.sendInteractivePrompt('cb1', 'permission', display);
    expect(mockPersistenceClient.call).toHaveBeenCalledWith('queue.enqueue', {
      queue: 'outbound',
      threadKey: 'C123:ts',
      message: { type: 'interactivePrompt', callbackId: 'cb1', promptType: 'permission', display },
    });
  });

  // ── conversationsReplies (direct gateway) ────────────────────────

  it('conversationsReplies calls gateway and returns result', async () => {
    const mockResult = { messages: [{ ts: '1', text: 'hi' }] };
    mockGatewayClient.call.mockResolvedValue({ result: mockResult });
    const result = await adapter.conversationsReplies({ channel: 'C123', ts: '1' });
    expect(mockGatewayClient.call).toHaveBeenCalledWith('slack.apiCall', {
      method: 'conversations.replies',
      args: { channel: 'C123', ts: '1' },
    });
    expect(result).toEqual(mockResult);
  });

  // ── conversationsHistory (direct gateway) ────────────────────────

  it('conversationsHistory calls gateway and returns result', async () => {
    const mockResult = { messages: [{ ts: '1', text: 'hi' }] };
    mockGatewayClient.call.mockResolvedValue({ result: mockResult });
    const result = await adapter.conversationsHistory({ channel: 'C123', limit: 10 });
    expect(mockGatewayClient.call).toHaveBeenCalledWith('slack.apiCall', {
      method: 'conversations.history',
      args: { channel: 'C123', limit: 10 },
    });
    expect(result).toEqual(mockResult);
  });

  // ── filesInfo (direct gateway) ───────────────────────────────────

  it('filesInfo calls gateway and returns result', async () => {
    const mockResult = { file: { name: 'test.txt', size: 100 } };
    mockGatewayClient.call.mockResolvedValue({ result: mockResult });
    const result = await adapter.filesInfo({ file: 'F123' });
    expect(mockGatewayClient.call).toHaveBeenCalledWith('slack.apiCall', {
      method: 'files.info',
      args: { file: 'F123' },
    });
    expect(result).toEqual(mockResult);
  });

  // ── enqueueOutbound (persistence outbound queue) ─────────────────

  it('enqueueOutbound enqueues a stream message to persistence outbound queue', async () => {
    mockPersistenceClient.call.mockResolvedValue({ id: 'q-stream' });
    await adapter.enqueueOutbound({ type: 'stream_start', channel: 'C123', threadTs: 'ts' });
    expect(mockPersistenceClient.call).toHaveBeenCalledWith('queue.enqueue', {
      queue: 'outbound',
      threadKey: 'C123:ts',
      message: { type: 'stream_start', channel: 'C123', threadTs: 'ts' },
    });
  });

  // ── connectGateway ───────────────────────────────────────────────

  it('connectGateway delegates to gatewayClient.connect()', async () => {
    await adapter.connectGateway();
    expect(mockGatewayClient.connect).toHaveBeenCalledTimes(1);
  });

  // ── deregisterFromGateway ────────────────────────────────────────

  it('deregisterFromGateway calls worker.deregister on gateway', async () => {
    mockGatewayClient.call.mockResolvedValue({});
    await adapter.deregisterFromGateway();
    expect(mockGatewayClient.call).toHaveBeenCalledWith('worker.deregister', {});
  });

  // ── close ────────────────────────────────────────────────────────

  it('close closes both gateway and persistence clients', async () => {
    await adapter.close();
    expect(mockGatewayClient.close).toHaveBeenCalledTimes(1);
    expect(mockPersistenceClient.close).toHaveBeenCalledTimes(1);
  });

  // ── isGatewayConnected ───────────────────────────────────────────

  it('isGatewayConnected delegates to client', () => {
    expect(adapter.isGatewayConnected()).toBe(true);
    mockGatewayClient.isConnected = false;
    expect(adapter.isGatewayConnected()).toBe(false);
  });

  // ── isPersistenceConnected ───────────────────────────────────────

  it('isPersistenceConnected delegates to client', () => {
    expect(adapter.isPersistenceConnected()).toBe(true);
    mockPersistenceClient.isConnected = false;
    expect(adapter.isPersistenceConnected()).toBe(false);
  });

  // ── postMessageDirect (direct gateway call, returns real ts) ─────────

  it('postMessageDirect calls slack.apiCall via gateway and returns ts', async () => {
    mockGatewayClient.call.mockResolvedValue({ result: { ts: '1234.5678' } });
    const result = await adapter.postMessageDirect('C123', 'ts', 'hello');
    expect(mockGatewayClient.call).toHaveBeenCalledWith('slack.apiCall', {
      method: 'chat.postMessage',
      args: { channel: 'C123', thread_ts: 'ts', text: 'hello', blocks: undefined },
    });
    expect(result).toEqual({ ts: '1234.5678' });
  });

  it('postMessageDirect passes blocks when provided', async () => {
    const blocks = [{ type: 'section' }];
    mockGatewayClient.call.mockResolvedValue({ result: { ts: 'abc' } });
    const result = await adapter.postMessageDirect('C123', 'ts', 'hi', blocks);
    expect(mockGatewayClient.call).toHaveBeenCalledWith('slack.apiCall', {
      method: 'chat.postMessage',
      args: { channel: 'C123', thread_ts: 'ts', text: 'hi', blocks },
    });
    expect(result).toEqual({ ts: 'abc' });
  });

  // ── queueUpdateMessage (persistence outbound queue) ───────────────────

  it('queueUpdateMessage enqueues updateMessage to persistence outbound queue', async () => {
    mockPersistenceClient.call.mockResolvedValue({ id: 'q10' });
    await adapter.queueUpdateMessage('C123', '1234.0', 'new text');
    expect(mockPersistenceClient.call).toHaveBeenCalledWith('queue.enqueue', {
      queue: 'outbound',
      threadKey: 'C123:ts',
      message: { type: 'updateMessage', channel: 'C123', ts: '1234.0', text: 'new text', blocks: undefined },
    });
  });

  it('queueUpdateMessage passes blocks when provided', async () => {
    const blocks = [{ type: 'section' }];
    mockPersistenceClient.call.mockResolvedValue({ id: 'q11' });
    await adapter.queueUpdateMessage('C123', '1234.0', 'text', blocks);
    expect(mockPersistenceClient.call).toHaveBeenCalledWith('queue.enqueue', {
      queue: 'outbound',
      threadKey: 'C123:ts',
      message: { type: 'updateMessage', channel: 'C123', ts: '1234.0', text: 'text', blocks },
    });
  });

  // ── queueDeleteMessage (persistence outbound queue) ───────────────────

  it('queueDeleteMessage enqueues deleteMessage to persistence outbound queue', async () => {
    mockPersistenceClient.call.mockResolvedValue({ id: 'q12' });
    await adapter.queueDeleteMessage('C123', '1234.0');
    expect(mockPersistenceClient.call).toHaveBeenCalledWith('queue.enqueue', {
      queue: 'outbound',
      threadKey: 'C123:ts',
      message: { type: 'deleteMessage', channel: 'C123', ts: '1234.0' },
    });
  });
});
