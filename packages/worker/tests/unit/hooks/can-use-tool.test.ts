// tests/unit/hooks/can-use-tool.test.ts
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createCanUseToolHook, extractBashPattern, extractBashPatterns } from '../../../src/hooks/can-use-tool';
import { PermissionManager } from '../../../src/services/permission-manager';
import { ConfigOverrides } from '../../../src/services/config-overrides';
import { mockSlackAdapter, type MockSlackAdapter } from '../../mocks/mock-slack-adapter';
import { mockLogger, type MockLogger } from '../../mocks/mock-logger';

// Helper to build the options object expected by the CanUseTool hook
function toolOpts(toolUseID: string) {
  return { toolUseID, signal: AbortSignal.abort() };
}

describe('createCanUseToolHook', () => {
  let slack: MockSlackAdapter;
  let logger: MockLogger;
  let permissions: PermissionManager;
  let configOverrides: ConfigOverrides;
  let hook: ReturnType<typeof createCanUseToolHook>;

  beforeEach(() => {
    slack = mockSlackAdapter();
    logger = mockLogger();
    permissions = new PermissionManager({
      slack: slack as any,
      logger: logger as any,
    });
    configOverrides = new ConfigOverrides();
    hook = createCanUseToolHook({
      permissions,
      configOverrides,
      logger: logger as any,
      channel: 'C123',
      threadTs: '1111.2222',
      previewMode: 'moderate',
    });
  });

  // ── Tool risk classification ──────────────────────────────────────

  describe('tool risk classification', () => {
    it('classifies rm -rf as destructive and requests permission', async () => {
      const hookPromise = hook(
        'Bash',
        { command: 'rm -rf /tmp/test' },
        toolOpts('tool-1'),
      );

      expect(permissions.hasPending).toBe(true);

      permissions.resolveInteraction('tool-1', { approved: true });

      const result = await hookPromise;
      expect(result.behavior).toBe('allow');
    });

    it('classifies git push --force as destructive', async () => {
      const hookPromise = hook(
        'Bash',
        { command: 'git push --force origin main' },
        toolOpts('tool-2'),
      );

      expect(permissions.hasPending).toBe(true);

      permissions.resolveInteraction('tool-2', { approved: true });
      const result = await hookPromise;
      expect(result.behavior).toBe('allow');
    });

    it('classifies Read as info and auto-allows', async () => {
      const result = await hook('Read', { file_path: '/tmp/test.txt' }, toolOpts('tool-3'));
      expect(result.behavior).toBe('allow');
      expect(permissions.hasPending).toBe(false);
    });

    it('classifies Grep as info and auto-allows', async () => {
      const result = await hook('Grep', { pattern: 'foo' }, toolOpts('tool-4'));
      expect(result.behavior).toBe('allow');
    });

    it('classifies Glob as info and auto-allows', async () => {
      const result = await hook('Glob', { pattern: '*.ts' }, toolOpts('tool-5'));
      expect(result.behavior).toBe('allow');
    });

    it('classifies WebFetch as info and auto-allows', async () => {
      const result = await hook('WebFetch', { url: 'https://example.com' }, toolOpts('tool-6'));
      expect(result.behavior).toBe('allow');
    });

    it('classifies WebSearch as info and auto-allows', async () => {
      const result = await hook('WebSearch', { query: 'test' }, toolOpts('tool-7'));
      expect(result.behavior).toBe('allow');
    });

    it('classifies Write as moderate and requests permission', async () => {
      const hookPromise = hook(
        'Write',
        { file_path: '/tmp/test.txt', content: 'hello' },
        toolOpts('tool-8'),
      );

      expect(permissions.hasPending).toBe(true);

      permissions.resolveInteraction('tool-8', { approved: true });
      const result = await hookPromise;
      expect(result.behavior).toBe('allow');
    });

    it('classifies Edit as moderate and requests permission', async () => {
      const hookPromise = hook(
        'Edit',
        { file_path: '/tmp/test.txt', old_string: 'a', new_string: 'b' },
        toolOpts('tool-9'),
      );

      expect(permissions.hasPending).toBe(true);

      permissions.resolveInteraction('tool-9', { approved: true });
      const result = await hookPromise;
      expect(result.behavior).toBe('allow');
    });

    it('classifies regular Bash commands as moderate', async () => {
      const hookPromise = hook(
        'Bash',
        { command: 'npm install' },
        toolOpts('tool-10'),
      );

      expect(permissions.hasPending).toBe(true);

      permissions.resolveInteraction('tool-10', { approved: true });
      const result = await hookPromise;
      expect(result.behavior).toBe('allow');
    });

    it('classifies unknown tools as moderate', async () => {
      const hookPromise = hook(
        'SomeUnknownTool',
        { foo: 'bar' },
        toolOpts('tool-11'),
      );

      expect(permissions.hasPending).toBe(true);

      permissions.resolveInteraction('tool-11', { approved: true });
      const result = await hookPromise;
      expect(result.behavior).toBe('allow');
    });
  });

  // ── Permission prompt flow ──────────────────────────────────────

  describe('permission prompt flow', () => {
    it('denies when user denies permission', async () => {
      const hookPromise = hook(
        'Bash',
        { command: 'npm install' },
        toolOpts('tool-deny-1'),
      );

      permissions.resolveInteraction('tool-deny-1', {
        approved: false,
        message: 'Not allowed',
      });

      const result = await hookPromise;
      expect(result.behavior).toBe('deny');
      expect((result as any).message).toBe('Not allowed');
    });

    it('includes updatedPermissions when provided', async () => {
      const hookPromise = hook(
        'Bash',
        { command: 'npm test' },
        toolOpts('tool-perms-1'),
      );

      const updatedPermissions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }] }];
      permissions.resolveInteraction('tool-perms-1', {
        approved: true,
        updatedPermissions,
      });

      const result = await hookPromise;
      expect(result.behavior).toBe('allow');
      expect((result as any).updatedPermissions).toEqual(updatedPermissions);
    });

    it('auto-allows info tools without posting permission message', async () => {
      const result = await hook('Read', { file_path: '/tmp/x' }, toolOpts('tool-auto-1'));
      expect(result.behavior).toBe('allow');
      expect(slack.sendInteractivePrompt).not.toHaveBeenCalled();
    });

    it('filters out already-approved patterns from suggestions', async () => {
      // First command: approve with "Always" for cat:*
      const hookPromise1 = hook(
        'Bash',
        { command: 'cat package.json' },
        toolOpts('tool-filter-1'),
      );
      permissions.resolveInteraction('tool-filter-1', {
        approved: true,
        updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'cat:*' }] }],
      });
      await hookPromise1;

      // Second command: cat | grep — cat:* should be filtered from suggestions
      const hookPromise2 = hook(
        'Bash',
        { command: 'cat tsconfig.json | grep test' },
        toolOpts('tool-filter-2'),
      );

      // Check the sendInteractivePrompt call for the second permission
      // Wait for the batch to flush
      await new Promise(resolve => setTimeout(resolve, 250));
      const calls = slack.sendInteractivePrompt.mock.calls;
      const lastCall = calls[calls.length - 1];
      const display = lastCall[2] as any;

      // The alwaysAllowLabel should only contain grep, not cat
      if (display.alwaysAllowLabel) {
        expect(display.alwaysAllowLabel).not.toContain('cat');
        expect(display.alwaysAllowLabel).toContain('grep');
      }

      permissions.resolveInteraction('tool-filter-2', { approved: true });
      await hookPromise2;
    });
  });

  // ── AskUserQuestion detection ─────────────────────────────────

  describe('AskUserQuestion detection', () => {
    it('delegates AskUserQuestion to PermissionManager and returns deny with answer', async () => {
      const hookPromise = hook(
        'AskUserQuestion',
        {
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
        },
        toolOpts('tool-ask-1'),
      );

      // PermissionManager should have a pending question
      expect(permissions.hasPending).toBe(true);

      // Resolve the question
      permissions.resolveInteraction('tool-ask-1', { answer: 'Red' });

      const result = await hookPromise;
      // AskUserQuestion always returns deny with the answer as message
      // so that the SDK doesn't actually execute the tool
      expect(result.behavior).toBe('deny');
      expect((result as any).message).toContain('Red');
    });

    it('handles multiple questions', async () => {
      const hookPromise = hook(
        'AskUserQuestion',
        {
          questions: [
            {
              header: 'Q1',
              question: 'First?',
              options: [{ label: 'A', description: 'opt A' }],
              multiSelect: false,
            },
            {
              header: 'Q2',
              question: 'Second?',
              options: [{ label: 'B', description: 'opt B' }],
              multiSelect: false,
            },
          ],
        },
        toolOpts('tool-ask-2'),
      );

      permissions.resolveInteraction('tool-ask-2', { answer: 'A and B' });

      const result = await hookPromise;
      expect(result.behavior).toBe('deny');
      expect((result as any).message).toContain('A and B');
    });
  });

  // ── ExitPlanMode passthrough ──────────────────────────────────

  describe('ExitPlanMode handling', () => {
    it('auto-allows ExitPlanMode (review is handled by pre-tool-use hook)', async () => {
      const result = await hook('ExitPlanMode', {}, toolOpts('tool-exit-1'));
      // ExitPlanMode is auto-allowed in canUseTool because the PreToolUse
      // hook already handled the plan review
      expect(result.behavior).toBe('allow');
    });
  });

  // ── Permission mode: bypassPermissions ──────────────────────────

  describe('permission mode overrides', () => {
    it('auto-allows all tools when permission mode is bypassPermissions', async () => {
      configOverrides.setPermissionMode('bypassPermissions');
      hook = createCanUseToolHook({
        permissions,
        configOverrides,
        logger: logger as any,
        channel: 'C123',
        threadTs: '1111.2222',
        previewMode: 'moderate',
      });

      const result = await hook('Bash', { command: 'rm -rf /' }, toolOpts('tool-bypass-1'));
      expect(result.behavior).toBe('allow');
      expect(permissions.hasPending).toBe(false);
    });

    it('auto-allows write tools when permission mode is acceptEdits', async () => {
      configOverrides.setPermissionMode('acceptEdits');
      hook = createCanUseToolHook({
        permissions,
        configOverrides,
        logger: logger as any,
        channel: 'C123',
        threadTs: '1111.2222',
        previewMode: 'moderate',
      });

      // Write tools should be auto-allowed
      const writeResult = await hook('Write', { file_path: '/tmp/x', content: 'y' }, toolOpts('tool-ae-1'));
      expect(writeResult.behavior).toBe('allow');

      const editResult = await hook('Edit', { file_path: '/tmp/x' }, toolOpts('tool-ae-2'));
      expect(editResult.behavior).toBe('allow');

      // But destructive Bash still requires permission
      const bashPromise = hook('Bash', { command: 'rm -rf /' }, toolOpts('tool-ae-3'));
      expect(permissions.hasPending).toBe(true);
      permissions.resolveInteraction('tool-ae-3', { approved: true });
      await bashPromise;
    });

    it('auto-allows everything in plan mode', async () => {
      configOverrides.setPermissionMode('plan');
      hook = createCanUseToolHook({
        permissions,
        configOverrides,
        logger: logger as any,
        channel: 'C123',
        threadTs: '1111.2222',
        previewMode: 'moderate',
      });

      const result = await hook('Write', { file_path: '/tmp/plan.md', content: 'plan' }, toolOpts('tool-plan-1'));
      expect(result.behavior).toBe('allow');
      expect(permissions.hasPending).toBe(false);
    });
  });
});

// ── extractBashPattern ───────────────────────────────────────────

describe('extractBashPattern', () => {
  it('extracts multi-word pattern for git commands', () => {
    expect(extractBashPattern('git pull --rebase')).toBe('git pull');
    expect(extractBashPattern('git commit -m "msg"')).toBe('git commit');
    expect(extractBashPattern('git push origin main')).toBe('git push');
  });

  it('strips cd prefix before extracting', () => {
    expect(extractBashPattern('cd /Users/biliu/Workspace/aura && git pull --rebase')).toBe('git pull');
    expect(extractBashPattern('cd /tmp && npm install')).toBe('npm install');
  });

  it('strips chained cd prefixes', () => {
    expect(extractBashPattern('cd /a && cd /b && git status')).toBe('git status');
  });

  it('extracts multi-word pattern for npm/yarn/pnpm', () => {
    expect(extractBashPattern('npm run build')).toBe('npm run');
    expect(extractBashPattern('npm install lodash')).toBe('npm install');
    expect(extractBashPattern('yarn add react')).toBe('yarn add');
    expect(extractBashPattern('pnpm test')).toBe('pnpm test');
  });

  it('extracts multi-word pattern for docker/cargo/kubectl', () => {
    expect(extractBashPattern('docker build .')).toBe('docker build');
    expect(extractBashPattern('cargo build --release')).toBe('cargo build');
    expect(extractBashPattern('kubectl get pods')).toBe('kubectl get');
  });

  it('skips flags to find subcommand', () => {
    expect(extractBashPattern('git -C /some/path pull --rebase')).toBe('git pull');
  });

  it('returns single token for non-multi-word tools', () => {
    expect(extractBashPattern('ls -la /some/path')).toBe('ls');
    expect(extractBashPattern('cat /tmp/file.txt')).toBe('cat');
    expect(extractBashPattern('make build')).toBe('make build');
  });

  it('handles absolute paths to executables', () => {
    expect(extractBashPattern('/usr/bin/git pull')).toBe('git pull');
  });

  it('returns undefined for empty input', () => {
    expect(extractBashPattern('')).toBeUndefined();
    expect(extractBashPattern('   ')).toBeUndefined();
  });
});

// ── extractBashPatterns ──────────────────────────────────────────

describe('extractBashPatterns', () => {
  it('extracts patterns from piped commands', () => {
    expect(extractBashPatterns('cat package.json | grep -A5 "test"')).toEqual(['cat', 'grep']);
  });

  it('extracts patterns from piped commands with redirections', () => {
    expect(extractBashPatterns('cat package.json | grep -A5 "test" 2>&1')).toEqual(['cat', 'grep']);
  });

  it('extracts patterns from && chains', () => {
    expect(extractBashPatterns('npm run build && npm run test')).toEqual(['npm run']);
  });

  it('extracts patterns from || chains', () => {
    expect(extractBashPatterns('cat file.txt || echo "not found"')).toEqual(['cat', 'echo']);
  });

  it('extracts patterns from mixed pipes and chains', () => {
    expect(extractBashPatterns('git status | grep modified && git add .')).toEqual(['git status', 'grep', 'git add']);
  });

  it('deduplicates patterns', () => {
    expect(extractBashPatterns('cat a.txt | cat b.txt')).toEqual(['cat']);
  });

  it('strips cd prefixes before extracting', () => {
    expect(extractBashPatterns('cd /tmp && git pull | grep error')).toEqual(['git pull', 'grep']);
  });

  it('returns single pattern for simple commands', () => {
    expect(extractBashPatterns('ls -la /some/path')).toEqual(['ls']);
  });

  it('returns empty array for empty input', () => {
    expect(extractBashPatterns('')).toEqual([]);
    expect(extractBashPatterns('   ')).toEqual([]);
  });
});
