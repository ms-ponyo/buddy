// tests/unit/services/permission-manager.test.ts
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { PermissionManager } from '../../../src/services/permission-manager';
import { mockSlackAdapter, type MockSlackAdapter } from '../../mocks/mock-slack-adapter';
import { mockLogger, type MockLogger } from '../../mocks/mock-logger';

describe('PermissionManager', () => {
  let slack: MockSlackAdapter;
  let logger: MockLogger;
  let pm: PermissionManager;

  beforeEach(() => {
    slack = mockSlackAdapter();
    logger = mockLogger();
    pm = new PermissionManager({
      slack: slack as any,
      logger: logger as any,
    });
  });

  // ── requestPermission ───────────────────────────────────────────────

  describe('requestPermission()', () => {
    it('posts permission blocks via slack and returns a promise that resolves when resolveInteraction is called', async () => {
      // Start the permission request (won't resolve until interaction)
      const promise = pm.requestPermission({
        toolName: 'Bash',
        toolInput: { command: 'ls -la' },
        callbackId: 'perm-1',
        channel: 'C123',
        threadTs: '1111.2222',
        risk: 'moderate',
        lockText: '`Bash` -> `ls -la`',
        suggestions: undefined,
      });

      // Should have sent an interactive prompt
      expect(slack.sendInteractivePrompt).toHaveBeenCalled();
      expect(pm.hasPending).toBe(true);

      // Resolve the permission
      const resolved = pm.resolveInteraction('perm-1', { approved: true });
      expect(resolved).toBe(true);

      const result = await promise;
      expect(result).toEqual({ approved: true });
      expect(pm.hasPending).toBe(false);
    });

    it('resolves with denied result when denied', async () => {
      const promise = pm.requestPermission({
        toolName: 'Bash',
        toolInput: { command: 'rm -rf /' },
        callbackId: 'perm-2',
        channel: 'C123',
        threadTs: '1111.2222',
        risk: 'destructive',
        lockText: '`Bash` -> `rm -rf /`',
        suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm:*' }], behavior: 'allow', destination: 'session' }],
      });

      pm.resolveInteraction('perm-2', { approved: false, message: 'Too dangerous' });

      const result = await promise;
      expect(result).toEqual({ approved: false, message: 'Too dangerous' });
    });

    it('stores suggestions and returns them via getSuggestions()', async () => {
      const suggestions = [
        { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git:*' }], behavior: 'allow', destination: 'session' },
      ];

      pm.requestPermission({
        toolName: 'Bash',
        toolInput: { command: 'git status' },
        callbackId: 'perm-always',
        channel: 'C123',
        threadTs: '1111.2222',
        risk: 'moderate',
        lockText: '`Bash` -> `git status`',
        suggestions,
      });

      expect(pm.getSuggestions('perm-always')).toEqual(suggestions);
      expect(pm.getSuggestions('nonexistent')).toBeUndefined();

      // Resolve with updatedPermissions (simulating "Always" click)
      pm.resolveInteraction('perm-always', {
        approved: true,
        updatedPermissions: suggestions,
      });
    });

    it('replaces existing pending permission (only one at a time)', async () => {
      const promise1 = pm.requestPermission({
        toolName: 'Bash',
        toolInput: { command: 'echo 1' },
        callbackId: 'perm-old',
        channel: 'C123',
        threadTs: '1111.2222',
        risk: 'moderate',
        lockText: 'test',
        suggestions: undefined,
      });

      const promise2 = pm.requestPermission({
        toolName: 'Bash',
        toolInput: { command: 'echo 2' },
        callbackId: 'perm-new',
        channel: 'C123',
        threadTs: '1111.2222',
        risk: 'moderate',
        lockText: 'test',
        suggestions: undefined,
      });

      // Old one should have been rejected
      await expect(promise1).rejects.toThrow('Superseded');

      // New one can be resolved
      pm.resolveInteraction('perm-new', { approved: true });
      const result = await promise2;
      expect(result).toEqual({ approved: true });
    });
  });

  // ── askUserQuestion ─────────────────────────────────────────────────

  describe('askUserQuestion()', () => {
    it('posts question blocks and resolves when resolveInteraction is called', async () => {
      const promise = pm.askUserQuestion({
        callbackId: 'q-1',
        channel: 'C123',
        threadTs: '1111.2222',
        questions: [
          {
            header: 'Pick a color',
            question: 'What is your favorite color?',
            options: [
              { label: 'Red', description: 'The color red' },
              { label: 'Blue', description: 'The color blue' },
            ],
            multiSelect: false,
          },
        ],
      });

      expect(slack.postMessage).toHaveBeenCalled();
      expect(pm.hasPending).toBe(true);

      pm.resolveInteraction('q-1', { answer: 'Red' });

      const result = await promise;
      expect(result).toBe('Red');
    });

    it('replaces existing pending question', async () => {
      const promise1 = pm.askUserQuestion({
        callbackId: 'q-old',
        channel: 'C123',
        threadTs: '1111.2222',
        questions: [],
      });

      const promise2 = pm.askUserQuestion({
        callbackId: 'q-new',
        channel: 'C123',
        threadTs: '1111.2222',
        questions: [],
      });

      await expect(promise1).rejects.toThrow('Superseded');

      pm.resolveInteraction('q-new', { answer: 'ok' });
      const result = await promise2;
      expect(result).toBe('ok');
    });
  });

  // ── requestPlanReview ───────────────────────────────────────────────

  describe('requestPlanReview()', () => {
    it('posts plan blocks and resolves when resolveInteraction is called', async () => {
      const promise = pm.requestPlanReview('## Step 1\nDo thing', 'plan-1');

      expect(slack.postMessage).toHaveBeenCalled();
      expect(pm.hasPending).toBe(true);

      pm.resolveInteraction('plan-1', { approved: true });

      const result = await promise;
      expect(result).toEqual({ approved: true });
    });

    it('resolves with rejected result', async () => {
      const promise = pm.requestPlanReview('Bad plan', 'plan-2');

      pm.resolveInteraction('plan-2', { approved: false, feedback: 'Needs work' });

      const result = await promise;
      expect(result).toEqual({ approved: false, feedback: 'Needs work' });
    });

    it('replaces existing pending plan review', async () => {
      const promise1 = pm.requestPlanReview('Plan A', 'plan-old');
      const promise2 = pm.requestPlanReview('Plan B', 'plan-new');

      await expect(promise1).rejects.toThrow('Superseded');

      pm.resolveInteraction('plan-new', { approved: true });
      const result = await promise2;
      expect(result).toEqual({ approved: true });
    });
  });

  // ── resolveInteraction ──────────────────────────────────────────────

  describe('resolveInteraction()', () => {
    it('returns true for matching callbackId', async () => {
      pm.requestPermission({
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        callbackId: 'perm-match',
        channel: 'C123',
        threadTs: '1111.2222',
        risk: 'moderate',
        lockText: 'test',
        suggestions: undefined,
      });

      expect(pm.resolveInteraction('perm-match', { approved: true })).toBe(true);
    });

    it('returns false for non-matching callbackId', () => {
      expect(pm.resolveInteraction('does-not-exist', { approved: true })).toBe(false);
    });

    it('returns false when called twice with same callbackId (already resolved)', async () => {
      pm.requestPermission({
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        callbackId: 'perm-once',
        channel: 'C123',
        threadTs: '1111.2222',
        risk: 'moderate',
        lockText: 'test',
        suggestions: undefined,
      });

      expect(pm.resolveInteraction('perm-once', { approved: true })).toBe(true);
      expect(pm.resolveInteraction('perm-once', { approved: true })).toBe(false);
    });

    it('resolves the correct type based on callbackId', async () => {
      const permPromise = pm.requestPermission({
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        callbackId: 'perm-x',
        channel: 'C123',
        threadTs: '1111.2222',
        risk: 'moderate',
        lockText: 'test',
        suggestions: undefined,
      });

      const qPromise = pm.askUserQuestion({
        callbackId: 'q-x',
        channel: 'C123',
        threadTs: '1111.2222',
        questions: [],
      });

      pm.resolveInteraction('perm-x', { approved: true });
      pm.resolveInteraction('q-x', { answer: 'yes' });

      const permResult = await permPromise;
      const qResult = await qPromise;
      expect(permResult).toEqual({ approved: true });
      expect(qResult).toBe('yes');
    });
  });

  // ── hasPending ──────────────────────────────────────────────────────

  describe('hasPending', () => {
    it('returns false when nothing is pending', () => {
      expect(pm.hasPending).toBe(false);
    });

    it('returns true when a permission is pending', () => {
      pm.requestPermission({
        toolName: 'Bash',
        toolInput: {},
        callbackId: 'p1',
        channel: 'C1',
        threadTs: '1.1',
        risk: 'moderate',
        lockText: 'test',
        suggestions: undefined,
      });
      expect(pm.hasPending).toBe(true);
    });

    it('returns true when a question is pending', () => {
      pm.askUserQuestion({
        callbackId: 'q1',
        channel: 'C1',
        threadTs: '1.1',
        questions: [],
      });
      expect(pm.hasPending).toBe(true);
    });

    it('returns true when a plan review is pending', () => {
      pm.requestPlanReview('plan', 'plan-1');
      expect(pm.hasPending).toBe(true);
    });
  });

  // ── staleCount ──────────────────────────────────────────────────────

  describe('staleCount()', () => {
    it('returns 0 when nothing is pending', () => {
      expect(pm.staleCount(1000)).toBe(0);
    });

    it('returns count of items older than threshold', () => {
      // Create items with timestamps in the past
      const now = Date.now();
      jest.spyOn(Date, 'now')
        .mockReturnValueOnce(now - 5000)  // permission created 5s ago
        .mockReturnValueOnce(now - 3000)  // question created 3s ago
        .mockReturnValueOnce(now);        // current time for staleCount

      pm.requestPermission({
        toolName: 'Bash',
        toolInput: {},
        callbackId: 'stale-perm',
        channel: 'C1',
        threadTs: '1.1',
        risk: 'moderate',
        lockText: 'test',
        suggestions: undefined,
      });

      pm.askUserQuestion({
        callbackId: 'stale-q',
        channel: 'C1',
        threadTs: '1.1',
        questions: [],
      });

      // Threshold of 4s: only the permission (5s old) is stale
      jest.spyOn(Date, 'now').mockReturnValue(now);
      expect(pm.staleCount(4000)).toBe(1);

      // Threshold of 2s: both are stale
      expect(pm.staleCount(2000)).toBe(2);

      // Threshold of 6s: nothing is stale
      expect(pm.staleCount(6000)).toBe(0);

      jest.restoreAllMocks();
    });
  });

  // ── clearAll ────────────────────────────────────────────────────────

  describe('clearAll()', () => {
    it('rejects all pending promises', async () => {
      const permPromise = pm.requestPermission({
        toolName: 'Bash',
        toolInput: {},
        callbackId: 'clear-perm',
        channel: 'C1',
        threadTs: '1.1',
        risk: 'moderate',
        lockText: 'test',
        suggestions: undefined,
      });

      const qPromise = pm.askUserQuestion({
        callbackId: 'clear-q',
        channel: 'C1',
        threadTs: '1.1',
        questions: [],
      });

      const planPromise = pm.requestPlanReview('plan', 'clear-plan');

      pm.clearAll();

      await expect(permPromise).rejects.toThrow('Cleared');
      await expect(qPromise).rejects.toThrow('Cleared');
      await expect(planPromise).rejects.toThrow('Cleared');
      expect(pm.hasPending).toBe(false);
    });

    it('is safe to call when nothing is pending', () => {
      expect(() => pm.clearAll()).not.toThrow();
    });
  });
});
