// src/hooks/pre-tool-use.ts — PreToolUse hook factory.
// Intercepts tool calls before execution: interactive bridge, plan mode tracking.
// Ported from src/slack-handler/hooks/sdk-hooks.ts.

import type { HookCallback, HookCallbackMatcher, SyncHookJSONOutput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from '../logger.js';
import type { InteractiveBridge } from '../services/interactive-bridge.js';
import type { PermissionManager } from '../services/permission-manager.js';
import type { ConfigOverrides } from '../services/config-overrides.js';

// ── Dependencies ──────────────────────────────────────────────────

export interface PreToolUseHookDeps {
  bridge: InteractiveBridge;
  permissions: PermissionManager;
  configOverrides: ConfigOverrides;
  logger: Logger;
  channel: string;
  threadTs: string;
  /** Interactive bridge pattern strings (e.g. ["ssh", "gh auth login"]). */
  interactivePatterns: string[];
}

// ── Plan file path regex ──────────────────────────────────────────

const PLAN_DIR_RE = /[/\\]plans?[/\\]/;

// ── Helpers ───────────────────────────────────────────────────────

function allow(toolInput: Record<string, unknown>): SyncHookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
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

// ── Factory ───────────────────────────────────────────────────────

/**
 * Create a PreToolUse hook matching the SDK's HookCallback signature.
 * Returns a HookCallbackMatcher[] suitable for the `hooks.PreToolUse` option.
 */
export function createPreToolUseHook(deps: PreToolUseHookDeps): HookCallbackMatcher[] {
  const {
    bridge,
    permissions,
    configOverrides,
    logger,
    channel,
    threadTs,
    interactivePatterns,
  } = deps;

  // Track the last plan file path written during this session
  let trackedPlanFilePath: string | undefined;
  let trackedPlanContent: string | undefined;

  const hookFn: HookCallback = async (input, toolUseID, _options) => {
    const { tool_name: toolName, tool_input } = input as PreToolUseHookInput;
    const toolInput = (tool_input ?? {}) as Record<string, unknown>;
    const toolUseId = toolUseID ?? (input as PreToolUseHookInput).tool_use_id;

    // ── Bash: interactive bridge detection ──────────────────────
    if (toolName === 'Bash' && typeof toolInput.command === 'string') {
      if (bridge.isInteractiveCommand(toolInput.command, interactivePatterns)) {
        logger.info('Interactive command detected, delegating to bridge', {
          command: toolInput.command,
        });

        const bridgeResult = await bridge.startSession(
          toolUseId,
          toolInput.command,
          channel,
          threadTs,
        );

        const output = bridgeResult.output ?? bridgeResult.error ?? 'Interactive session completed';
        return deny(output);
      }
    }

    // ── EnterPlanMode: auto-allow + switch permission mode ──────
    if (toolName === 'EnterPlanMode') {
      logger.info('EnterPlanMode intercepted via hook');
      configOverrides.setPermissionMode('plan');
      return allow(toolInput);
    }

    // ── Write: track plan file writes ──────────────────────────
    if (toolName === 'Write') {
      const filePath = toolInput.file_path;
      if (
        typeof filePath === 'string' &&
        PLAN_DIR_RE.test(filePath) &&
        filePath.endsWith('.md')
      ) {
        logger.info('Plan file write detected', { path: filePath });
        trackedPlanFilePath = filePath;
        trackedPlanContent = typeof toolInput.content === 'string'
          ? toolInput.content
          : undefined;
      }
    }

    // ── ExitPlanMode: trigger plan review ──────────────────────
    if (toolName === 'ExitPlanMode') {
      logger.info('ExitPlanMode intercepted via PreToolUse hook');

      const planContent = trackedPlanContent ?? '_No plan file found._';
      const reviewResult = await permissions.requestPlanReview(planContent, toolUseId);

      configOverrides.setPermissionMode('default');

      if (reviewResult.approved) {
        return allow(toolInput);
      }

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
