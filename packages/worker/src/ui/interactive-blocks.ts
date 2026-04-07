// src/ui/interactive-blocks.ts — Pure Slack Block Kit builders for interactive bridge prompts.
// Extracted from src/slack-handler/hooks/interactive-bridge.ts.
// No state, no adapter dependency.

// ── Text helpers ─────────────────────────────────────────────────────

export function truncateCommand(cmd: string): string {
  return cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd;
}

export function escapeSlackText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Extract deduplicated URLs from text (after ANSI stripping). */
export function extractUrls(text: string): string[] {
  const urlPattern = /https?:\/\/[^\s<>"'`\]\)]+/g;
  const matches = text.match(urlPattern) ?? [];
  // Strip trailing punctuation unlikely to be part of the URL
  const cleaned = matches.map((url) => url.replace(/[.,;:!?]+$/, ''));
  const unique = [...new Set(cleaned)];
  // Filter out URLs that are embedded inside another matched URL
  // (e.g. scope URIs like https://www.googleapis.com/auth/... that appear
  // inside a query parameter of a longer OAuth URL).
  return unique.filter((url) =>
    !unique.some((other) => other !== url && other.includes(url)),
  );
}

/** Build a Slack section block with clickable URL links. Returns null if no URLs found. */
export function buildUrlBlock(text: string): object | null {
  const urls = extractUrls(text);
  if (urls.length === 0) return null;
  const linkLines = urls.map((url) => `:link: <${url}>`).join('\n');
  return {
    type: 'section',
    text: { type: 'mrkdwn', text: linkLines },
  };
}

// ── Interactive header blocks (initial state) ────────────────────────

export interface InteractiveHeaderInput {
  command: string;
  requestId: string;
  hint?: string;
}

/**
 * Build the initial interactive bridge message blocks:
 * header line, divider, "Starting..." status, and Cancel button.
 */
export function buildInteractiveHeaderBlocks(input: InteractiveHeaderInput): object[] {
  const { command, requestId, hint } = input;
  const hintText = hint ? ` \u2014 ${hint}` : '';

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:computer: *Interactive:* \`${truncateCommand(command)}\`${hintText}`,
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: ':hourglass_flowing_sand: Starting...' },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Cancel' },
          action_id: 'interactive_cancel',
          value: requestId,
          style: 'danger',
        },
      ],
    },
  ];
}

// ── Interactive prompt blocks ────────────────────────────────────────

export interface MenuOption {
  index: number;
  label: string;
  isSelected: boolean;
}

export interface InteractivePromptInput {
  command: string;
  requestId: string;
  promptType: 'yesno' | 'menu' | 'password' | 'press_enter' | 'text';
  promptText: string;
  outputContext: string;
  menuOptions?: MenuOption[];
}

/**
 * Build blocks for an interactive prompt (y/n, menu, password, enter, text input).
 * Includes recent output context and URL links.
 */
export function buildInteractivePromptBlocks(input: InteractivePromptInput): object[] {
  const { command, requestId, promptType, promptText, outputContext, menuOptions } = input;

  const headerBlock = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `:computer: *Interactive:* \`${truncateCommand(command)}\``,
    },
  };
  const divider = { type: 'divider' };

  const blocks: object[] = [headerBlock, divider];

  // Output context block
  if (outputContext.trim()) {
    const displayOutput = outputContext.length > 2900
      ? outputContext.slice(-2900)
      : outputContext;
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '```\n' + displayOutput + '\n```' },
    });

    // URL links from output
    const urlBlock = buildUrlBlock(displayOutput);
    if (urlBlock) blocks.push(urlBlock);
  }

  // Action IDs use the requestId (callbackId) as prefix so the gateway
  // can route interactions back to the correct worker via the callback registry.
  // Suffixes (_allow, _deny, _0, _input_0) are stripped by the gateway to find the base callbackId.

  switch (promptType) {
    case 'yesno': {
      blocks.push(
        { type: 'section', text: { type: 'mrkdwn', text: `:point_right: ${escapeSlackText(promptText)}` } },
        {
          type: 'actions',
          elements: [
            { type: 'button', text: { type: 'plain_text', text: 'Yes' }, action_id: `${requestId}_allow`, value: 'ib_yes', style: 'primary' },
            { type: 'button', text: { type: 'plain_text', text: 'No' }, action_id: `${requestId}_0`, value: 'ib_no' },
            { type: 'button', text: { type: 'plain_text', text: 'Cancel' }, action_id: `${requestId}_deny`, value: 'ib_cancel', style: 'danger' },
          ],
        },
      );
      break;
    }
    case 'menu': {
      const options = menuOptions ?? [];
      const menuButtons = options.slice(0, 4).map((opt, i) => ({
        type: 'button',
        text: { type: 'plain_text', text: `${opt.index + 1}: ${opt.label}`.slice(0, 75) },
        action_id: `${requestId}_${i}`,
        value: `ib_menu_${opt.index}`,
        ...(opt.isSelected ? { style: 'primary' } : {}),
      }));
      blocks.push(
        { type: 'section', text: { type: 'mrkdwn', text: `:point_right: ${escapeSlackText(promptText)}` } },
        {
          type: 'actions',
          elements: [
            ...menuButtons,
            { type: 'button', text: { type: 'plain_text', text: 'Cancel' }, action_id: `${requestId}_deny`, value: 'ib_cancel', style: 'danger' },
          ],
        },
      );
      // Overflow for items 5-8
      if (options.length > 4) {
        const moreButtons = options.slice(4, 8).map((opt, i) => ({
          type: 'button',
          text: { type: 'plain_text', text: `${opt.index + 1}: ${opt.label}`.slice(0, 75) },
          action_id: `${requestId}_${i + 4}`,
          value: `ib_menu_${opt.index}`,
          ...(opt.isSelected ? { style: 'primary' } : {}),
        }));
        if (moreButtons.length > 0) {
          blocks.push({ type: 'actions', elements: moreButtons });
        }
      }
      break;
    }
    case 'password': {
      blocks.push(
        { type: 'section', text: { type: 'mrkdwn', text: ':lock: *Sensitive input required.* Click below to enter securely.' } },
        {
          type: 'actions',
          elements: [
            { type: 'button', text: { type: 'plain_text', text: 'Enter securely' }, action_id: `${requestId}_allow`, value: 'ib_password' },
            { type: 'button', text: { type: 'plain_text', text: 'Cancel' }, action_id: `${requestId}_deny`, value: 'ib_cancel', style: 'danger' },
          ],
        },
      );
      break;
    }
    case 'press_enter': {
      blocks.push(
        { type: 'section', text: { type: 'mrkdwn', text: `:point_right: ${escapeSlackText(promptText)}` } },
        {
          type: 'actions',
          elements: [
            { type: 'button', text: { type: 'plain_text', text: 'Press Enter' }, action_id: `${requestId}_allow`, value: 'ib_enter', style: 'primary' },
            { type: 'button', text: { type: 'plain_text', text: 'Cancel' }, action_id: `${requestId}_deny`, value: 'ib_cancel', style: 'danger' },
          ],
        },
      );
      break;
    }
    default: {
      // Generic text input
      blocks.push(
        { type: 'section', text: { type: 'mrkdwn', text: `:point_right: ${escapeSlackText(promptText)}` } },
        {
          type: 'input',
          block_id: `interactive_input_${requestId}`,
          dispatch_action: true,
          element: {
            type: 'plain_text_input',
            action_id: `${requestId}_input_0`,
            placeholder: { type: 'plain_text', text: 'Type your response and press Enter...' },
            dispatch_action_config: { trigger_actions_on: ['on_enter_pressed'] },
          },
          label: { type: 'plain_text', text: 'Your response' },
        },
        {
          type: 'actions',
          elements: [
            { type: 'button', text: { type: 'plain_text', text: 'Cancel' }, action_id: `${requestId}_deny`, value: 'ib_cancel', style: 'danger' },
          ],
        },
      );
      break;
    }
  }

  return blocks;
}

// ── Streaming output blocks ──────────────────────────────────────────

export interface InteractiveStreamInput {
  command: string;
  requestId: string;
  displayOutput: string;
}

/**
 * Build blocks for streaming interactive output with a Cancel button.
 */
export function buildInteractiveStreamBlocks(input: InteractiveStreamInput): object[] {
  const { command, requestId, displayOutput } = input;

  const blocks: object[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:computer: *Interactive:* \`${truncateCommand(command)}\``,
      },
    },
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: '```\n' + displayOutput + '\n```' } },
  ];

  const urlBlock = buildUrlBlock(displayOutput);
  if (urlBlock) blocks.push(urlBlock);

  blocks.push({
    type: 'actions',
    elements: [
      { type: 'button', text: { type: 'plain_text', text: 'Cancel' }, action_id: 'interactive_cancel', value: requestId, style: 'danger' },
    ],
  });

  return blocks;
}

// ── Completion blocks ────────────────────────────────────────────────

export interface InteractiveCompletedInput {
  command: string;
  exitCode: number;
  timedOut: boolean;
  displayOutput?: string;
}

/**
 * Build blocks for a completed interactive session.
 */
export function buildInteractiveCompletedBlocks(input: InteractiveCompletedInput): object[] {
  const { command, exitCode, timedOut, displayOutput } = input;

  const statusEmoji = exitCode === 0 ? ':white_check_mark:' : ':x:';
  const statusText = timedOut ? 'Timed out' : `Exit code: ${exitCode}`;

  const blocks: object[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${statusEmoji} *Interactive completed:* \`${truncateCommand(command)}\` \u2014 ${statusText}`,
      },
    },
  ];

  if (displayOutput) {
    blocks.push(
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: '```\n' + displayOutput + '\n```' } },
    );
    const urlBlock = buildUrlBlock(displayOutput);
    if (urlBlock) blocks.push(urlBlock);
  }

  return blocks;
}

// ── Failure blocks ───────────────────────────────────────────────────

export interface InteractiveFailedInput {
  command: string;
  error: string;
}

/**
 * Build blocks for a failed interactive session.
 */
export function buildInteractiveFailedBlocks(input: InteractiveFailedInput): object[] {
  const { command, error } = input;

  return [
    { type: 'section', text: { type: 'mrkdwn', text: `:x: *Interactive failed:* \`${truncateCommand(command)}\`` } },
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: `Error: ${error}` } },
  ];
}
