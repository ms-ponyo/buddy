// tests/unit/services/interactive-bridge.test.ts
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { InteractiveBridge } from '../../../src/services/interactive-bridge';
import { mockSlackAdapter, type MockSlackAdapter } from '../../mocks/mock-slack-adapter';
import { mockLogger, type MockLogger } from '../../mocks/mock-logger';

describe('InteractiveBridge', () => {
  let slack: MockSlackAdapter;
  let logger: MockLogger;
  let bridge: InteractiveBridge;

  beforeEach(() => {
    jest.useFakeTimers();
    slack = mockSlackAdapter();
    logger = mockLogger();
    bridge = new InteractiveBridge({
      slack: slack as any,
      logger: logger as any,
    });
  });

  afterEach(() => {
    bridge.cleanup();
    jest.useRealTimers();
  });

  // ── isInteractiveCommand ──────────────────────────────────────────

  describe('isInteractiveCommand()', () => {
    it('returns true for a command matching a simple pattern', () => {
      const patterns = ['ssh', 'telnet'];
      expect(bridge.isInteractiveCommand('ssh user@host', patterns)).toBe(true);
    });

    it('returns true for a command matching a base command pattern', () => {
      const patterns = ['gh auth login', 'npm login'];
      expect(bridge.isInteractiveCommand('gh auth login', patterns)).toBe(true);
    });

    it('returns false for a command not matching any pattern', () => {
      const patterns = ['ssh', 'telnet'];
      expect(bridge.isInteractiveCommand('ls -la', patterns)).toBe(false);
    });

    it('returns false for empty patterns list', () => {
      expect(bridge.isInteractiveCommand('ssh user@host', [])).toBe(false);
    });

    it('matches commands with full path prefix', () => {
      const patterns = ['python'];
      expect(bridge.isInteractiveCommand('/usr/bin/python', patterns)).toBe(true);
    });

    it('matches commands in pipe chains', () => {
      const patterns = ['ssh'];
      expect(bridge.isInteractiveCommand('echo hello && ssh user@host', patterns)).toBe(true);
    });

    it('handles env var prefixes', () => {
      const patterns = ['node'];
      expect(bridge.isInteractiveCommand('NODE_ENV=production node', patterns)).toBe(true);
    });

    it('returns false when a subcommand does not match', () => {
      const patterns = ['gh auth login'];
      // "gh pr list" should not match "gh auth login"
      expect(bridge.isInteractiveCommand('gh pr list', patterns)).toBe(false);
    });
  });

  // ── startSession ──────────────────────────────────────────────────

  describe('startSession()', () => {
    it('creates a pending interactive session and returns a promise', () => {
      const promise = bridge.startSession('tool-1', 'ssh user@host', 'C123', '1111.2222');

      expect(promise).toBeInstanceOf(Promise);
      expect(bridge.hasPending).toBe(true);
    });

    it('posts an interactive header message to Slack', () => {
      bridge.startSession('tool-1', 'ssh user@host', 'C123', '1111.2222');

      // Should have called postMessage with interactive blocks
      expect(slack.postMessage).toHaveBeenCalled();
      const call = slack.postMessage.mock.calls[0];
      expect(call[0]).toBe('C123');     // channel
      expect(call[1]).toBe('1111.2222'); // threadTs
    });

    it('supersedes a previous pending session', async () => {
      const promise1 = bridge.startSession('tool-1', 'ssh user1@host', 'C123', '1111.2222');
      const promise2 = bridge.startSession('tool-2', 'ssh user2@host', 'C123', '1111.2222');

      // First session should be cancelled
      const result1 = await promise1;
      expect(result1.handled).toBe(true);
      expect(result1.error).toBeDefined();

      // Second session is now the active one
      expect(bridge.hasPending).toBe(true);

      // Resolve second to prevent dangling promise
      bridge.resolveInteraction('tool-2', { action: 'cancel' });
    });
  });

  // ── resolveInteraction ────────────────────────────────────────────

  describe('resolveInteraction()', () => {
    it('returns true and resolves the pending session for matching callbackId', async () => {
      const promise = bridge.startSession('tool-1', 'echo test', 'C123', '1111.2222');

      const resolved = bridge.resolveInteraction('tool-1', { action: 'cancel' });
      expect(resolved).toBe(true);

      const result = await promise;
      expect(result.handled).toBe(true);
      expect(bridge.hasPending).toBe(false);
    });

    it('returns false for non-matching callbackId', () => {
      bridge.startSession('tool-1', 'echo test', 'C123', '1111.2222');

      const resolved = bridge.resolveInteraction('does-not-exist', { action: 'cancel' });
      expect(resolved).toBe(false);
      expect(bridge.hasPending).toBe(true);

      // Clean up
      bridge.resolveInteraction('tool-1', { action: 'cancel' });
    });

    it('returns false when called twice with the same callbackId', () => {
      bridge.startSession('tool-1', 'echo test', 'C123', '1111.2222');

      expect(bridge.resolveInteraction('tool-1', { action: 'cancel' })).toBe(true);
      expect(bridge.resolveInteraction('tool-1', { action: 'cancel' })).toBe(false);
    });

    it('resolves with text input payload', async () => {
      const promise = bridge.startSession('tool-1', 'ssh user@host', 'C123', '1111.2222');

      bridge.resolveInteraction('tool-1', { action: 'text', text: 'yes' });

      const result = await promise;
      expect(result.handled).toBe(true);
      expect(result.output).toContain('yes');
    });

    it('resolves with cancel action', async () => {
      const promise = bridge.startSession('tool-1', 'ssh user@host', 'C123', '1111.2222');

      bridge.resolveInteraction('tool-1', { action: 'cancel' });

      const result = await promise;
      expect(result.handled).toBe(true);
    });
  });

  // ── hasPending ────────────────────────────────────────────────────

  describe('hasPending', () => {
    it('returns false when no session is active', () => {
      expect(bridge.hasPending).toBe(false);
    });

    it('returns true when a session is active', () => {
      bridge.startSession('tool-1', 'ssh user@host', 'C123', '1111.2222');
      expect(bridge.hasPending).toBe(true);
    });

    it('returns false after session is resolved', () => {
      bridge.startSession('tool-1', 'ssh user@host', 'C123', '1111.2222');
      bridge.resolveInteraction('tool-1', { action: 'cancel' });
      expect(bridge.hasPending).toBe(false);
    });
  });

  // ── timeout ───────────────────────────────────────────────────────

  describe('timeout behavior', () => {
    it('resolves with timeout result when user does not respond', async () => {
      const promise = bridge.startSession('tool-1', 'ssh user@host', 'C123', '1111.2222');

      // Advance past the user input timeout (5 minutes)
      jest.advanceTimersByTime(5 * 60 * 1000 + 100);

      const result = await promise;
      expect(result.handled).toBe(true);
      expect(result.error).toMatch(/timed?\s*out/i);
      expect(bridge.hasPending).toBe(false);
    });
  });

  // ── cleanup ───────────────────────────────────────────────────────

  describe('cleanup()', () => {
    it('cancels any active session', async () => {
      const promise = bridge.startSession('tool-1', 'ssh user@host', 'C123', '1111.2222');
      expect(bridge.hasPending).toBe(true);

      bridge.cleanup();
      expect(bridge.hasPending).toBe(false);

      const result = await promise;
      expect(result.handled).toBe(true);
      expect(result.error).toBeDefined();
    });

    it('is safe to call when nothing is pending', () => {
      expect(() => bridge.cleanup()).not.toThrow();
    });

    it('is safe to call multiple times', () => {
      bridge.startSession('tool-1', 'ssh user@host', 'C123', '1111.2222');
      expect(() => {
        bridge.cleanup();
        bridge.cleanup();
      }).not.toThrow();
    });
  });
});
