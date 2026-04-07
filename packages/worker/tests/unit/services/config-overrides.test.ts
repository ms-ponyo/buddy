// tests/unit/services/config-overrides.test.ts
import { describe, it, expect, beforeEach } from '@jest/globals';
import { ConfigOverrides } from '../../../src/services/config-overrides';
import type { BuddyConfig } from '../../../src/types';

function makeBaseConfig(overrides: Partial<BuddyConfig> = {}): BuddyConfig {
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
    enabledMcpServers: [],
    plugins: [],
    socketPath: '/tmp/sock',
    persistenceSocket: '/tmp/persist',
    gatewaySocket: '/tmp/gateway',
    ...overrides,
  };
}

describe('ConfigOverrides', () => {
  let co: ConfigOverrides;

  beforeEach(() => {
    co = new ConfigOverrides();
  });

  // ── Model ─────────────────────────────────────────────────────────

  describe('model', () => {
    it('returns undefined when not set', () => {
      expect(co.getModel()).toBeUndefined();
    });

    it('stores and returns model override', () => {
      co.setModel('claude-opus-4-6');
      expect(co.getModel()).toBe('claude-opus-4-6');
    });

    it('can overwrite the model', () => {
      co.setModel('claude-opus-4-6');
      co.setModel('claude-haiku-4-5-20251001');
      expect(co.getModel()).toBe('claude-haiku-4-5-20251001');
    });
  });

  // ── Effort ────────────────────────────────────────────────────────

  describe('effort', () => {
    it('returns undefined when not set', () => {
      expect(co.getEffort()).toBeUndefined();
    });

    it('stores and returns effort override', () => {
      co.setEffort('high');
      expect(co.getEffort()).toBe('high');
    });
  });

  // ── Budget ────────────────────────────────────────────────────────

  describe('budget', () => {
    it('returns undefined when not set', () => {
      expect(co.getBudget()).toBeUndefined();
    });

    it('stores and returns budget override', () => {
      co.setBudget(5.0);
      expect(co.getBudget()).toBe(5.0);
    });
  });

  // ── Permission Mode ───────────────────────────────────────────────

  describe('permissionMode', () => {
    it('returns undefined when not set', () => {
      expect(co.getPermissionMode()).toBeUndefined();
    });

    it('stores and returns permission mode', () => {
      co.setPermissionMode('acceptEdits');
      expect(co.getPermissionMode()).toBe('acceptEdits');
    });

    it('clears override when set to default', () => {
      co.setPermissionMode('acceptEdits');
      co.setPermissionMode('default');
      expect(co.getPermissionMode()).toBeUndefined();
    });
  });

  // ── Reset ─────────────────────────────────────────────────────────

  describe('reset()', () => {
    it('clears all overrides', () => {
      co.setModel('claude-opus-4-6');
      co.setEffort('max');
      co.setBudget(10.0);
      co.setPermissionMode('bypassPermissions');

      co.reset();

      expect(co.getModel()).toBeUndefined();
      expect(co.getEffort()).toBeUndefined();
      expect(co.getBudget()).toBeUndefined();
      expect(co.getPermissionMode()).toBeUndefined();
    });
  });

  // ── resolveConfig ─────────────────────────────────────────────────

  describe('resolveConfig()', () => {
    it('returns base config unchanged when no overrides are set', () => {
      const base = makeBaseConfig();
      const resolved = co.resolveConfig(base);
      expect(resolved.claudeModel).toBe('claude-sonnet-4-6');
      expect(resolved.permissionMode).toBe('default');
    });

    it('applies model override', () => {
      co.setModel('claude-opus-4-6');
      const base = makeBaseConfig();
      const resolved = co.resolveConfig(base);
      expect(resolved.claudeModel).toBe('claude-opus-4-6');
    });

    it('applies permission mode override', () => {
      co.setPermissionMode('bypassPermissions');
      const base = makeBaseConfig();
      const resolved = co.resolveConfig(base);
      expect(resolved.permissionMode).toBe('bypassPermissions');
    });

    it('does not mutate the base config', () => {
      co.setModel('claude-opus-4-6');
      const base = makeBaseConfig();
      co.resolveConfig(base);
      expect(base.claudeModel).toBe('claude-sonnet-4-6');
    });

    it('applies multiple overrides together', () => {
      co.setModel('claude-opus-4-6');
      co.setPermissionMode('plan');
      const base = makeBaseConfig();
      const resolved = co.resolveConfig(base);
      expect(resolved.claudeModel).toBe('claude-opus-4-6');
      expect(resolved.permissionMode).toBe('plan');
    });
  });
});
