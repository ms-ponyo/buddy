// tests/unit/hooks/pre-tool-use.test.ts
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { SyncHookJSONOutput, PreToolUseHookInput, HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { createPreToolUseHook } from '../../../src/hooks/pre-tool-use';
import { InteractiveBridge } from '../../../src/services/interactive-bridge';
import { PermissionManager } from '../../../src/services/permission-manager';
import { ConfigOverrides } from '../../../src/services/config-overrides';
import { mockSlackAdapter, type MockSlackAdapter } from '../../mocks/mock-slack-adapter';
import { mockLogger, type MockLogger } from '../../mocks/mock-logger';

/** Build a PreToolUseHookInput from tool name/input/id. */
function makeInput(toolName: string, toolInput: Record<string, unknown>, toolUseId: string): PreToolUseHookInput {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
    session_id: 'test-session',
    transcript_path: '/tmp/transcript',
    cwd: '/tmp',
  };
}

const defaultOptions = { signal: new AbortController().signal };

describe('createPreToolUseHook', () => {
  let slack: MockSlackAdapter;
  let logger: MockLogger;
  let bridge: InteractiveBridge;
  let permissions: PermissionManager;
  let configOverrides: ConfigOverrides;
  let hookFn: HookCallback;

  beforeEach(() => {
    jest.useFakeTimers();
    slack = mockSlackAdapter();
    logger = mockLogger();
    bridge = new InteractiveBridge({
      slack: slack as any,
      logger: logger as any,
    });
    permissions = new PermissionManager({
      slack: slack as any,
      logger: logger as any,
    });
    configOverrides = new ConfigOverrides();
    const matchers = createPreToolUseHook({
      bridge,
      permissions,
      configOverrides,
      logger: logger as any,
      channel: 'C123',
      threadTs: '1111.2222',
      interactivePatterns: ['ssh', 'gh auth login'],
    });
    // Extract the hook function from the matchers
    hookFn = matchers[0].hooks[0];
  });

  afterEach(() => {
    bridge.cleanup();
    jest.useRealTimers();
  });

  // ── Interactive bridge detection ──────────────────────────────────

  describe('interactive bridge detection', () => {
    it('delegates to interactive bridge when Bash command matches interactive pattern', async () => {
      const hookPromise = hookFn(
        makeInput('Bash', { command: 'ssh user@host' }, 'tool-use-1'),
        'tool-use-1',
        defaultOptions,
      );

      expect(bridge.hasPending).toBe(true);

      bridge.resolveInteraction('tool-use-1', { action: 'text', text: 'password123' });

      const result = await hookPromise as SyncHookJSONOutput;
      expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(result.hookSpecificOutput?.permissionDecisionReason).toBeDefined();
    });

    it('allows Bash commands that do not match interactive patterns', async () => {
      const result = await hookFn(
        makeInput('Bash', { command: 'ls -la' }, 'tool-use-2'),
        'tool-use-2',
        defaultOptions,
      ) as SyncHookJSONOutput;
      // Passthrough: no permissionDecision set
      expect(result.hookSpecificOutput?.permissionDecision).toBeUndefined();
      expect(bridge.hasPending).toBe(false);
    });

    it('matches multi-word interactive patterns', async () => {
      const hookPromise = hookFn(
        makeInput('Bash', { command: 'gh auth login' }, 'tool-use-3'),
        'tool-use-3',
        defaultOptions,
      );

      expect(bridge.hasPending).toBe(true);

      bridge.resolveInteraction('tool-use-3', { action: 'cancel' });

      const result = await hookPromise as SyncHookJSONOutput;
      expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    });

    it('passes bridge error in the deny reason', async () => {
      const hookPromise = hookFn(
        makeInput('Bash', { command: 'ssh user@host' }, 'tool-use-4'),
        'tool-use-4',
        defaultOptions,
      );

      bridge.resolveInteraction('tool-use-4', { action: 'cancel' });

      const result = await hookPromise as SyncHookJSONOutput;
      expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(result.hookSpecificOutput?.permissionDecisionReason).toBeDefined();
    });
  });

  // ── EnterPlanMode handling ──────────────────────────────────────

  describe('EnterPlanMode handling', () => {
    it('auto-allows EnterPlanMode and sets permission mode to plan', async () => {
      const result = await hookFn(
        makeInput('EnterPlanMode', {}, 'tool-use-5'),
        'tool-use-5',
        defaultOptions,
      ) as SyncHookJSONOutput;

      expect(result.hookSpecificOutput?.updatedInput).toBeDefined();
      expect(configOverrides.getPermissionMode()).toBe('plan');
    });

    it('logs the EnterPlanMode interception', async () => {
      await hookFn(
        makeInput('EnterPlanMode', {}, 'tool-use-6'),
        'tool-use-6',
        defaultOptions,
      );

      const infoCalls = logger.calls.info;
      const found = infoCalls.some(c => c.msg.includes('EnterPlanMode'));
      expect(found).toBe(true);
    });
  });

  // ── Write hook (plan files) ──────────────────────────────────────

  describe('Write hook for plan files', () => {
    it('passes through writes to plan directories (tracks but does not intercept)', async () => {
      const result = await hookFn(
        makeInput('Write', { file_path: '/home/user/.claude/plans/my-plan.md', content: '# Plan' }, 'tool-use-7'),
        'tool-use-7',
        defaultOptions,
      ) as SyncHookJSONOutput;

      // Plan file writes pass through (no permissionDecision)
      expect(result.hookSpecificOutput?.permissionDecision).toBeUndefined();
    });

    it('does not intercept writes to non-plan paths', async () => {
      const result = await hookFn(
        makeInput('Write', { file_path: '/home/user/project/src/main.ts', content: 'code' }, 'tool-use-8'),
        'tool-use-8',
        defaultOptions,
      ) as SyncHookJSONOutput;

      expect(result.hookSpecificOutput?.permissionDecision).toBeUndefined();
    });

    it('does not intercept writes to plan paths that are not .md files', async () => {
      const result = await hookFn(
        makeInput('Write', { file_path: '/home/user/.claude/plans/data.json', content: '{}' }, 'tool-use-9'),
        'tool-use-9',
        defaultOptions,
      ) as SyncHookJSONOutput;

      expect(result.hookSpecificOutput?.permissionDecision).toBeUndefined();
    });

    it('matches both /plan/ and /plans/ directory patterns', async () => {
      const result1 = await hookFn(
        makeInput('Write', { file_path: '/home/user/.claude/plan/my-plan.md', content: '# Plan' }, 'tool-use-10a'),
        'tool-use-10a',
        defaultOptions,
      ) as SyncHookJSONOutput;
      const result2 = await hookFn(
        makeInput('Write', { file_path: '/home/user/.claude/plans/my-plan.md', content: '# Plan' }, 'tool-use-10b'),
        'tool-use-10b',
        defaultOptions,
      ) as SyncHookJSONOutput;

      expect(result1.hookSpecificOutput?.permissionDecision).toBeUndefined();
      expect(result2.hookSpecificOutput?.permissionDecision).toBeUndefined();
    });
  });

  // ── ExitPlanMode (plan review) ──────────────────────────────────

  describe('ExitPlanMode handling', () => {
    it('triggers plan review via PermissionManager and allows on approval', async () => {
      // First write a plan file so there's content to review
      await hookFn(
        makeInput('Write', { file_path: '/home/user/.claude/plans/my-plan.md', content: '# Step 1\nDo the thing' }, 'tool-use-write'),
        'tool-use-write',
        defaultOptions,
      );

      const hookPromise = hookFn(
        makeInput('ExitPlanMode', {}, 'tool-use-exit'),
        'tool-use-exit',
        defaultOptions,
      );

      expect(permissions.hasPending).toBe(true);

      permissions.resolveInteraction('tool-use-exit', { approved: true });

      const result = await hookPromise as SyncHookJSONOutput;
      expect(result.hookSpecificOutput?.updatedInput).toBeDefined();
    });

    it('denies ExitPlanMode when plan is rejected', async () => {
      const hookPromise = hookFn(
        makeInput('ExitPlanMode', {}, 'tool-use-exit-deny'),
        'tool-use-exit-deny',
        defaultOptions,
      );

      expect(permissions.hasPending).toBe(true);

      permissions.resolveInteraction('tool-use-exit-deny', {
        approved: false,
        feedback: 'Needs more detail',
      });

      const result = await hookPromise as SyncHookJSONOutput;
      expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(result.hookSpecificOutput?.permissionDecisionReason).toContain('Needs more detail');
    });

    it('uses fallback text when no plan file was written', async () => {
      const hookPromise = hookFn(
        makeInput('ExitPlanMode', {}, 'tool-use-exit-nofile'),
        'tool-use-exit-nofile',
        defaultOptions,
      );

      expect(permissions.hasPending).toBe(true);

      permissions.resolveInteraction('tool-use-exit-nofile', { approved: true });

      const result = await hookPromise as SyncHookJSONOutput;
      expect(result.hookSpecificOutput?.updatedInput).toBeDefined();
    });

    it('resets permission mode after plan review', async () => {
      // Enter plan mode first
      await hookFn(
        makeInput('EnterPlanMode', {}, 'tool-enter'),
        'tool-enter',
        defaultOptions,
      );
      expect(configOverrides.getPermissionMode()).toBe('plan');

      const hookPromise = hookFn(
        makeInput('ExitPlanMode', {}, 'tool-exit'),
        'tool-exit',
        defaultOptions,
      );

      permissions.resolveInteraction('tool-exit', { approved: true });
      await hookPromise;

      expect(configOverrides.getPermissionMode()).toBeUndefined();
    });
  });

  // ── Non-intercepted tools ──────────────────────────────────────

  describe('non-intercepted tools', () => {
    it('passes through Read tool without modification', async () => {
      const result = await hookFn(
        makeInput('Read', { file_path: '/tmp/test.txt' }, 'tool-use-read'),
        'tool-use-read',
        defaultOptions,
      ) as SyncHookJSONOutput;
      // Passthrough: empty object
      expect(result.hookSpecificOutput?.permissionDecision).toBeUndefined();
    });

    it('passes through Edit tool without modification', async () => {
      const result = await hookFn(
        makeInput('Edit', { file_path: '/tmp/test.txt', old_string: 'a', new_string: 'b' }, 'tool-use-edit'),
        'tool-use-edit',
        defaultOptions,
      ) as SyncHookJSONOutput;
      expect(result.hookSpecificOutput?.permissionDecision).toBeUndefined();
    });

    it('passes through Grep tool without modification', async () => {
      const result = await hookFn(
        makeInput('Grep', { pattern: 'foo' }, 'tool-use-grep'),
        'tool-use-grep',
        defaultOptions,
      ) as SyncHookJSONOutput;
      expect(result.hookSpecificOutput?.permissionDecision).toBeUndefined();
    });
  });
});
