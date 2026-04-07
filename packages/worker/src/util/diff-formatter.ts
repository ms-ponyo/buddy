// src/util/diff-formatter.ts — Diff formatting for Slack display.
// Ported from src/diff-formatter.ts. Pure functions, no external dependencies.

import { MARKDOWN_BLOCK_MAX_LENGTH } from '@buddy/shared';

export interface DiffInput {
  file_path: string;
  old_string: string;
  new_string: string;
  /** 1-based line number where old_string starts in the original file. */
  startLine?: number;
}

export interface SlackBlock {
  type: string;
  text?: string | { type: string; text: string };
}

const MAX_DIFF_LINES = 80;
const MAX_LINE_LENGTH = 500;

function isBinaryContent(content: string): boolean {
  return content.includes('\u0000') ||
         (content.match(/[\x00-\x08\x0E-\x1F\x7F-\xFF]/g)?.length || 0) > content.length * 0.3;
}

/**
 * Compute longest common subsequence table for two string arrays.
 */
function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp;
}

interface DiffLine {
  type: ' ' | '+' | '-';
  text: string;
}

/**
 * Produce a flat list of diff lines from two string arrays using LCS.
 */
function computeDiffLines(oldLines: string[], newLines: string[]): DiffLine[] {
  const dp = lcsTable(oldLines, newLines);
  const result: DiffLine[] = [];
  let i = oldLines.length;
  let j = newLines.length;

  // Backtrack through the LCS table
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({ type: ' ', text: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: '+', text: newLines[j - 1] });
      j--;
    } else {
      result.push({ type: '-', text: oldLines[i - 1] });
      i--;
    }
  }

  result.reverse();
  return result;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

/**
 * Group diff lines into hunks with context lines.
 */
function buildHunks(diffLines: DiffLine[], contextLines: number = 3, lineOffset: number = 0): Hunk[] {
  // Find indices of changed lines
  const changedIndices: number[] = [];
  for (let i = 0; i < diffLines.length; i++) {
    if (diffLines[i].type !== ' ') changedIndices.push(i);
  }

  if (changedIndices.length === 0) return [];

  const hunks: Hunk[] = [];
  let hunkStart = Math.max(0, changedIndices[0] - contextLines);
  let hunkEnd = Math.min(diffLines.length - 1, changedIndices[0] + contextLines);

  for (let k = 1; k < changedIndices.length; k++) {
    const nextStart = Math.max(0, changedIndices[k] - contextLines);
    const nextEnd = Math.min(diffLines.length - 1, changedIndices[k] + contextLines);

    if (nextStart <= hunkEnd + 1) {
      // Merge with current hunk
      hunkEnd = nextEnd;
    } else {
      // Emit current hunk, start new one
      hunks.push(buildSingleHunk(diffLines, hunkStart, hunkEnd, lineOffset));
      hunkStart = nextStart;
      hunkEnd = nextEnd;
    }
  }
  hunks.push(buildSingleHunk(diffLines, hunkStart, hunkEnd, lineOffset));

  return hunks;
}

function buildSingleHunk(diffLines: DiffLine[], start: number, end: number, lineOffset: number = 0): Hunk {
  const lines = diffLines.slice(start, end + 1);

  // Calculate line numbers by counting through preceding lines
  let oldLine = 1 + lineOffset;
  let newLine = 1 + lineOffset;
  for (let i = 0; i < start; i++) {
    if (diffLines[i].type !== '+') oldLine++;
    if (diffLines[i].type !== '-') newLine++;
  }

  let oldCount = 0;
  let newCount = 0;
  for (const l of lines) {
    if (l.type !== '+') oldCount++;
    if (l.type !== '-') newCount++;
  }

  return { oldStart: oldLine, oldCount, newStart: newLine, newCount, lines };
}

/**
 * Format diff lines from hunks as plain +/- prefixed text.
 */
function formatDiffBody(hunks: Hunk[]): string {
  const parts: string[] = [];

  for (const hunk of hunks) {
    parts.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
    for (const line of hunk.lines) {
      const truncated = line.text.length > MAX_LINE_LENGTH
        ? line.text.slice(0, MAX_LINE_LENGTH) + '...'
        : line.text;
      parts.push(`${line.type}${truncated}`);
    }
  }

  return parts.join('\n');
}

/**
 * Format a diff as a markdown string for inline streaming.
 * Returns null if there are no changes.
 */
export interface DiffResult {
  text: string;
  truncated: boolean;
}

export function formatDiffMarkdown(input: DiffInput): string | null {
  const result = formatDiffMarkdownEx(input);
  return result?.text ?? null;
}

export function formatDiffMarkdownEx(input: DiffInput): DiffResult | null {
  try {
    if (!input?.file_path || input.old_string == null || input.new_string == null) {
      return null;
    }

    if (isBinaryContent(input.old_string) || isBinaryContent(input.new_string)) {
      return { text: `\`${input.file_path}\` — *Binary file changed*`, truncated: false };
    }

    if (input.old_string === '' && input.new_string === '') {
      return null;
    }

    const oldLines = input.old_string.split('\n');
    const newLines = input.new_string.split('\n');
    const lineOffset = (input.startLine && input.startLine > 1) ? input.startLine - 1 : 0;
    const diffLines = computeDiffLines(oldLines, newLines);
    const hunks = buildHunks(diffLines, 3, lineOffset);

    if (hunks.length === 0) return null;

    let additions = 0;
    let deletions = 0;
    for (const line of diffLines) {
      if (line.type === '+') additions++;
      if (line.type === '-') deletions++;
    }

    let truncated = false;
    const diffBody = formatDiffBody(hunks);
    const diffOutputLines = diffBody.split('\n');
    let finalDiff: string;
    if (diffOutputLines.length > MAX_DIFF_LINES) {
      finalDiff = diffOutputLines.slice(0, MAX_DIFF_LINES).join('\n') + '\n... (truncated)';
      truncated = true;
    } else {
      finalDiff = diffBody;
    }

    // Enforce character limit consistent with MARKDOWN_BLOCK_MAX_LENGTH
    if (finalDiff.length > MARKDOWN_BLOCK_MAX_LENGTH - 200) {
      finalDiff = finalDiff.slice(0, MARKDOWN_BLOCK_MAX_LENGTH - 200) + '\n... (truncated)';
      truncated = true;
    }

    const startLine = hunks[0].oldStart;
    const lineRef = startLine > 1 ? ` L${startLine}` : '';
    const summary = `\`${input.file_path}\`${lineRef} — **+${additions} -${deletions}**`;

    return { text: summary + '\n```diff\n' + finalDiff + '\n```', truncated };
  } catch {
    return null;
  }
}

// ── File create formatting ──────────────────────────────────────────

const MAX_CREATE_LINES = 60;

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  sh: 'bash', zsh: 'bash', bash: 'bash', sql: 'sql', json: 'json',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml', html: 'html',
  css: 'css', scss: 'scss', md: 'markdown', swift: 'swift', kt: 'kotlin',
  c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
};

function langFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return EXT_LANG[ext] ?? '';
}

export interface FileCreateResult {
  text: string;
  truncated: boolean;
}

/**
 * Format new file content as a markdown code block for inline streaming.
 * Returns the formatted text and whether it was truncated.
 */
export function formatFileCreateMarkdown(filePath: string, content: string): FileCreateResult | null {
  try {
    if (!filePath || content == null) return null;

    if (isBinaryContent(content)) {
      return { text: `\`${filePath}\` — *Binary file created*`, truncated: false };
    }

    const lines = content.split('\n');
    const lineCount = lines.length;
    const lang = langFromPath(filePath);

    let displayContent: string;
    let truncated = false;

    if (lineCount > MAX_CREATE_LINES) {
      displayContent = lines.slice(0, MAX_CREATE_LINES).join('\n') + '\n... (truncated)';
      truncated = true;
    } else {
      displayContent = content;
    }

    // Enforce character limit
    if (displayContent.length > MARKDOWN_BLOCK_MAX_LENGTH - 200) {
      displayContent = displayContent.slice(0, MARKDOWN_BLOCK_MAX_LENGTH - 200) + '\n... (truncated)';
      truncated = true;
    }

    const summary = `\`${filePath}\` — **new file** (${lineCount} lines)`;
    const text = summary + '\n```' + lang + '\n' + displayContent + '\n```';
    return { text, truncated };
  } catch {
    return null;
  }
}

/**
 * Generate a full unified diff string (no truncation) for file upload.
 */
export function formatFullDiff(input: DiffInput): string | null {
  try {
    if (!input?.file_path || input.old_string == null || input.new_string == null) return null;
    if (isBinaryContent(input.old_string) || isBinaryContent(input.new_string)) return null;
    if (input.old_string === '' && input.new_string === '') return null;

    const oldLines = input.old_string.split('\n');
    const newLines = input.new_string.split('\n');
    const lineOffset = (input.startLine && input.startLine > 1) ? input.startLine - 1 : 0;
    const diffLines = computeDiffLines(oldLines, newLines);
    const hunks = buildHunks(diffLines, 3, lineOffset);
    if (hunks.length === 0) return null;

    return `--- ${input.file_path}\n+++ ${input.file_path}\n` + formatDiffBody(hunks);
  } catch {
    return null;
  }
}

export function formatDiffBlocks(input: DiffInput): SlackBlock[] {
  try {
    if (!input) {
      throw new Error('Input is required');
    }
    if (!input.file_path || typeof input.file_path !== 'string') {
      throw new Error('file_path is required and must be a string');
    }
    if (input.old_string === null || input.old_string === undefined) {
      throw new Error('old_string is required');
    }
    if (input.new_string === null || input.new_string === undefined) {
      throw new Error('new_string is required');
    }

    // Handle binary files
    if (isBinaryContent(input.old_string) || isBinaryContent(input.new_string)) {
      return [{
        type: 'markdown',
        text: `\`${input.file_path}\` — *Binary file changed*`,
      }];
    }

    // Handle empty diff
    if (input.old_string === '' && input.new_string === '') {
      return [{
        type: 'markdown',
        text: `\`${input.file_path}\` — *No changes*`,
      }];
    }

    const oldLines = input.old_string.split('\n');
    const newLines = input.new_string.split('\n');

    // Compute diff
    const lineOffset = (input.startLine && input.startLine > 1) ? input.startLine - 1 : 0;
    const diffLines = computeDiffLines(oldLines, newLines);
    const hunks = buildHunks(diffLines, 3, lineOffset);

    if (hunks.length === 0) {
      return [{
        type: 'markdown',
        text: `\`${input.file_path}\` — *No changes*`,
      }];
    }

    // Count additions and deletions
    let additions = 0;
    let deletions = 0;
    for (const line of diffLines) {
      if (line.type === '+') additions++;
      if (line.type === '-') deletions++;
    }

    const diffBody = formatDiffBody(hunks);

    // Truncate if too many lines
    const diffOutputLines = diffBody.split('\n');
    let finalDiff: string;
    if (diffOutputLines.length > MAX_DIFF_LINES) {
      finalDiff = diffOutputLines.slice(0, MAX_DIFF_LINES).join('\n') + '\n... (truncated)';
    } else {
      finalDiff = diffBody;
    }

    const startLine = hunks[0].oldStart;
    const lineRef = startLine > 1 ? ` L${startLine}` : '';
    const summary = `\`${input.file_path}\`${lineRef} — **+${additions} -${deletions}**`;
    const codeBlock = '```diff\n' + finalDiff + '\n```';
    const fullText = summary + '\n' + codeBlock;

    // Split into multiple markdown blocks if exceeding Slack's limit
    if (fullText.length <= MARKDOWN_BLOCK_MAX_LENGTH) {
      return [{ type: 'markdown', text: fullText }];
    }

    // Summary in one block, diff in another
    return [
      { type: 'markdown', text: summary },
      { type: 'markdown', text: codeBlock.slice(0, MARKDOWN_BLOCK_MAX_LENGTH) },
    ];

  } catch (error) {
    return [{
      type: 'markdown',
      text: `*Error formatting diff:* ${error instanceof Error ? error.message : 'Unknown error'}`,
    }];
  }
}
