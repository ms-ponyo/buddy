// tests/unit/rpc-methods.test.ts — Unit tests for the worker control RPC handlers.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { registerWorkerControlHandlers } from '../../src/rpc-handlers';
import type { RpcHandlerContext } from '../../src/rpc-handlers';

// ── Helpers ───────────────────────────────────────────────────────

/** Build a mock context. currentExecution is null by default (idle worker). */
function makeMockCtx(execOverrides?: Record<string, unknown>): RpcHandlerContext {
  return {
    workerLoop: {
      currentExecution: execOverrides
        ? { isBackground: false, ...execOverrides }
        : null,
    } as any,
    configOverrides: {
      getModel: jest.fn<() => string | undefined>().mockReturnValue(undefined),
      getPermissionMode: jest.fn<() => string | undefined>().mockReturnValue(undefined),
      getEffort: jest.fn<() => string | undefined>().mockReturnValue(undefined),
      getBudget: jest.fn<() => number | undefined>().mockReturnValue(undefined),
      getAgent: jest.fn<() => string | undefined>().mockReturnValue(undefined),
      getSystemPromptAppend: jest.fn<() => string | undefined>().mockReturnValue(undefined),
      getProjectDir: jest.fn<() => string | undefined>().mockReturnValue(undefined),
      setModel: jest.fn<(m: string) => void>(),
      setPermissionMode: jest.fn<(m: any) => void>(),
      setEffort: jest.fn<(e: any) => void>(),
      setBudget: jest.fn<(b: any) => void>(),
      setProjectDir: jest.fn<(d: string) => void>(),
    } as any,
    claudeSession: {
      getSessionId: jest.fn<() => string | undefined>().mockReturnValue(undefined),
      getInitInfo: jest.fn<() => object | null>().mockReturnValue(null),
      getAccountInfo: jest.fn<() => object | null>().mockReturnValue(null),
      hasActiveQuery: jest.fn<() => boolean>().mockReturnValue(false),
      setPermissionMode: jest.fn<(m: string) => void>(),
    } as any,
  };
}

/** Register all handlers into a plain Map for easy retrieval in tests. */
function buildHandlers(ctx: RpcHandlerContext | undefined) {
  const map = new Map<string, (params: Record<string, unknown>) => unknown>();
  registerWorkerControlHandlers(
    () => ctx,
    (method, handler) => map.set(method, handler),
  );
  return map;
}

// ── Tests ─────────────────────────────────────────────────────────

describe('worker RPC handlers', () => {
  // ── worker.getStatus ────────────────────────────────────────────

  describe('worker.getStatus', () => {
    it('returns idle snapshot when ctx is undefined', () => {
      const handlers = buildHandlers(undefined);
      const result = handlers.get('worker.getStatus')!({}) as any;
      expect(result.hasActiveExecution).toBe(false);
      expect(result.model).toBeNull();
      expect(result.sessionId).toBeNull();
      expect(result.isBackground).toBe(false);
    });

    it('returns idle snapshot when currentExecution is null', () => {
      const ctx = makeMockCtx(); // currentExecution is null
      (ctx.configOverrides.getModel as jest.Mock).mockReturnValue('sonnet');
      (ctx.claudeSession.getSessionId as jest.Mock).mockReturnValue('sess-1');
      const handlers = buildHandlers(ctx);
      const result = handlers.get('worker.getStatus')!({}) as any;
      expect(result.hasActiveExecution).toBe(false);
      expect(result.model).toBe('sonnet');
      expect(result.sessionId).toBe('sess-1');
    });

    it('returns active snapshot when currentExecution is set', () => {
      const ctx = makeMockCtx({ isBackground: false });
      (ctx.configOverrides.getModel as jest.Mock).mockReturnValue('opus');
      (ctx.configOverrides.getPermissionMode as jest.Mock).mockReturnValue('acceptEdits');
      (ctx.configOverrides.getEffort as jest.Mock).mockReturnValue('high');
      (ctx.configOverrides.getBudget as jest.Mock).mockReturnValue(5);
      (ctx.claudeSession.getSessionId as jest.Mock).mockReturnValue('sess-abc');
      const handlers = buildHandlers(ctx);
      const result = handlers.get('worker.getStatus')!({}) as any;
      expect(result.hasActiveExecution).toBe(true);
      expect(result.model).toBe('opus');
      expect(result.mode).toBe('acceptEdits');
      expect(result.effort).toBe('high');
      expect(result.budget).toBe(5);
      expect(result.isBackground).toBe(false);
      expect(result.sessionId).toBe('sess-abc');
    });

    it('reflects isBackground flag from currentExecution', () => {
      const ctx = makeMockCtx({ isBackground: true });
      const handlers = buildHandlers(ctx);
      const result = handlers.get('worker.getStatus')!({}) as any;
      expect(result.isBackground).toBe(true);
    });
  });

  // ── worker.switchModel ──────────────────────────────────────────

  describe('worker.switchModel', () => {
    it('calls configOverrides.setModel with the given model', () => {
      const ctx = makeMockCtx();
      const handlers = buildHandlers(ctx);
      const result = handlers.get('worker.switchModel')!({ model: 'claude-opus-4-6' });
      expect(result).toEqual({ ok: true });
      expect(ctx.configOverrides.setModel).toHaveBeenCalledWith('claude-opus-4-6');
    });

    it('is a no-op when ctx is undefined', () => {
      const handlers = buildHandlers(undefined);
      expect(() => handlers.get('worker.switchModel')!({ model: 'x' })).not.toThrow();
    });
  });

  // ── worker.switchMode ───────────────────────────────────────────

  describe('worker.switchMode', () => {
    it('calls configOverrides.setPermissionMode', () => {
      const ctx = makeMockCtx();
      const handlers = buildHandlers(ctx);
      const result = handlers.get('worker.switchMode')!({ mode: 'bypassPermissions' });
      expect(result).toEqual({ ok: true });
      expect(ctx.configOverrides.setPermissionMode).toHaveBeenCalledWith('bypassPermissions');
    });

    it('does not call claudeSession.setPermissionMode when no active query', () => {
      const ctx = makeMockCtx();
      (ctx.claudeSession.hasActiveQuery as jest.Mock).mockReturnValue(false);
      const handlers = buildHandlers(ctx);
      handlers.get('worker.switchMode')!({ mode: 'plan' });
      expect(ctx.claudeSession.setPermissionMode).not.toHaveBeenCalled();
    });

    it('also calls claudeSession.setPermissionMode when there is an active query', () => {
      const ctx = makeMockCtx();
      (ctx.claudeSession.hasActiveQuery as jest.Mock).mockReturnValue(true);
      const handlers = buildHandlers(ctx);
      handlers.get('worker.switchMode')!({ mode: 'plan' });
      expect(ctx.claudeSession.setPermissionMode).toHaveBeenCalledWith('plan');
    });
  });

  // ── worker.sendToBackground ─────────────────────────────────────

  describe('worker.sendToBackground', () => {
    it('sets isBackground to true on currentExecution', () => {
      const ctx = makeMockCtx({ isBackground: false });
      const handlers = buildHandlers(ctx);
      const result = handlers.get('worker.sendToBackground')!({});
      expect(result).toEqual({ ok: true });
      expect(ctx.workerLoop.currentExecution!.isBackground).toBe(true);
    });

    it('is a no-op when currentExecution is null', () => {
      const ctx = makeMockCtx(); // currentExecution === null
      const handlers = buildHandlers(ctx);
      expect(() => handlers.get('worker.sendToBackground')!({})).not.toThrow();
    });
  });

  // ── worker.forkThread ───────────────────────────────────────────

  describe('worker.forkThread', () => {
    it('returns the stub response', () => {
      const ctx = makeMockCtx();
      const handlers = buildHandlers(ctx);
      const result = handlers.get('worker.forkThread')!({ prompt: 'do stuff' });
      expect(result).toEqual({ ok: true, newThreadTs: null, permalink: null });
    });
  });

  // ── worker.getInitInfo ──────────────────────────────────────────

  describe('worker.getInitInfo', () => {
    it('delegates to claudeSession.getInitInfo', () => {
      const ctx = makeMockCtx();
      const info = { claudeCodeVersion: '1.2.3', cwd: '/tmp', model: 'sonnet', permissionMode: 'default', mcpServers: [], plugins: [] };
      (ctx.claudeSession.getInitInfo as jest.Mock).mockReturnValue(info);
      const handlers = buildHandlers(ctx);
      const result = handlers.get('worker.getInitInfo')!({});
      expect(result).toBe(info);
    });

    it('returns null when ctx is undefined', () => {
      const handlers = buildHandlers(undefined);
      expect(handlers.get('worker.getInitInfo')!({})).toBeNull();
    });

    it('returns null when initInfo is not yet cached', () => {
      const ctx = makeMockCtx();
      (ctx.claudeSession.getInitInfo as jest.Mock).mockReturnValue(null);
      const handlers = buildHandlers(ctx);
      expect(handlers.get('worker.getInitInfo')!({})).toBeNull();
    });
  });

  // ── worker.getAccountInfo ───────────────────────────────────────

  describe('worker.getAccountInfo', () => {
    it('delegates to claudeSession.getAccountInfo', () => {
      const ctx = makeMockCtx();
      const accountInfo = { email: 'user@example.com' };
      (ctx.claudeSession.getAccountInfo as jest.Mock).mockReturnValue(accountInfo);
      const handlers = buildHandlers(ctx);
      const result = handlers.get('worker.getAccountInfo')!({});
      expect(result).toBe(accountInfo);
    });

    it('returns null when ctx is undefined', () => {
      const handlers = buildHandlers(undefined);
      expect(handlers.get('worker.getAccountInfo')!({})).toBeNull();
    });
  });

  // ── worker.switchEffort ─────────────────────────────────────────

  describe('worker.switchEffort', () => {
    it('calls configOverrides.setEffort with the given effort', () => {
      const ctx = makeMockCtx();
      const handlers = buildHandlers(ctx);
      const result = handlers.get('worker.switchEffort')!({ effort: 'max' });
      expect(result).toEqual({ ok: true });
      expect(ctx.configOverrides.setEffort).toHaveBeenCalledWith('max');
    });
  });

  // ── worker.switchBudget ─────────────────────────────────────────

  describe('worker.switchBudget', () => {
    it('calls configOverrides.setBudget with a numeric budget', () => {
      const ctx = makeMockCtx();
      const handlers = buildHandlers(ctx);
      const result = handlers.get('worker.switchBudget')!({ budget: 10 });
      expect(result).toEqual({ ok: true });
      expect(ctx.configOverrides.setBudget).toHaveBeenCalledWith(10);
    });

    it('calls configOverrides.setBudget with undefined when budget is null', () => {
      const ctx = makeMockCtx();
      const handlers = buildHandlers(ctx);
      const result = handlers.get('worker.switchBudget')!({ budget: null });
      expect(result).toEqual({ ok: true });
      expect(ctx.configOverrides.setBudget).toHaveBeenCalledWith(undefined);
    });
  });
});
