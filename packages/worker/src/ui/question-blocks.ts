// src/ui/question-blocks.ts — Pure Slack Block Kit builders for AskUserQuestion prompts.
// Extracted from src/slack-handler/hooks/can-use-tool.ts (postAskUserQuestionButtons).
// No state, no adapter dependency.

import type { AskUserQuestionItem } from '../types.js';

// ── Question block builder ───────────────────────────────────────────

export interface QuestionBlocksInput {
  requestId: string;
  questions: AskUserQuestionItem[];
}

export interface QuestionBlocksOutput {
  text: string;
  blocks: object[];
}

/**
 * Build Slack blocks for an AskUserQuestion prompt.
 * Only the first question is rendered (one question per message).
 * Uses radio buttons for options instead of individual buttons.
 */
export function buildQuestionBlocks(input: QuestionBlocksInput): QuestionBlocksOutput {
  const { requestId, questions } = input;

  const blocks: object[] = [];

  if (questions.length === 0) {
    return { text: 'Claude has a question for you', blocks };
  }

  // Only render the first question (one per message)
  const q = questions[0];

  // Question header + text
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*${q.header}*\n${q.question}` },
  });

  // Radio buttons (or checkboxes if multiSelect) for options
  const slackOptions = q.options.map((opt, oi) => {
    const option: Record<string, unknown> = {
      text: { type: 'plain_text', text: opt.label },
      value: `${requestId}:0:${oi}`,
    };
    if (opt.description) {
      option.description = { type: 'plain_text', text: opt.description };
    }
    return option;
  });
  const elementType = q.multiSelect ? 'checkboxes' : 'radio_buttons';
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: elementType,
        action_id: `question_answer_0`,
        options: slackOptions,
      },
    ],
  });

  // Option previews (code snippets, mockups) as markdown blocks
  const previews = q.options.filter((opt) => opt.preview);
  if (previews.length > 0) {
    blocks.push({ type: 'divider' });
    for (const opt of previews) {
      blocks.push({
        type: 'markdown',
        text: `**${opt.label}**\n${opt.preview}`,
      });
    }
  }

  // Inline text input for custom answers
  blocks.push({
    type: 'input',
    dispatch_action: true,
    block_id: `question_input_${requestId}_0`,
    element: {
      type: 'plain_text_input',
      action_id: `question_text_input_0`,
      placeholder: { type: 'plain_text', text: 'Or type your answer and press Enter\u2026' },
      dispatch_action_config: { trigger_actions_on: ['on_enter_pressed'] },
    },
    label: { type: 'plain_text', text: ' ' },
    optional: true,
  });

  return {
    text: 'Claude has a question for you',
    blocks,
  };
}
