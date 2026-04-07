// src/util/format.ts — Slack message splitting and markdown block formatting.
// Ported from src/format.ts. Pure functions, no external dependencies.

import { MARKDOWN_BLOCK_MAX_LENGTH } from '@buddy/shared';

const SLACK_MAX_LENGTH = 3000;

/**
 * Convert plan markdown to an array of Slack MarkdownBlocks.
 * Uses native markdown rendering (no mrkdwn conversion) — Slack handles
 * tables, headers, code blocks, etc. natively in MarkdownBlock.
 * Splits at paragraph boundaries within the 12K char limit.
 */
export function formatPlanAsMarkdownBlocks(markdown: string): { type: 'markdown'; text: string }[] {
  if (!markdown.trim()) {
    return [{ type: 'markdown', text: '_Empty plan_' }];
  }

  const paragraphs = markdown.split(/\n\n+/);
  const blocks: { type: 'markdown'; text: string }[] = [];
  let current = "";

  for (const para of paragraphs) {
    const addition = current ? `\n\n${para}` : para;
    if (current && (current + addition).length > MARKDOWN_BLOCK_MAX_LENGTH) {
      blocks.push({ type: 'markdown', text: current });
      current = para;
    } else {
      current = current ? current + addition : para;
    }
  }

  if (current) {
    blocks.push({ type: 'markdown', text: current });
  }

  return blocks;
}

type MdBlock = { type: 'markdown'; text: string };

/** Find byte positions of all code-fence lines (``` ...) in text. */
function findCodeFencePositions(text: string): number[] {
  const positions: number[] = [];
  let pos = 0;
  for (const line of text.split('\n')) {
    if (/^```/.test(line.trimStart())) {
      positions.push(pos);
    }
    pos += line.length + 1; // +1 for \n
  }
  return positions;
}

/** Split text into chunks at paragraph boundaries, respecting maxLen.
 *  Avoids splitting inside code blocks when possible. */
function splitAtParagraphs(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let splitIdx = remaining.lastIndexOf('\n\n', maxLen);
    if (splitIdx === -1 || splitIdx < maxLen / 2) {
      splitIdx = remaining.lastIndexOf('\n', maxLen);
    }
    if (splitIdx === -1 || splitIdx < maxLen / 2) {
      splitIdx = maxLen;
    }

    // If the split falls inside a code block, move it to before the block starts.
    const beforeSplit = remaining.slice(0, splitIdx);
    const fencePositions = findCodeFencePositions(beforeSplit);
    if (fencePositions.length % 2 === 1) {
      // Odd fence count → inside an unclosed code block.
      const blockStart = fencePositions[fencePositions.length - 1];
      // Only move back if there's meaningful content before the block;
      // otherwise the block itself is too long — keep the regular split.
      if (blockStart > 0 && remaining.slice(0, blockStart).trim().length > 0) {
        splitIdx = blockStart;
      }
    }

    chunks.push(remaining.slice(0, splitIdx).trimEnd());
    remaining = remaining.slice(splitIdx).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/**
 * Split markdown into groups of Slack MarkdownBlocks, where each group
 * can be posted as a single chat.postMessage call.
 * Slack allows at most ONE table per message ("only_one_table_allowed"),
 * so each group contains at most one table.
 * Returns a single group when there are 0-1 tables.
 */
export function splitMarkdownIntoMessages(markdown: string): MdBlock[][] {
  if (!markdown.trim()) {
    return [[{ type: 'markdown', text: markdown }]];
  }

  // Split text into segments: alternating non-table and table sections.
  const segments: { text: string; hasTable: boolean }[] = [];
  const lines = markdown.split('\n');
  let current = '';
  let inTable = false;
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line.trimStart())) {
      inCodeBlock = !inCodeBlock;
    }
    const isTableLine = !inCodeBlock && /^\s*\|/.test(line);

    if (isTableLine && !inTable) {
      if (current) {
        segments.push({ text: current, hasTable: false });
        current = '';
      }
      inTable = true;
    } else if (!isTableLine && inTable) {
      segments.push({ text: current, hasTable: true });
      current = '';
      inTable = false;
    }
    current += (current ? '\n' : '') + line;
  }
  if (current) {
    segments.push({ text: current, hasTable: inTable });
  }

  // Group segments into messages, each with at most one table.
  // Non-table segments merge with the next table segment to provide context.
  const messages: MdBlock[][] = [];
  let accText = '';
  let accHasTable = false;

  const flushAcc = () => {
    if (!accText.trim()) return;
    // Split oversized accumulated text into multiple messages
    if (accText.length > MARKDOWN_BLOCK_MAX_LENGTH) {
      const chunks = splitAtParagraphs(accText.trim(), MARKDOWN_BLOCK_MAX_LENGTH);
      for (const chunk of chunks) {
        messages.push([{ type: 'markdown', text: chunk }]);
      }
    } else {
      messages.push([{ type: 'markdown', text: accText.trim() }]);
    }
  };

  for (const seg of segments) {
    // Use double newline after tables so Slack doesn't treat following text as a table row
    const separator = accHasTable ? '\n\n' : '\n';
    const merged = accText ? accText + separator + seg.text : seg.text;

    if (accHasTable && seg.hasTable) {
      // Flush current group (has a table), start new group
      flushAcc();
      accText = seg.text;
      accHasTable = true;
    } else if (merged.length > MARKDOWN_BLOCK_MAX_LENGTH) {
      flushAcc();
      accText = seg.text;
      accHasTable = seg.hasTable;
    } else {
      accText = merged;
      accHasTable = accHasTable || seg.hasTable;
    }
  }
  flushAcc();

  return messages.length > 0 ? messages : [[{ type: 'markdown', text: markdown }]];
}

export function splitMessage(text: string): string[] {
  if (text.length <= SLACK_MAX_LENGTH) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > SLACK_MAX_LENGTH) {
    // Try to split at a paragraph boundary
    let splitIdx = remaining.lastIndexOf("\n\n", SLACK_MAX_LENGTH);

    // Fall back to single newline
    if (splitIdx === -1 || splitIdx < SLACK_MAX_LENGTH / 2) {
      splitIdx = remaining.lastIndexOf("\n", SLACK_MAX_LENGTH);
    }

    // Fall back to space
    if (splitIdx === -1 || splitIdx < SLACK_MAX_LENGTH / 2) {
      splitIdx = remaining.lastIndexOf(" ", SLACK_MAX_LENGTH);
    }

    // Last resort: hard cut
    if (splitIdx === -1 || splitIdx < SLACK_MAX_LENGTH / 2) {
      splitIdx = SLACK_MAX_LENGTH;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
