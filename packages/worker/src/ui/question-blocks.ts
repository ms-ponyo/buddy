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
 * Each question gets a section, action buttons for each option,
 * and a text input for custom answers.
 */
export function buildQuestionBlocks(input: QuestionBlocksInput): QuestionBlocksOutput {
  const { requestId, questions } = input;

  const blocks: object[] = [];

  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi];

    // Question header + text
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${q.header}*\n${q.question}` },
    });

    // Option buttons
    const buttons: object[] = q.options.map((opt, oi) => ({
      type: 'button',
      text: { type: 'plain_text', text: opt.label.slice(0, 75) },
      action_id: `question_answer_${qi}_${oi}`,
      value: `${requestId}:${qi}:${oi}`,
    }));
    blocks.push({ type: 'actions', elements: buttons });

    // Inline text input for custom answers
    blocks.push({
      type: 'input',
      dispatch_action: true,
      block_id: `question_input_${requestId}_${qi}`,
      element: {
        type: 'plain_text_input',
        action_id: `question_text_input_${qi}`,
        placeholder: { type: 'plain_text', text: 'Or type your answer and press Enter\u2026' },
        dispatch_action_config: { trigger_actions_on: ['on_enter_pressed'] },
      },
      label: { type: 'plain_text', text: ' ' },
      optional: true,
    });
  }

  return {
    text: 'Claude has a question for you',
    blocks,
  };
}
