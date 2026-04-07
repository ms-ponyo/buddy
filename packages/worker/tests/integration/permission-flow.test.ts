// tests/integration/permission-flow.test.ts — Integration test for PermissionManager.
// Verifies: post buttons → simulate click → promise resolved.

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mockWorkerContext } from '../mocks/mock-context.js';
import type { WorkerContext } from '../../src/context.js';
import type { PermissionResult } from '../../src/services/permission-manager.js';

// ── Tests ────────────────────────────────────────────────────────────

describe('Permission flow integration', () => {
  let ctx: WorkerContext;

  beforeEach(() => {
    jest.useFakeTimers();
    ctx = mockWorkerContext();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // ── requestPermission → resolveInteraction ────────────────────────

  describe('requestPermission() → resolveInteraction()', () => {
    it('posts permission blocks and resolves when user clicks allow', async () => {
      // Start a permission request (this returns a promise that resolves on interaction)
      const permissionPromise = ctx.permissions.requestPermission({
        toolName: 'Bash',
        toolInput: { command: 'npm install' },
        callbackId: 'perm-123',
        channel: 'C_TEST',
        threadTs: '1700000000.000000',
        risk: 'moderate',
        lockText: 'Run: npm install',
        suggestions: undefined,
      });

      // Verify that permission is pending
      expect(ctx.permissions.hasPending).toBe(true);

      // Advance past batch debounce (200ms)
      jest.advanceTimersByTime(300);

      // Verify interactive prompt was sent to Slack
      const prompts = (ctx.slack as any).interactivePrompts;
      expect(prompts.length).toBeGreaterThanOrEqual(1);

      // Simulate user clicking "Allow" by resolving the interaction
      const resolved = ctx.permissions.resolveInteraction('perm-123', {
        approved: true,
        message: 'User approved',
      } as PermissionResult);
      expect(resolved).toBe(true);

      // The promise should now resolve
      const result = await permissionPromise;
      expect(result.approved).toBe(true);
      expect(result.message).toBe('User approved');

      // Permission should no longer be pending
      expect(ctx.permissions.hasPending).toBe(false);
    });

    it('resolves with denied when user clicks deny', async () => {
      const permissionPromise = ctx.permissions.requestPermission({
        toolName: 'Bash',
        toolInput: { command: 'rm -rf /' },
        callbackId: 'perm-deny-456',
        channel: 'C_TEST',
        threadTs: '1700000000.000000',
        risk: 'destructive',
        lockText: 'Run: rm -rf /',
        suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm:*' }], behavior: 'allow', destination: 'session' }],
      });

      // Advance past batch debounce
      jest.advanceTimersByTime(300);

      // Simulate denial
      const resolved = ctx.permissions.resolveInteraction('perm-deny-456', {
        approved: false,
        message: 'User denied',
      } as PermissionResult);
      expect(resolved).toBe(true);

      const result = await permissionPromise;
      expect(result.approved).toBe(false);
    });

    it('returns false for resolveInteraction with non-matching callbackId', async () => {
      // Start a permission request and hold the promise to catch its rejection later
      const permissionPromise = ctx.permissions.requestPermission({
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        callbackId: 'perm-real',
        channel: 'C_TEST',
        threadTs: '1700000000.000000',
        risk: 'info',
        lockText: 'Run: ls',
        suggestions: undefined,
      });

      // Advance past batch debounce
      jest.advanceTimersByTime(300);

      // Try to resolve with wrong callback ID
      const resolved = ctx.permissions.resolveInteraction('perm-wrong', {
        approved: true,
      } as PermissionResult);
      expect(resolved).toBe(false);

      // Original permission still pending
      expect(ctx.permissions.hasPending).toBe(true);

      // Clean up: resolve properly so the promise doesn't leak
      ctx.permissions.resolveInteraction('perm-real', { approved: true } as PermissionResult);
      await permissionPromise;
    });

    it('batches concurrent permission requests', async () => {
      // First permission request
      const firstPromise = ctx.permissions.requestPermission({
        toolName: 'Bash',
        toolInput: { command: 'echo 1' },
        callbackId: 'perm-first',
        channel: 'C_TEST',
        threadTs: '1700000000.000000',
        risk: 'info',
        lockText: 'Run: echo 1',
        suggestions: undefined,
      });

      // Second permission within debounce window
      const secondPromise = ctx.permissions.requestPermission({
        toolName: 'Bash',
        toolInput: { command: 'echo 2' },
        callbackId: 'perm-second',
        channel: 'C_TEST',
        threadTs: '1700000000.000000',
        risk: 'info',
        lockText: 'Run: echo 2',
        suggestions: undefined,
      });

      // Advance past batch debounce
      jest.advanceTimersByTime(300);

      // Both should be pending
      expect(ctx.permissions.hasPending).toBe(true);

      // The prompts should have been posted as a batch
      const prompts = (ctx.slack as any).interactivePrompts;
      expect(prompts.length).toBeGreaterThanOrEqual(1);

      // Resolve the batch — find the batch callbackId
      const batchCallbackId = prompts[prompts.length - 1].callbackId;
      ctx.permissions.resolveInteraction(batchCallbackId, { approved: true } as PermissionResult);

      const result1 = await firstPromise;
      const result2 = await secondPromise;
      expect(result1.approved).toBe(true);
      expect(result2.approved).toBe(true);
    });
  });

  // ── askUserQuestion → resolveInteraction ──────────────────────────

  describe('askUserQuestion() → resolveInteraction()', () => {
    it('posts question blocks and resolves with user answer', async () => {
      const questionPromise = ctx.permissions.askUserQuestion({
        callbackId: 'q-123',
        questions: [
          {
            question: 'Which framework do you prefer?',
            header: 'Framework Choice',
            options: [
              { label: 'React', description: 'Frontend library' },
              { label: 'Vue', description: 'Progressive framework' },
            ],
            multiSelect: false,
          },
        ],
      });

      expect(ctx.permissions.hasPending).toBe(true);

      // Simulate user answering
      const resolved = ctx.permissions.resolveInteraction('q-123', {
        answer: 'React',
      });
      expect(resolved).toBe(true);

      const answer = await questionPromise;
      expect(answer).toBe('React');
      expect(ctx.permissions.hasPending).toBe(false);
    });
  });

  // ── clearAll ──────────────────────────────────────────────────────

  describe('clearAll()', () => {
    it('rejects all pending promises', async () => {
      const permPromise = ctx.permissions.requestPermission({
        toolName: 'Bash',
        toolInput: { command: 'echo test' },
        callbackId: 'perm-clear',
        channel: 'C_TEST',
        threadTs: '1700000000.000000',
        risk: 'info',
        lockText: 'Run: echo test',
        suggestions: undefined,
      });

      // Attach rejection handler BEFORE clearing to avoid unhandled rejection
      const permCatch = permPromise.catch((e: Error) => e);

      const qPromise = ctx.permissions.askUserQuestion({
        callbackId: 'q-clear',
        questions: [
          {
            question: 'Choose one',
            header: 'Choice',
            options: [{ label: 'A', description: 'Option A' }],
            multiSelect: false,
          },
        ],
      });

      // Attach rejection handler BEFORE clearing
      const qCatch = qPromise.catch((e: Error) => e);

      expect(ctx.permissions.hasPending).toBe(true);

      ctx.permissions.clearAll();

      // Both should have been rejected with "Cleared"
      const permError = await permCatch;
      expect(permError).toBeInstanceOf(Error);
      expect((permError as Error).message).toBe('Cleared');

      const qError = await qCatch;
      expect(qError).toBeInstanceOf(Error);
      expect((qError as Error).message).toBe('Cleared');

      expect(ctx.permissions.hasPending).toBe(false);
    });
  });

  // ── staleCount ────────────────────────────────────────────────────

  describe('staleCount()', () => {
    it('returns 0 when no pending items', () => {
      jest.useRealTimers();
      expect(ctx.permissions.staleCount(1000)).toBe(0);
      jest.useFakeTimers();
    });

    it('returns count of pending items older than threshold', async () => {
      jest.useRealTimers();

      // Create a pending permission
      const permPromise = ctx.permissions.requestPermission({
        toolName: 'Bash',
        toolInput: { command: 'test' },
        callbackId: 'perm-stale',
        channel: 'C_TEST',
        threadTs: '1700000000.000000',
        risk: 'info',
        lockText: 'test',
        suggestions: undefined,
      });

      // Attach rejection handler to prevent unhandled rejection
      permPromise.catch(() => {});

      // Wait a tiny bit so the item has age > 0
      await new Promise((r) => setTimeout(r, 5));

      // With threshold of 1ms, the item should now be stale (age > 1ms)
      expect(ctx.permissions.staleCount(1)).toBe(1);

      // With very large threshold, nothing is stale yet
      expect(ctx.permissions.staleCount(100_000)).toBe(0);

      // Clean up
      ctx.permissions.clearAll();
      jest.useFakeTimers();
    });
  });
});
