const SECTION_TEXT_LIMIT = 3000;

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit - 1) + '…';
}

// ── Friendly tool labels ─────────────────────────────────────────────

const TOOL_LABELS: Record<string, string> = {
  // dispatch-control tools
  stop_execution: 'Stopping execution',
  send_to_background: 'Sending to background',
  switch_permission_mode: 'Switching mode',
  switch_model: 'Switching model',
  get_status: 'Checking status',
  fork_thread: 'Forking thread',
  execute_bot_command: 'Running command',
  // slack-tools
  fetch_thread_messages: 'Reading thread',
  fetch_channel_messages: 'Reading channel',
  fetch_message: 'Reading message',
  upload_file_to_slack: 'Uploading file',
  download_slack_file: 'Downloading file',
  // built-in
  Read: 'Reading file',
};

/** Convert SDK tool name (e.g. mcp__dispatch-control__get_status) to friendly label */
export function friendlyToolLabel(toolName: string): string {
  const mcpMatch = toolName.match(/^mcp__[^_]+__(.+)$/);
  const baseName = mcpMatch ? mcpMatch[1] : toolName;
  return TOOL_LABELS[baseName] ?? `Using ${baseName}`;
}

// ── Block builders ───────────────────────────────────────────────────

/**
 * Build Slack blocks for the dispatch session "ready" state.
 * Contains the response, a text input for fast chat, and Send/Close buttons.
 *
 * block_id format "haiku_input:<threadKey>" matches the parser in slack-router.ts.
 */
export function buildDispatchBlocks(
  threadKey: string,
  responseText?: string,
): Record<string, unknown>[] {
  const sectionText = responseText
    ? `\u{1F407} ${truncateText(responseText, SECTION_TEXT_LIMIT)}`
    : '_Dispatch session active\u2026_';
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: sectionText,
      },
    },
    {
      type: 'input',
      block_id: `haiku_input:${threadKey}`,
      dispatch_action: true,
      optional: true,
      label: { type: 'plain_text', text: ' ' },
      element: {
        type: 'plain_text_input',
        action_id: 'haiku_reply',
        placeholder: { type: 'plain_text', text: 'Reply to haiku\u2026' },
        dispatch_action_config: { trigger_actions_on: ['on_enter_pressed'] },
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '\u2709\uFE0F Send' },
          style: 'primary',
          action_id: 'haiku_send',
          value: threadKey,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '\u2716 Close' },
          style: 'danger',
          action_id: 'haiku_done',
          value: threadKey,
        },
      ],
    },
  ];
}

/**
 * Build Slack blocks for the dispatch session "thinking" state.
 * Shows tool activity status and a Close button (no input while processing).
 */
export function buildDispatchThinkingBlocks(
  threadKey: string,
  userText: string,
  toolActivity?: string,
): Record<string, unknown>[] {
  const statusText = toolActivity
    ? `\u{1F407} _${toolActivity}_`
    : '\u{1F407} _Thinking\u2026_';
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: statusText },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `You said: _${userText}_` }],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '\u2716 Close' },
          style: 'danger',
          action_id: 'haiku_done',
          value: threadKey,
        },
      ],
    },
  ];
}

/**
 * Build Slack blocks for a dispatch error state.
 * Shows the error message and a Close button.
 */
export function buildDispatchErrorBlocks(
  threadKey: string,
  errorText: string,
): Record<string, unknown>[] {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `\u{1F407} :x: ${truncateText(errorText, SECTION_TEXT_LIMIT)}` },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '\u2716 Close' },
          style: 'danger',
          action_id: 'haiku_done',
          value: threadKey,
        },
      ],
    },
  ];
}
