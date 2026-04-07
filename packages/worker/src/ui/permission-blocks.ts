// src/ui/permission-blocks.ts — Pure Slack Block Kit builders for permission prompts.
// Extracted from src/slack-handler/hooks/can-use-tool.ts.
// No state, no adapter dependency.

import type { ToolRisk } from '../types.js';

// ── Risk classification helpers ──────────────────────────────────────

export function classifyToolRisk(toolName: string, input: Record<string, unknown>): ToolRisk {
  if (toolName === 'Bash' && typeof input.command === 'string') {
    const cmd = input.command;
    if (/\brm\s+-rf\b|--force\b|git\s+push\s+--force|git\s+reset\s+--hard|\bsudo\b|\bchown\b|\bchmod\s+[0-7]*7[0-7]*\b|\bmkfs\b|\bdd\b\s+|\bkill\s+-9\b|curl\b.*\|\s*(ba)?sh|wget\b.*\|\s*(ba)?sh/.test(cmd)) {
      return 'destructive';
    }
  }
  if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob' || toolName === 'WebFetch' || toolName === 'WebSearch') {
    return 'info';
  }
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'Bash' || toolName === 'NotebookEdit') {
    return 'moderate';
  }
  return 'moderate';
}

export function riskEmoji(risk: ToolRisk): string {
  switch (risk) {
    case 'destructive': return ':rotating_light:';
    case 'moderate': return ':wrench:';
    case 'info': return ':mag:';
  }
}

export function shouldPreview(risk: ToolRisk, previewMode: 'off' | 'destructive' | 'moderate'): boolean {
  if (previewMode === 'off') return false;
  if (previewMode === 'destructive') return risk === 'destructive';
  // "moderate" — preview moderate and destructive
  return risk === 'moderate' || risk === 'destructive';
}

// ── Permission block builder ─────────────────────────────────────────

export interface PermissionBlocksInput {
  toolName: string;
  lockText: string;
  callbackId: string;
  /** @deprecated "Always" button is now rendered by the gateway using SDK suggestions. */
  includeAlwaysAllow?: boolean;
}

export interface PermissionBlocksOutput {
  text: string;
  blocks: object[];
}

/**
 * Build Slack blocks for a permission prompt.
 * Returns the fallback text and block array ready for posting.
 */
export function buildPermissionBlocks(input: PermissionBlocksInput): PermissionBlocksOutput {
  const { toolName, lockText, callbackId, includeAlwaysAllow } = input;

  const buttons: object[] = [
    {
      type: 'button',
      text: { type: 'plain_text', text: '\u2713 Allow' },
      action_id: 'permission_approve',
      value: callbackId,
      style: 'primary',
    },
    {
      type: 'button',
      text: { type: 'plain_text', text: '\u2717 Deny' },
      action_id: 'permission_deny',
      value: callbackId,
      style: 'danger',
    },
  ];

  if (includeAlwaysAllow) {
    // Insert "Always" between Allow and Deny
    buttons.splice(1, 0, {
      type: 'button',
      text: { type: 'plain_text', text: '\u2713 Always' },
      action_id: 'permission_always_allow',
      value: callbackId,
    });
  }

  const blocks: object[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:lock: ${lockText}`,
      },
    },
    { type: 'actions', elements: buttons },
  ];

  return {
    text: `Permission: ${toolName}`,
    blocks,
  };
}
