import { jest } from '@jest/globals';
import { fetchAndFormatThreadHistory, consumeForkedHistory, saveForkedHistory, getThreadPermalink } from '../../../src/util/thread-history';
import type { ThreadHistorySlack } from '../../../src/util/thread-history';
import { mockLogger } from '../../mocks/mock-logger';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

describe('fetchAndFormatThreadHistory', () => {
  it('returns null when no messages', async () => {
    const slack: ThreadHistorySlack = {
      conversationsReplies: jest.fn<any>().mockResolvedValue({ messages: [] }),
    };
    const result = await fetchAndFormatThreadHistory(slack, 'C123', '1234.5678', mockLogger());
    expect(result).toBeNull();
  });

  it('fetches and formats messages', async () => {
    const slack: ThreadHistorySlack = {
      conversationsReplies: jest.fn<any>().mockResolvedValue({
        messages: [
          { user: 'U1', text: 'hello', ts: '1234.0001' },
          { bot_id: 'B1', text: 'hi there', ts: '1234.0002' },
        ],
      }),
    };
    const log = mockLogger();
    const result = await fetchAndFormatThreadHistory(slack, 'C123', '1234.5678', log);
    expect(result).not.toBeNull();
    expect(result!.messageCount).toBe(2);
    expect(result!.formatted).toContain('<@U1>');
    expect(result!.formatted).toContain('[assistant]');
    expect(result!.formatted).toContain('hello');
    expect(result!.formatted).toContain('hi there');
    expect(log.calls.info.length).toBeGreaterThan(0);
  });

  it('paginates through cursor', async () => {
    const slack: ThreadHistorySlack = {
      conversationsReplies: jest.fn<any>()
        .mockResolvedValueOnce({
          messages: [{ user: 'U1', text: 'page1', ts: '1234.0001' }],
          response_metadata: { next_cursor: 'cursor1' },
        })
        .mockResolvedValueOnce({
          messages: [{ user: 'U2', text: 'page2', ts: '1234.0002' }],
        }),
    };
    const result = await fetchAndFormatThreadHistory(slack, 'C123', '1234.5678', mockLogger());
    expect(result!.messageCount).toBe(2);
    expect(slack.conversationsReplies).toHaveBeenCalledTimes(2);
  });

  it('truncates long messages', async () => {
    const longText = 'x'.repeat(3000);
    const slack: ThreadHistorySlack = {
      conversationsReplies: jest.fn<any>().mockResolvedValue({
        messages: [{ user: 'U1', text: longText, ts: '1234.0001' }],
      }),
    };
    const result = await fetchAndFormatThreadHistory(slack, 'C123', '1234.5678', mockLogger());
    expect(result!.formatted).toContain('truncated');
    expect(result!.formatted.length).toBeLessThan(longText.length + 500);
  });
});

describe('consumeForkedHistory', () => {
  const historyDir = join(process.cwd(), 'data', 'thread-history');

  beforeEach(() => {
    mkdirSync(historyDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(historyDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('returns null when no fork file exists', () => {
    const result = consumeForkedHistory('C999', '9999.9999');
    expect(result).toBeNull();
  });

  it('reads fork file without metadata', () => {
    const filePath = join(historyDir, 'fork_C123_1234.5678.txt');
    writeFileSync(filePath, 'thread history content');
    const result = consumeForkedHistory('C123', '1234.5678');
    expect(result).not.toBeNull();
    expect(result!.content).toBe('thread history content');
    expect(result!.logPaths).toBeUndefined();
  });

  it('reads fork file with metadata', () => {
    const meta = { mainLog: '/tmp/main.log', sessionLog: '/tmp/session.log' };
    const content = 'history\n---FORK_META---\n' + JSON.stringify(meta);
    const filePath = join(historyDir, 'fork_C456_5678.1234.txt');
    writeFileSync(filePath, content);
    const result = consumeForkedHistory('C456', '5678.1234');
    expect(result).not.toBeNull();
    expect(result!.content).toBe('history');
    expect(result!.logPaths).toEqual(meta);
  });
});

describe('saveForkedHistory', () => {
  const historyDir = join(process.cwd(), 'data', 'thread-history');

  afterEach(() => {
    try {
      rmSync(historyDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('saves and can be consumed', () => {
    const path = saveForkedHistory('C123', '1234.5678', 'history text', { execLog: '/tmp/exec.log' });
    expect(path).toContain('fork_C123_1234.5678.txt');
    const result = consumeForkedHistory('C123', '1234.5678');
    expect(result!.content).toBe('history text');
    expect(result!.logPaths!.execLog).toBe('/tmp/exec.log');
  });
});

describe('getThreadPermalink', () => {
  it('returns permalink on success', async () => {
    const slack = {
      apiCall: jest.fn<any>().mockResolvedValue({ permalink: 'https://slack.com/link' }),
    };
    const result = await getThreadPermalink(slack, 'C123', '1234.5678');
    expect(result).toBe('https://slack.com/link');
    expect(slack.apiCall).toHaveBeenCalledWith('chat.getPermalink', {
      channel: 'C123',
      message_ts: '1234.5678',
    });
  });

  it('returns null on error', async () => {
    const slack = {
      apiCall: jest.fn<any>().mockRejectedValue(new Error('api error')),
    };
    const result = await getThreadPermalink(slack, 'C123', '1234.5678');
    expect(result).toBeNull();
  });

  it('returns null when permalink missing', async () => {
    const slack = {
      apiCall: jest.fn<any>().mockResolvedValue({}),
    };
    const result = await getThreadPermalink(slack, 'C123', '1234.5678');
    expect(result).toBeNull();
  });
});
