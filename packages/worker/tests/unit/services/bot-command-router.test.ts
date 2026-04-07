// tests/unit/services/bot-command-router.test.ts
import { describe, it, expect, beforeEach } from '@jest/globals';
import { BotCommandRouter } from '../../../src/services/bot-command-router';
import { ConfigOverrides } from '../../../src/services/config-overrides';
import { mockLogger, type MockLogger } from '../../mocks/mock-logger';
import type { BuddyConfig, ActiveExecution } from '../../../src/types';
import type { InitInfo, AccountInfo } from '../../../src/services/claude-session';

function makeConfig(overrides: Partial<BuddyConfig> = {}): BuddyConfig {
  return {
    claudeModel: 'claude-sonnet-4-6',
    dispatchModel: 'claude-haiku-4-5-20251001',
    permissionMode: 'default',
    permissionDestination: 'projectSettings',
    previewMode: 'moderate',
    logLevel: 'info',
    logFile: 'test.log',
    projectDir: '/tmp/project',
    slackBotToken: 'xoxb-test',
    allowedUserIds: [],
    allowedChannelIds: [],
    adminUserIds: [],
    triggerEmoji: 'robot_face',
    projectMappingsFile: '',
    mcpServers: {},
    plugins: [],
    interactiveBridgePatterns: [],
    socketPath: '/tmp/sock',
    persistenceSocket: '/tmp/persist',
    gatewaySocket: '/tmp/gateway',
    ...overrides,
  };
}

describe('BotCommandRouter', () => {
  let router: BotCommandRouter;
  let logger: MockLogger;
  let configOverrides: ConfigOverrides;
  let config: BuddyConfig;

  beforeEach(() => {
    logger = mockLogger();
    configOverrides = new ConfigOverrides();
    config = makeConfig();
    router = new BotCommandRouter({
      logger: logger as any,
      configOverrides,
      config,
    });
  });

  // ── parse ─────────────────────────────────────────────────────────

  describe('parse()', () => {
    it('parses !command into { command, args }', () => {
      expect(router.parse('!model sonnet')).toEqual({
        command: 'model',
        args: 'sonnet',
      });
    });

    it('parses !command with no args', () => {
      expect(router.parse('!status')).toEqual({
        command: 'status',
        args: '',
      });
    });

    it('returns undefined for non-command text', () => {
      expect(router.parse('hello world')).toBeUndefined();
    });

    it('normalizes command to lowercase', () => {
      expect(router.parse('!MODEL opus')).toEqual({
        command: 'model',
        args: 'opus',
      });
    });

    it('handles multiline args', () => {
      const result = router.parse('!system line1\nline2');
      expect(result).toEqual({
        command: 'system',
        args: 'line1\nline2',
      });
    });

    it('trims whitespace from args', () => {
      expect(router.parse('!model   sonnet  ')).toEqual({
        command: 'model',
        args: 'sonnet',
      });
    });
  });

  // ── rewriteSlashCommand ───────────────────────────────────────────

  describe('rewriteSlashCommand()', () => {
    it('converts !slash-command to /slash-command', () => {
      expect(router.rewriteSlashCommand('!compact')).toBe('/compact');
    });

    it('preserves args', () => {
      expect(router.rewriteSlashCommand('!review pr 123')).toBe('/review pr 123');
    });

    it('returns non-command text unchanged', () => {
      expect(router.rewriteSlashCommand('hello world')).toBe('hello world');
    });

    it('returns text starting with space unchanged', () => {
      expect(router.rewriteSlashCommand(' !model sonnet')).toBe(' !model sonnet');
    });
  });

  // ── execute — model command ───────────────────────────────────────

  describe('execute() — model', () => {
    it('sets model override and returns handled', async () => {
      const result = await router.execute({ command: 'model', args: 'claude-opus-4-6' });
      expect(result.type).toBe('handled');
      expect(configOverrides.getModel()).toBe('claude-opus-4-6');
    });

    it('returns dispatch when no args given', async () => {
      const result = await router.execute({ command: 'model', args: '' });
      expect(result.type).toBe('dispatch');
    });

    it('returns dispatch when model not recognized', async () => {
      const result = await router.execute({ command: 'model', args: 'gpt-4' });
      expect(result.type).toBe('dispatch');
    });
  });

  // ── execute — effort command ──────────────────────────────────────

  describe('execute() — effort', () => {
    it('sets effort override', async () => {
      const result = await router.execute({ command: 'effort', args: 'high' });
      expect(result.type).toBe('handled');
      expect(configOverrides.getEffort()).toBe('high');
    });

    it('returns dispatch for invalid effort level', async () => {
      const result = await router.execute({ command: 'effort', args: 'ultra' });
      expect(result.type).toBe('dispatch');
    });
  });

  // ── execute — budget command ──────────────────────────────────────

  describe('execute() — budget', () => {
    it('sets budget override', async () => {
      const result = await router.execute({ command: 'budget', args: '5.00' });
      expect(result.type).toBe('handled');
      expect(configOverrides.getBudget()).toBe(5.0);
    });

    it('handles dollar sign prefix', async () => {
      const result = await router.execute({ command: 'budget', args: '$10' });
      expect(result.type).toBe('handled');
      expect(configOverrides.getBudget()).toBe(10);
    });

    it('returns handled with current budget when no args', async () => {
      const result = await router.execute({ command: 'budget', args: '' });
      expect(result.type).toBe('handled');
    });

    it('returns dispatch for invalid amount', async () => {
      const result = await router.execute({ command: 'budget', args: 'abc' });
      expect(result.type).toBe('dispatch');
    });
  });

  // ── execute — mode command ────────────────────────────────────────

  describe('execute() — mode', () => {
    it('sets permission mode override', async () => {
      const result = await router.execute({ command: 'mode', args: 'acceptEdits' });
      expect(result.type).toBe('handled');
      expect(configOverrides.getPermissionMode()).toBe('acceptEdits');
    });

    it('supports shorthand aliases', async () => {
      const result = await router.execute({ command: 'mode', args: 'ae' });
      expect(result.type).toBe('handled');
      expect(configOverrides.getPermissionMode()).toBe('acceptEdits');
    });

    it('returns dispatch for no args', async () => {
      const result = await router.execute({ command: 'mode', args: '' });
      expect(result.type).toBe('dispatch');
    });

    it('returns dispatch for invalid mode', async () => {
      const result = await router.execute({ command: 'mode', args: 'turbo' });
      expect(result.type).toBe('dispatch');
    });
  });

  // ── execute — status command ──────────────────────────────────────

  describe('execute() — status', () => {
    it('returns handled with status info', async () => {
      const result = await router.execute({ command: 'status', args: '' });
      expect(result.type).toBe('handled');
      expect(result.reply).toBeDefined();
    });

    it('includes model in status', async () => {
      configOverrides.setModel('claude-opus-4-6');
      const result = await router.execute({ command: 'status', args: '' });
      expect(result.reply).toContain('claude-opus-4-6');
    });

    it('includes cwd from config when no initInfo', async () => {
      const result = await router.execute({ command: 'status', args: '' });
      expect(result.reply).toContain('*cwd:*');
      expect(result.reply).toContain(config.projectDir);
    });

    it('shows Idle status when no active execution', async () => {
      const result = await router.execute({ command: 'status', args: '' });
      expect(result.reply).toContain('*Status:* Idle');
    });
  });

  // ── execute — status with initInfo/accountInfo ─────────────────────

  describe('execute() — status with full context', () => {
    let fullRouter: BotCommandRouter;
    const testInitInfo: InitInfo = {
      claudeCodeVersion: '2.3.0',
      cwd: '/home/user/myproject',
      model: 'claude-opus-4-6',
      permissionMode: 'default',
      mcpServers: [
        { name: 'filesystem', status: 'connected' },
        { name: 'slack', status: 'needs-auth' },
      ],
      plugins: [
        { name: 'superpowers', path: '/plugins/superpowers' },
        { name: 'pr-review', path: '/plugins/pr-review' },
      ],
    };
    const testAccountInfo: AccountInfo = {
      email: 'dev@example.com',
      organization: 'Acme Corp',
      subscriptionType: 'pro',
    };
    const testExecution: ActiveExecution = {
      sessionId: 'abcdefgh12345678',
      execLog: [],
      channel: 'C123',
      threadTs: '1234.5678',
      toolCount: 5,
      filesChanged: new Set(['src/index.ts', 'src/util.ts']),
      lastIntent: 'fix bug',
      statusTs: '1234.5679',
      isBackground: false,
      interrupted: false,
      model: 'claude-opus-4-6',
      costUsd: 0.0234,
      createdAt: Date.now() - 30_000,
      lastActivityAt: Date.now(),
      usage: {
        inputTokens: 5000,
        outputTokens: 1000,
        cacheReadTokens: 200,
        cacheCreationTokens: 0,
        contextWindowPercent: 42,
        numTurns: 3,
      },
    };

    beforeEach(() => {
      fullRouter = new BotCommandRouter({
        logger: logger as any,
        configOverrides,
        config,
        getCurrentExecution: () => testExecution,
        getInitInfo: () => testInitInfo,
        getAccountInfo: () => testAccountInfo,
        getSessionCost: () => Promise.resolve(0.0567),
      });
    });

    it('includes version from initInfo', async () => {
      const result = await fullRouter.execute({ command: 'status', args: '' });
      expect(result.reply).toContain('*Version:* 2.3.0');
    });

    it('includes session ID (truncated)', async () => {
      const result = await fullRouter.execute({ command: 'status', args: '' });
      expect(result.reply).toContain('*Session ID:* `abcdefgh\u2026`');
    });

    it('includes cwd from initInfo', async () => {
      const result = await fullRouter.execute({ command: 'status', args: '' });
      expect(result.reply).toContain('*cwd:* `/home/user/myproject`');
    });

    it('includes account info', async () => {
      const result = await fullRouter.execute({ command: 'status', args: '' });
      expect(result.reply).toContain('*Login:* pro');
      expect(result.reply).toContain('*Organization:* Acme Corp');
      expect(result.reply).toContain('*Email:* dev@example.com');
    });

    it('includes execution status when running', async () => {
      const result = await fullRouter.execute({ command: 'status', args: '' });
      expect(result.reply).toContain('*Status:* Running');
      expect(result.reply).toContain('*Model:* `claude-opus-4-6`');
      expect(result.reply).toContain('*Tools used:* 5');
      expect(result.reply).toContain('*Files changed:* 2');
      expect(result.reply).toContain('*Context:* 42% | *Turns:* 3');
    });

    it('includes session cost', async () => {
      const result = await fullRouter.execute({ command: 'status', args: '' });
      expect(result.reply).toContain('*Session cost:* $0.0567');
    });

    it('includes MCP servers with status icons', async () => {
      const result = await fullRouter.execute({ command: 'status', args: '' });
      expect(result.reply).toContain('*MCP servers:*');
      expect(result.reply).toContain('filesystem \u2714');
      expect(result.reply).toContain('slack \u25B3');
    });

    it('includes plugins', async () => {
      const result = await fullRouter.execute({ command: 'status', args: '' });
      expect(result.reply).toContain('*Plugins:* superpowers, pr-review');
    });

    it('shows Running (background) when execution is backgrounded', async () => {
      const bgRouter = new BotCommandRouter({
        logger: logger as any,
        configOverrides,
        config,
        getCurrentExecution: () => ({ ...testExecution, isBackground: true }),
        getSessionCost: () => Promise.resolve(0),
      });
      const result = await bgRouter.execute({ command: 'status', args: '' });
      expect(result.reply).toContain('*Status:* Running (background)');
    });

    it('shows Interrupted when execution is interrupted', async () => {
      const intRouter = new BotCommandRouter({
        logger: logger as any,
        configOverrides,
        config,
        getCurrentExecution: () => ({ ...testExecution, interrupted: true }),
        getSessionCost: () => Promise.resolve(0),
      });
      const result = await intRouter.execute({ command: 'status', args: '' });
      expect(result.reply).toContain('*Status:* Interrupted');
    });

    it('omits MCP servers section when empty', async () => {
      const noMcpRouter = new BotCommandRouter({
        logger: logger as any,
        configOverrides,
        config,
        getInitInfo: () => ({ ...testInitInfo, mcpServers: [] }),
        getSessionCost: () => Promise.resolve(0),
      });
      const result = await noMcpRouter.execute({ command: 'status', args: '' });
      expect(result.reply).not.toContain('*MCP servers:*');
    });

    it('omits plugins section when empty', async () => {
      const noPluginsRouter = new BotCommandRouter({
        logger: logger as any,
        configOverrides,
        config,
        getInitInfo: () => ({ ...testInitInfo, plugins: [] }),
        getSessionCost: () => Promise.resolve(0),
      });
      const result = await noPluginsRouter.execute({ command: 'status', args: '' });
      expect(result.reply).not.toContain('*Plugins:*');
    });

    it('omits session cost when zero', async () => {
      const noCostRouter = new BotCommandRouter({
        logger: logger as any,
        configOverrides,
        config,
        getSessionCost: () => Promise.resolve(0),
      });
      const result = await noCostRouter.execute({ command: 'status', args: '' });
      expect(result.reply).not.toContain('*Session cost:*');
    });
  });

  // ── execute — clear command ───────────────────────────────────────

  describe('execute() — clear', () => {
    it('resets overrides and returns handled with clearSession flag', async () => {
      configOverrides.setModel('claude-opus-4-6');
      configOverrides.setEffort('max');
      const result = await router.execute({ command: 'clear', args: '' });
      expect(result.type).toBe('handled');
      expect(result.clearSession).toBe(true);
      expect(configOverrides.getModel()).toBeUndefined();
      expect(configOverrides.getEffort()).toBeUndefined();
    });
  });

  // ── execute — unknown command ─────────────────────────────────────

  describe('execute() — unknown command', () => {
    it('returns dispatch for unknown commands', async () => {
      const result = await router.execute({ command: 'foobar', args: 'baz' });
      expect(result.type).toBe('dispatch');
    });
  });

  // ── execute — no-arg commands with args → dispatch ────────────────

  describe('no-arg commands with args', () => {
    it('returns dispatch when status has unexpected args', async () => {
      const result = await router.execute({ command: 'status', args: 'extra stuff' });
      expect(result.type).toBe('dispatch');
    });

    it('returns dispatch when help has unexpected args', async () => {
      const result = await router.execute({ command: 'help', args: 'some question' });
      expect(result.type).toBe('dispatch');
    });
  });

  // ── registering custom commands ───────────────────────────────────

  describe('registerCommand()', () => {
    it('allows registering custom command handlers', async () => {
      router.registerCommand('ping', async (_args) => ({
        type: 'handled' as const,
        reply: 'pong',
      }));

      const result = await router.execute({ command: 'ping', args: '' });
      expect(result.type).toBe('handled');
      expect(result.reply).toBe('pong');
    });
  });
});
