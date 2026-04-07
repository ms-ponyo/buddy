// src/hooks/pre-tool-use.ts — PreToolUse hook factory.
// Plan workflow gates: EnterPlanMode, plan file tracking, ExitPlanMode review.

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { HookCallback, HookCallbackMatcher, SyncHookJSONOutput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from '../logger.js';
import type { PermissionManager } from '../services/permission-manager.js';
import type { PersistenceAdapter } from '../adapters/persistence-adapter.js';
import type { ThreadPermissionMode } from '../types.js';

// ── Dependencies ──────────────────────────────────────────────────

/** Shared mutable state that survives across runSession() restarts. */
export interface PreToolUseSharedState {
  /** Last known plan file path — persists across stop/restart within the same worker. */
  trackedPlanFilePath?: string;
}

export interface PreToolUseHookDeps {
  permissions: PermissionManager;
  logger: Logger;
  channel: string;
  threadTs: string;
  /** Project directory — used to discover plan files after session restart. */
  projectDir?: string;
  /** Shared state that persists across session restarts within the same worker. */
  sharedState: PreToolUseSharedState;
  /** Persistence adapter — used to recover plan file path after full process restart. */
  persistence?: PersistenceAdapter;
  /** Sync permission mode to both configOverrides and the SDK session. */
  onPermissionModeChange: (mode: ThreadPermissionMode) => void;
}

// ── Plan file path regex ──────────────────────────────────────────

const PLAN_DIR_RE = /[/\\]plans?[/\\]/;

// ── Helpers ───────────────────────────────────────────────────────

function allow(toolInput: Record<string, unknown>): SyncHookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: 'allow' as const,
      updatedInput: toolInput,
    },
  };
}

function deny(reason: string): SyncHookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: 'deny' as const,
      permissionDecisionReason: reason,
    },
  };
}

function passthrough(): SyncHookJSONOutput {
  return {};
}

/**
 * Find the most recently modified .md file in the .claude/plans/ directory.
 * Returns undefined if the directory doesn't exist or is empty.
 */
async function findLatestPlanFile(projectDir: string): Promise<string | undefined> {
  const plansDir = path.join(projectDir, '.claude', 'plans');
  let entries: string[];
  try {
    entries = await readdir(plansDir);
  } catch {
    return undefined;
  }
  const mdFiles = entries.filter(e => e.endsWith('.md'));
  if (mdFiles.length === 0) return undefined;

  let latest: { file: string; mtime: number } | undefined;
  for (const file of mdFiles) {
    const fullPath = path.join(plansDir, file);
    try {
      const s = await stat(fullPath);
      if (!latest || s.mtimeMs > latest.mtime) {
        latest = { file: fullPath, mtime: s.mtimeMs };
      }
    } catch {
      // skip unreadable files
    }
  }
  return latest?.file;
}

// ── Factory ───────────────────────────────────────────────────────

/**
 * Create a PreToolUse hook matching the SDK's HookCallback signature.
 * Returns a HookCallbackMatcher[] suitable for the `hooks.PreToolUse` option.
 */
export function createPreToolUseHook(deps: PreToolUseHookDeps): HookCallbackMatcher[] {
  const {
    permissions,
    logger,
    channel,
    threadTs,
    projectDir,
    sharedState,
    persistence,
    onPermissionModeChange,
  } = deps;

  const hookFn: HookCallback = async (input, toolUseID, _options) => {
    const { tool_name: toolName, tool_input } = input as PreToolUseHookInput;
    const toolInput = (tool_input ?? {}) as Record<string, unknown>;
    const toolUseId = toolUseID ?? (input as PreToolUseHookInput).tool_use_id;

    // ── EnterPlanMode: auto-allow + switch permission mode ──────
    if (toolName === 'EnterPlanMode') {
      logger.info('EnterPlanMode intercepted via hook');
      onPermissionModeChange('plan');
      return allow(toolInput);
    }

    // ── Write/Edit: track plan file path ───────────────────────
    if (toolName === 'Write' || toolName === 'Edit') {
      const filePath = toolInput.file_path;
      if (
        typeof filePath === 'string' &&
        PLAN_DIR_RE.test(filePath) &&
        filePath.endsWith('.md')
      ) {
        logger.info('Plan file write/edit detected', { path: filePath, tool: toolName });
        sharedState.trackedPlanFilePath = filePath;
        // Persist to DB so the path survives full process restarts
        persistence?.setPlanFilePath(channel, threadTs, filePath).catch((err) => {
          logger.warn('Failed to persist plan file path', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }

    // ── ExitPlanMode: trigger plan review ──────────────────────
    if (toolName === 'ExitPlanMode') {
      logger.info('ExitPlanMode intercepted via PreToolUse hook', {
        trackedPath: sharedState.trackedPlanFilePath ?? '(none)',
        projectDir: projectDir ?? '(none)',
      });

      // Resolve the plan file path — try these sources in order:
      // 1. In-memory shared state (survives stop+restart within same process)
      // 2. Persisted DB record (survives full process restart)
      // 3. Disk scan of .claude/plans/ (last resort fallback)
      let planFilePath = sharedState.trackedPlanFilePath;
      if (!planFilePath && persistence) {
        try {
          planFilePath = await persistence.getPlanFilePath(channel, threadTs);
          if (planFilePath) {
            logger.info('Recovered plan file path from persistence', { path: planFilePath });
            sharedState.trackedPlanFilePath = planFilePath;
          }
        } catch (err) {
          logger.warn('Failed to load plan file path from persistence', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (!planFilePath && projectDir) {
        planFilePath = await findLatestPlanFile(projectDir);
        if (planFilePath) {
          logger.info('Discovered plan file from disk scan (no tracked path)', { path: planFilePath });
          sharedState.trackedPlanFilePath = planFilePath;
        }
      }

      let planContent = '_No plan file found._';
      if (planFilePath) {
        try {
          planContent = await readFile(planFilePath, 'utf-8');
        } catch (err) {
          logger.warn('Failed to read plan file from disk', {
            path: planFilePath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        logger.warn('No plan file found — tracked path and disk scan both empty');
      }

      // The SDK passes an AbortSignal as the 3rd argument to callback hooks.
      // Race the plan review against the signal so an SDK timeout triggers a
      // clean deny instead of hanging forever and falling through to canUseTool.
      const signal = (_options as { signal?: AbortSignal } | undefined)?.signal;
      const reviewPromise = permissions.requestPlanReview(planContent, toolUseId);

      let reviewResult: { approved: boolean; feedback?: string };
      try {
        if (signal) {
          reviewResult = await Promise.race([
            reviewPromise,
            new Promise<never>((_, reject) => {
              if (signal.aborted) {
                reject(signal.reason ?? new Error('Hook aborted'));
                return;
              }
              signal.addEventListener('abort', () => {
                reject(signal.reason ?? new Error('Hook aborted'));
              }, { once: true });
            }),
          ]);
        } else {
          reviewResult = await reviewPromise;
        }
      } catch (err) {
        // SDK timeout or abort — stay in plan mode so the model can retry
        logger.warn('Plan review aborted (SDK timeout or signal)', {
          error: err instanceof Error ? err.message : String(err),
        });
        return deny('Plan review timed out — please revise the plan and try again');
      }

      if (reviewResult.approved) {
        // Plan approved — switch to acceptEdits so implementation can proceed
        // without prompting for every file write
        onPermissionModeChange('acceptEdits');
        return allow(toolInput);
      }

      // Rejected — stay in plan mode so the model can revise
      const feedback = reviewResult.feedback
        ? `Plan rejected: ${reviewResult.feedback}`
        : 'Plan rejected by user';
      return deny(feedback);
    }

    // ── Default: pass through to canUseTool ─────────────────────
    return passthrough();
  };

  return [{ hooks: [hookFn] }];
}
