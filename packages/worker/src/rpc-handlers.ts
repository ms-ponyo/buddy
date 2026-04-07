// src/rpc-handlers.ts — Testable RPC handler implementations for the worker.
// Extracted so tests can import and exercise them without the side-effect-heavy index.ts.

import type { WorkerContext } from './context.js';

// ── Handler context ───────────────────────────────────────────────
//
// A minimal subset of WorkerContext that the handlers depend on.
// Using Pick keeps the types precise and allows lightweight mocks in tests.

export type RpcHandlerContext = Pick<
  WorkerContext,
  'workerLoop' | 'configOverrides' | 'claudeSession'
>;

export type HandlerFn = (params: Record<string, unknown>) => unknown;
export type RegisterFn = (method: string, handler: HandlerFn) => void;

// ── registerWorkerControlHandlers ─────────────────────────────────

/**
 * Registers the lite-worker-control RPC methods onto any register function.
 * The `register` callback is called once per method with (methodName, handlerFn).
 *
 * @param getCtx  Accessor for the current WorkerContext (may return undefined when idle).
 * @param register  Callback that installs the handler — maps to RpcServer.registerMethod.
 */
export function registerWorkerControlHandlers(
  getCtx: () => RpcHandlerContext | undefined,
  register: RegisterFn,
): void {
  // worker.getStatus — snapshot of the worker's current state
  register('worker.getStatus', () => {
    const ctx = getCtx();
    if (!ctx) {
      return {
        hasActiveExecution: false,
        model: null,
        mode: null,
        effort: null,
        budget: null,
  
        agent: null,
        systemPromptAppend: null,
        projectDir: null,
        isBackground: false,
        sessionId: null,
      };
    }
    const exec = ctx.workerLoop.currentExecution;
    return {
      hasActiveExecution: exec !== null,
      model: ctx.configOverrides.getModel() ?? null,
      mode: ctx.configOverrides.getPermissionMode() ?? null,
      effort: ctx.configOverrides.getEffort() ?? null,
      budget: ctx.configOverrides.getBudget() ?? null,

      agent: ctx.configOverrides.getAgent() ?? null,
      systemPromptAppend: ctx.configOverrides.getSystemPromptAppend() ?? null,
      projectDir: ctx.configOverrides.getProjectDir() ?? null,
      isBackground: exec?.isBackground ?? false,
      sessionId: ctx.claudeSession.getSessionId() ?? null,
    };
  });

  // worker.switchModel — override the model used for the next execution
  register('worker.switchModel', (params) => {
    const { model } = params as { model: string };
    getCtx()?.configOverrides.setModel(model);
    return { ok: true };
  });

  // worker.switchMode — override the permission mode; also applies to active query
  register('worker.switchMode', (params) => {
    const { mode } = params as { mode: string };
    const ctx = getCtx();
    if (ctx) {
      ctx.configOverrides.setPermissionMode(mode as any);
      if (ctx.claudeSession.hasActiveQuery()) {
        ctx.claudeSession.setPermissionMode(mode);
      }
    }
    return { ok: true };
  });

  // worker.sendToBackground — mark the current execution as a background task
  register('worker.sendToBackground', () => {
    const ctx = getCtx();
    if (ctx?.workerLoop.currentExecution) {
      ctx.workerLoop.currentExecution.isBackground = true;
    }
    return { ok: true };
  });

  // worker.forkThread — stub; full fork implementation is deferred
  register('worker.forkThread', (_params) => {
    return { ok: true, newThreadTs: null, permalink: null };
  });

  // worker.getInitInfo — delegates to claudeSession
  register('worker.getInitInfo', () => {
    return getCtx()?.claudeSession.getInitInfo() ?? null;
  });

  // worker.getAccountInfo — delegates to claudeSession
  register('worker.getAccountInfo', () => {
    return getCtx()?.claudeSession.getAccountInfo() ?? null;
  });

  // worker.switchEffort — override the thinking effort level
  register('worker.switchEffort', (params) => {
    const { effort } = params as { effort: string };
    getCtx()?.configOverrides.setEffort(effort as any);
    return { ok: true };
  });

  // worker.switchProject — override the project directory
  register('worker.switchProject', (params) => {
    const { dir } = params as { dir: string };
    getCtx()?.configOverrides.setProjectDir(dir);
    return { ok: true };
  });

  // worker.switchBudget — override the token budget (null clears the override)
  register('worker.switchBudget', (params) => {
    const { budget } = params as { budget: number | null };
    const ctx = getCtx();
    if (ctx) {
      if (budget === null) {
        ctx.configOverrides.setBudget(undefined as any);
      } else {
        ctx.configOverrides.setBudget(budget);
      }
    }
    return { ok: true };
  });
}
