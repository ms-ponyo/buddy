// src/ui/plan-blocks.ts — Pure Slack Block Kit builders for plan review prompts.
// Extracted from src/slack-handler/hooks/sdk-hooks.ts (ExitPlanMode handler).
// No state, no adapter dependency.

import { formatPlanAsMarkdownBlocks } from '../util/format.js';

// ── Plan review block builder ────────────────────────────────────────

export interface PlanReviewBlocksInput {
  planContent: string;
  callbackId: string;
}

export interface PlanReviewBlocksOutput {
  text: string;
  blocks: object[];
  /** When the total block count exceeds 50, the blocks are split across messages. */
  splitMessages?: object[][];
}

/**
 * Build Slack blocks for a plan review prompt.
 * Returns header, plan content (as markdown blocks), divider, and approve/reject buttons.
 * When the total block count exceeds 50, splits into separate messages.
 */
export function buildPlanReviewBlocks(input: PlanReviewBlocksInput): PlanReviewBlocksOutput {
  const { planContent, callbackId } = input;

  const planBlocks = formatPlanAsMarkdownBlocks(planContent);

  const headerBlock = {
    type: 'header',
    text: { type: 'plain_text', text: ':clipboard: Plan for Review' },
  };

  const actionButtons = {
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '\u2713 Approve' },
        action_id: `${callbackId}_approve`,
        value: 'approve',
        style: 'primary',
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '\u2717 Reject' },
        action_id: `${callbackId}_reject`,
        value: 'reject',
        style: 'danger',
      },
    ],
  };

  const allBlocks = [headerBlock, ...planBlocks, { type: 'divider' }, actionButtons];

  if (allBlocks.length > 50) {
    // Split: plan content in one message, buttons in another
    const planOnlyBlocks = [headerBlock, ...planBlocks].slice(0, 50);
    const buttonBlocks = [{ type: 'divider' }, actionButtons];

    return {
      text: 'Plan for review',
      blocks: allBlocks,
      splitMessages: [planOnlyBlocks, buttonBlocks],
    };
  }

  return {
    text: 'Plan for review',
    blocks: allBlocks,
  };
}
