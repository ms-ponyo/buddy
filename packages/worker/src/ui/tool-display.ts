// src/ui/tool-display.ts — Tool name formatting and display logic.
// Ported from src/slack-handler/ui/tool-display.ts.
// Pure functions, no external dependencies (except diff-formatter for getEditDiffBlocks).

import { formatDiffBlocks, type SlackBlock, type DiffInput } from '../util/diff-formatter.js';

/** Strip MCP server prefix from tool names: "mcp__server__tool" -> "tool" */
export function shortToolName(toolName: string): string {
  if (toolName.includes('__')) return toolName.split('__').pop()!;
  return toolName;
}

export const TOOL_DISPLAY = new Map<string, { emoji: string; label: (input: Record<string, unknown>) => string }>([
  ['browser_navigate', { emoji: ':globe_with_meridians:', label: (input) => {
    try { return `Navigating to \`${new URL(String(input.url)).hostname}\``; } catch { return 'Navigating'; }
  }}],
  ['browser_take_screenshot', { emoji: ':camera_with_flash:', label: () => 'Taking screenshot' }],
  ['browser_snapshot', { emoji: ':eye:', label: () => 'Capturing page snapshot' }],
  ['browser_click', { emoji: ':point_up:', label: () => 'Clicking element' }],
  ['browser_fill_form', { emoji: ':keyboard:', label: () => 'Typing into form' }],
  ['browser_type', { emoji: ':keyboard:', label: () => 'Typing into form' }],
  ['browser_install', { emoji: ':package:', label: () => 'Installing browser' }],
  ['browser_run_code', { emoji: ':zap:', label: () => 'Running browser code' }],
  ['browser_hover', { emoji: ':hand:', label: () => 'Interacting with page' }],
  ['browser_drag', { emoji: ':hand:', label: () => 'Interacting with page' }],
  ['browser_wait_for', { emoji: ':hourglass:', label: () => 'Waiting for element' }],
  ['browser_close', { emoji: ':door:', label: () => 'Closing browser' }],
  ['browser_tabs', { emoji: ':card_index_dividers:', label: () => 'Managing tabs' }],
]);

export function toolUseStatusText(toolName: string, input: Record<string, unknown>, elapsedSeconds?: number): string {
  const elapsed = elapsedSeconds !== undefined && elapsedSeconds >= 1
    ? ` (${Math.round(elapsedSeconds)}s)`
    : '';

  switch (toolName) {
    case 'Read':
      return `:mag: Reading \`${input.file_path ?? 'file'}\`...${elapsed}`;
    case 'Edit':
      return `:pencil2: Editing \`${input.file_path ?? 'file'}\`...${elapsed}`;
    case 'Write':
      return `:pencil2: Writing \`${input.file_path ?? 'file'}\`...${elapsed}`;
    case 'Bash': {
      const cmd = typeof input.command === 'string' ? input.command : '';
      return cmd ? `:computer: Running \`${cmd}\`${elapsed}` : `:computer: Running command...${elapsed}`;
    }
    case 'Grep':
      return `:mag: Searching for \`${input.pattern ?? 'pattern'}\`...${elapsed}`;
    case 'Glob':
      return `:mag: Finding files...${elapsed}`;
    case 'Agent':
      return `:robot_face: Spawning agent...${elapsed}`;
    case 'WebFetch':
      return `:globe_with_meridians: Fetching \`${input.url ?? 'URL'}\`...${elapsed}`;
    case 'WebSearch':
      return `:globe_with_meridians: Searching the web...${elapsed}`;
    case 'Skill': {
      const skillName = typeof input.skill === 'string' ? input.skill : 'skill';
      return `:sparkles: Loading skill \`${skillName}\`...${elapsed}`;
    }
    default: {
      const short = shortToolName(toolName);
      const display = TOOL_DISPLAY.get(short);
      if (display) {
        return `${display.emoji} ${display.label(input)}...${elapsed}`;
      }
      const readable = short.replace(/_/g, ' ');
      return `:gear: ${readable.charAt(0).toUpperCase() + readable.slice(1)}...${elapsed}`;
    }
  }
}

export interface EditDiffInput {
  file_path: string;
  old_string: string;
  new_string: string;
}

/**
 * Build Slack diff blocks for an Edit tool invocation.
 * Optionally strips the projectDir prefix from file paths.
 * Unlike the original, this does NOT read the file from disk to find startLine
 * (to keep it pure). The caller can pass startLine via DiffInput if needed.
 */
export function getEditDiffBlocks(input: EditDiffInput, projectDir?: string): SlackBlock[] {
  const absolutePath = input.file_path || 'file';
  let filePath = absolutePath;
  if (projectDir && filePath.startsWith(projectDir)) {
    filePath = filePath.slice(projectDir.length).replace(/^\//, '');
  }
  const oldStr = input.old_string ?? '';
  const newStr = input.new_string ?? '';

  if (!oldStr && !newStr) return [];

  try {
    return formatDiffBlocks({
      file_path: filePath,
      old_string: oldStr,
      new_string: newStr,
    });
  } catch {
    return [];
  }
}
