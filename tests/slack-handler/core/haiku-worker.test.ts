// Mock dependencies before importing
import { jest } from '@jest/globals';
jest.mock('../../../packages/worker/src/claude-handler.js', () => ({
  invokeClaudeCode: jest.fn(),
  AsyncInputQueue: jest.fn(),
  interruptSession: jest.fn(),
  setQueryPermissionMode: jest.fn(),
}));

jest.mock('../../../packages/worker/src/mcp-servers/haiku-control-server.js', () => ({
  createHaikuControlServer: jest.fn(() => ({})),
}));

jest.mock('../../../packages/worker/src/mcp-servers/slack-tools-server.js', () => ({
  createSlackToolsServer: jest.fn(() => ({})),
}));

jest.mock('../../../packages/worker/src/slack-handler/core/worker.js', () => ({
  resolveBotUserId: jest.fn(() => 'U_BOT'),
}));

import { cleanupHaikuSession } from '../../../packages/worker/src/slack-handler/core/haiku-worker';
import { haikuThreadStates, HAIKU_TIMEOUT_MS } from '../../../packages/worker/src/slack-handler/types';
import type { HaikuThreadState } from '../../../packages/worker/src/slack-handler/types';

const noopLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: () => noopLogger,
} as any;

// Initialize the module logger so cleanupHaikuSession can call moduleLogger.info
import { initHaikuWorker } from '../../../packages/worker/src/slack-handler/core/haiku-worker';
beforeAll(() => {
  initHaikuWorker(noopLogger);
});

afterEach(() => {
  haikuThreadStates.clear();
  jest.clearAllMocks();
});

// ── HaikuThreadState management ──────────────────────────────────────

describe('cleanupHaikuSession', () => {
  it('removes state from the haikuThreadStates map', () => {
    const threadKey = 'C123:1234567890.000000';
    const state: HaikuThreadState = {
      processing: false,
      userId: 'U123',
      channel: 'C123',
      threadTs: '1234567890.000000',
      lastActivityAt: Date.now(),
    };
    haikuThreadStates.set(threadKey, state);
    expect(haikuThreadStates.has(threadKey)).toBe(true);

    cleanupHaikuSession(threadKey);

    expect(haikuThreadStates.has(threadKey)).toBe(false);
  });

  it('clears the timeout timer on cleanup', () => {
    const threadKey = 'C123:1234567890.000000';
    const timer = setTimeout(() => {}, 60_000);
    const clearSpy = jest.spyOn(global, 'clearTimeout');

    const state: HaikuThreadState = {
      processing: false,
      userId: 'U123',
      channel: 'C123',
      threadTs: '1234567890.000000',
      lastActivityAt: Date.now(),
      timeoutTimer: timer,
    };
    haikuThreadStates.set(threadKey, state);

    cleanupHaikuSession(threadKey);

    expect(clearSpy).toHaveBeenCalledWith(timer);
    expect(haikuThreadStates.has(threadKey)).toBe(false);

    clearSpy.mockRestore();
  });

  it('handles non-existent threadKey gracefully', () => {
    // Should not throw when the key does not exist
    expect(() => {
      cleanupHaikuSession('nonexistent:key');
    }).not.toThrow();
  });
});

// ── HAIKU_TIMEOUT_MS constant ────────────────────────────────────────

describe('HAIKU_TIMEOUT_MS', () => {
  it('should be 5 minutes (300_000 ms)', () => {
    expect(HAIKU_TIMEOUT_MS).toBe(5 * 60 * 1000);
    expect(HAIKU_TIMEOUT_MS).toBe(300_000);
  });
});

// ── Message routing regex patterns ───────────────────────────────────

describe('Message routing regex patterns', () => {
  // The regex used in events-message.ts to detect ! commands
  const haikuCommandRegex = /^!\S/;

  describe('haikuCommandRegex /^!\\S/', () => {
    it('matches !stop', () => {
      expect(haikuCommandRegex.test('!stop')).toBe(true);
    });

    it('matches !commit', () => {
      expect(haikuCommandRegex.test('!commit')).toBe(true);
    });

    it('matches !what is the status?', () => {
      expect(haikuCommandRegex.test('!what is the status?')).toBe(true);
    });

    it('does NOT match "! " (space after !)', () => {
      expect(haikuCommandRegex.test('! ')).toBe(false);
    });

    it('does NOT match "hello"', () => {
      expect(haikuCommandRegex.test('hello')).toBe(false);
    });

    it('does NOT match bare "!"', () => {
      expect(haikuCommandRegex.test('!')).toBe(false);
    });
  });

  // The regex used to detect permission replies that should bypass Haiku
  const permissionReplyRegex = /^!(yes|y|allow|approve|ok|no|n|deny|reject|always|always allow)$/i;

  describe('permissionReplyRegex', () => {
    it('matches !yes', () => {
      expect(permissionReplyRegex.test('!yes')).toBe(true);
    });

    it('matches !no', () => {
      expect(permissionReplyRegex.test('!no')).toBe(true);
    });

    it('matches !always', () => {
      expect(permissionReplyRegex.test('!always')).toBe(true);
    });

    it('matches !y (short form)', () => {
      expect(permissionReplyRegex.test('!y')).toBe(true);
    });

    it('matches !n (short form)', () => {
      expect(permissionReplyRegex.test('!n')).toBe(true);
    });

    it('matches !always allow', () => {
      expect(permissionReplyRegex.test('!always allow')).toBe(true);
    });

    it('does NOT match !stop (not a permission keyword)', () => {
      expect(permissionReplyRegex.test('!stop')).toBe(false);
    });

    it('does NOT match !commit', () => {
      expect(permissionReplyRegex.test('!commit')).toBe(false);
    });

    it('does NOT match !yes please (extra text after keyword)', () => {
      expect(permissionReplyRegex.test('!yes please')).toBe(false);
    });
  });
});
