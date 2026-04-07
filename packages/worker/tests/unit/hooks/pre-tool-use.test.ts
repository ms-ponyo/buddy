// tests/unit/hooks/pre-tool-use.test.ts
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { SyncHookJSONOutput, PreToolUseHookInput, HookCallback } from '@anthropic-ai/claude-agent-sdk';

// Must use unstable_mockModule + dynamic import for ESM
const mockReadFile = jest.fn<(path: string, encoding: string) => Promise<string>>();
const mockReaddir = jest.fn<(path: string) => Promise<string[]>>();
const mockStat = jest.fn<(path: string) => Promise<{ mtimeMs: number }>>();
jest.unstable_mockModule('node:fs/promises', () => ({
  readFile: mockReadFile,
  readdir: mockReaddir,
  stat: mockStat,
}));

const { createPreToolUseHook } = await import('../../../src/hooks/pre-tool-use.js');
const { PermissionManager } = await import('../../../src/services/permission-manager.js');
const { mockSlackAdapter } = await import('../../mocks/mock-slack-adapter.js');
const { mockLogger } = await import('../../mocks/mock-logger.js');

type MockSlackAdapter = Awaited<ReturnType<typeof mockSlackAdapter>>;
type MockLogger = Awaited<ReturnType<typeof mockLogger>>;

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
  let permissions: PermissionManager;
  let onPermissionModeChange: jest.Mock;
  let hookFn: HookCallback;
  let sharedState: { trackedPlanFilePath?: string };

  beforeEach(() => {
    jest.useFakeTimers();
    mockReadFile.mockReset();
    mockReaddir.mockReset();
    mockStat.mockReset();
    // Default: no plans directory
    mockReaddir.mockRejectedValue(new Error('ENOENT'));
    sharedState = {};
    slack = mockSlackAdapter();
    logger = mockLogger();
    permissions = new PermissionManager({
      slack: slack as any,
      logger: logger as any,
    });
    onPermissionModeChange = jest.fn();
    const matchers = createPreToolUseHook({
      permissions,
      logger: logger as any,
      channel: 'C123',
      threadTs: '1111.2222',
      sharedState,
      onPermissionModeChange,
    });
    // Extract the hook function from the matchers
    hookFn = matchers[0].hooks[0];
  });

  afterEach(() => {
    jest.useRealTimers();
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
      expect(onPermissionModeChange).toHaveBeenCalledWith('plan');
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
      const planPath = '/home/user/.claude/plans/my-plan.md';
      mockReadFile.mockResolvedValue('# Step 1\nDo the thing');

      // First write a plan file so the path is tracked
      await hookFn(
        makeInput('Write', { file_path: planPath, content: '# Step 1\nDo the thing' }, 'tool-use-write'),
        'tool-use-write',
        defaultOptions,
      );

      const hookPromise = hookFn(
        makeInput('ExitPlanMode', {}, 'tool-use-exit'),
        'tool-use-exit',
        defaultOptions,
      );

      // Yield a tick so the async readFile mock resolves before we check hasPending
      await Promise.resolve();
      expect(permissions.hasPending).toBe(true);

      permissions.resolveInteraction('tool-use-exit', { approved: true });

      const result = await hookPromise as SyncHookJSONOutput;
      expect(result.hookSpecificOutput?.updatedInput).toBeDefined();
      expect(mockReadFile).toHaveBeenCalledWith(planPath, 'utf-8');
    });

    it('reads latest content from disk after Edit modifications (not stale Write content)', async () => {
      const planPath = '/home/user/.claude/plans/my-plan.md';

      // Write initial plan
      await hookFn(
        makeInput('Write', { file_path: planPath, content: '# Original plan' }, 'tool-use-write2'),
        'tool-use-write2',
        defaultOptions,
      );

      // Edit the plan (this is what the model does when revising)
      await hookFn(
        makeInput('Edit', { file_path: planPath, old_string: '# Original plan', new_string: '# Revised plan' }, 'tool-use-edit2'),
        'tool-use-edit2',
        defaultOptions,
      );

      // Mock readFile to return the edited content (as it would be on disk)
      mockReadFile.mockResolvedValue('# Revised plan');

      const hookPromise = hookFn(
        makeInput('ExitPlanMode', {}, 'tool-use-exit2'),
        'tool-use-exit2',
        defaultOptions,
      );

      // Yield a tick so the async readFile mock resolves before we check hasPending
      await Promise.resolve();
      expect(permissions.hasPending).toBe(true);

      permissions.resolveInteraction('tool-use-exit2', { approved: true });
      await hookPromise;

      // Verify it read from disk (getting the latest content) rather than using stale tracked content
      expect(mockReadFile).toHaveBeenCalledWith(planPath, 'utf-8');
    });

    it('discovers plan file from .claude/plans/ when no tracked path (e.g. after stop+restart)', async () => {
      // Create a hook with projectDir so discovery can work
      const projectDir = '/home/user/project';
      const freshSharedState: { trackedPlanFilePath?: string } = {};
      const matchers2 = createPreToolUseHook({
        permissions,
        logger: logger as any,
        channel: 'C123',
        threadTs: '1111.2222',
        projectDir,
        sharedState: freshSharedState,
        onPermissionModeChange,
      });
      const hookFn2 = matchers2[0].hooks[0];

      // No Write/Edit was called — trackedPlanFilePath is undefined
      // Mock the plans directory containing two files
      mockReaddir.mockResolvedValue(['old-plan.md', 'latest-plan.md', 'readme.txt']);
      mockStat.mockImplementation(async (p: string) => {
        if (p.includes('latest-plan')) return { mtimeMs: 2000 };
        if (p.includes('old-plan')) return { mtimeMs: 1000 };
        return { mtimeMs: 500 };
      });
      mockReadFile.mockResolvedValue('# Discovered plan content');

      const hookPromise = hookFn2(
        makeInput('ExitPlanMode', {}, 'tool-use-exit-discover'),
        'tool-use-exit-discover',
        defaultOptions,
      );

      // Yield enough ticks for readdir → stat loop → readFile → requestPlanReview
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(permissions.hasPending).toBe(true);

      permissions.resolveInteraction('tool-use-exit-discover', { approved: true });
      await hookPromise;

      // Should have scanned the plans directory and picked the newest .md file
      expect(mockReaddir).toHaveBeenCalledWith(projectDir + '/.claude/plans');
      expect(mockReadFile).toHaveBeenCalledWith(
        projectDir + '/.claude/plans/latest-plan.md',
        'utf-8',
      );
    });

    it('retains tracked plan path across hook recreations via shared state', async () => {
      const planPath = '/home/user/.claude/plans/persistent-plan.md';

      // Session 1: Write a plan — tracked in sharedState
      await hookFn(
        makeInput('Write', { file_path: planPath, content: '# Plan v1' }, 'tool-w1'),
        'tool-w1',
        defaultOptions,
      );
      expect(sharedState.trackedPlanFilePath).toBe(planPath);

      // Simulate stop+restart: create a NEW hook but reuse the SAME sharedState
      const matchers2 = createPreToolUseHook({
        permissions,
        logger: logger as any,
        channel: 'C123',
        threadTs: '1111.2222',
        sharedState, // same object — this is the fix
        onPermissionModeChange,
      });
      const hookFn2 = matchers2[0].hooks[0];

      mockReadFile.mockResolvedValue('# Plan v1');

      const hookPromise = hookFn2(
        makeInput('ExitPlanMode', {}, 'tool-exit-persist'),
        'tool-exit-persist',
        defaultOptions,
      );

      await Promise.resolve();
      expect(permissions.hasPending).toBe(true);

      permissions.resolveInteraction('tool-exit-persist', { approved: true });
      await hookPromise;

      // Verify the plan was read from the path tracked in shared state
      expect(mockReadFile).toHaveBeenCalledWith(planPath, 'utf-8');
    });

    it('recovers plan path from persistence after full process restart', async () => {
      const planPath = '/home/user/project/.claude/plans/recovered-plan.md';

      // Mock persistence adapter with a stored plan path
      const mockPersistence = {
        getPlanFilePath: jest.fn<() => Promise<string | undefined>>().mockResolvedValue(planPath),
        setPlanFilePath: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      };

      // Fresh shared state (simulating full process restart — nothing in memory)
      const freshState: { trackedPlanFilePath?: string } = {};

      const matchers2 = createPreToolUseHook({
        permissions,
        logger: logger as any,
        channel: 'C123',
        threadTs: '1111.2222',
        sharedState: freshState,
        persistence: mockPersistence as any,
        onPermissionModeChange,
      });
      const hookFn2 = matchers2[0].hooks[0];

      mockReadFile.mockResolvedValue('# Recovered plan from persistence');

      const hookPromise = hookFn2(
        makeInput('ExitPlanMode', {}, 'tool-exit-recovered'),
        'tool-exit-recovered',
        defaultOptions,
      );

      // Yield ticks for persistence lookup + readFile
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(permissions.hasPending).toBe(true);

      permissions.resolveInteraction('tool-exit-recovered', { approved: true });
      await hookPromise;

      // Should have queried persistence and read the file at the recovered path
      expect(mockPersistence.getPlanFilePath).toHaveBeenCalledWith('C123', '1111.2222');
      expect(mockReadFile).toHaveBeenCalledWith(planPath, 'utf-8');
      // Should also cache in shared state for subsequent calls
      expect(freshState.trackedPlanFilePath).toBe(planPath);
    });

    it('persists plan path to DB when Write detects a plan file', async () => {
      const planPath = '/home/user/.claude/plans/new-plan.md';

      const mockPersistence = {
        getPlanFilePath: jest.fn<() => Promise<string | undefined>>().mockResolvedValue(undefined),
        setPlanFilePath: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      };

      const matchers2 = createPreToolUseHook({
        permissions,
        logger: logger as any,
        channel: 'C123',
        threadTs: '1111.2222',
        sharedState: {},
        persistence: mockPersistence as any,
        onPermissionModeChange,
      });
      const hookFn2 = matchers2[0].hooks[0];

      await hookFn2(
        makeInput('Write', { file_path: planPath, content: '# New plan' }, 'tool-w-persist'),
        'tool-w-persist',
        defaultOptions,
      );

      // The setPlanFilePath call is fire-and-forget, yield a tick
      await Promise.resolve();
      expect(mockPersistence.setPlanFilePath).toHaveBeenCalledWith('C123', '1111.2222', planPath);
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

    it('switches to acceptEdits mode after plan approval', async () => {
      // Enter plan mode first
      await hookFn(
        makeInput('EnterPlanMode', {}, 'tool-enter'),
        'tool-enter',
        defaultOptions,
      );
      expect(onPermissionModeChange).toHaveBeenCalledWith('plan');

      const hookPromise = hookFn(
        makeInput('ExitPlanMode', {}, 'tool-exit'),
        'tool-exit',
        defaultOptions,
      );

      // Yield a tick so readFile (no tracked file → skipped) resolves
      await Promise.resolve();

      permissions.resolveInteraction('tool-exit', { approved: true });
      const result = await hookPromise as SyncHookJSONOutput;
      expect(result.hookSpecificOutput?.updatedInput).toBeDefined();
      expect(onPermissionModeChange).toHaveBeenCalledWith('acceptEdits');
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
