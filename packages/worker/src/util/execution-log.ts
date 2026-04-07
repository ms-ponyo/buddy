// src/util/execution-log.ts — execution log formatting.
// Ported from src/slack-handler/core/execution-log.ts.
// All dependencies are explicit parameters — no globals.

import type { ExecEntry } from '../types.js';
import { truncateStr } from './text-helpers.js';

// ── Helpers ──────────────────────────────────────────────────────────

export function getBriefToolInput(toolName: string, log: ExecEntry[], toolUseId?: string): string {
  const entry = [...log].reverse().find(
    (e): e is ExecEntry & { type: 'tool_use' } =>
      e.type === 'tool_use' && (toolUseId ? e.id === toolUseId : e.name === toolName),
  );
  if (!entry) return '';
  const input = entry.input;
  const path = input.file_path ?? input.path ?? input.notebook_path;
  if (typeof path === 'string') return ` \`${path.split('/').slice(-2).join('/')}\``;
  if (toolName === 'Bash' && typeof input.command === 'string') {
    const cmd = input.command.slice(0, 40);
    return ` \`${cmd}${input.command.length > 40 ? '\u2026' : ''}\``;
  }
  if (toolName === 'Grep' && typeof input.pattern === 'string') return ` \`${input.pattern}\``;
  return '';
}

export function buildCompletionContextBlock(usageNote: string): Record<string, unknown> {
  return {
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: usageNote,
      },
    ],
  };
}

// ── Full log formatter ───────────────────────────────────────────────

export function formatExecutionLog(
  entries: ExecEntry[],
  finalResponse: string,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; contextWindowPercent: number; numTurns: number },
  sessionId: string,
  model: string,
  costUsd: number,
): string {
  const lines: string[] = [];
  lines.push('# Execution Log\n');
  lines.push(`**Session:** \`${sessionId}\`  **Model:** ${model}`);
  lines.push(
    `**Turns:** ${usage.numTurns} | **Tokens:** ${(usage.inputTokens + usage.outputTokens).toLocaleString()} (in: ${usage.inputTokens.toLocaleString()}, out: ${usage.outputTokens.toLocaleString()}, cache: ${usage.cacheReadTokens.toLocaleString()})`,
  );
  lines.push(`**Cost:** $${costUsd.toFixed(4)} | **Context:** ${usage.contextWindowPercent > 0 ? `${usage.contextWindowPercent}%` : 'N/A'}`);
  lines.push('\n---\n');

  for (const entry of entries) {
    switch (entry.type) {
      case 'text':
        lines.push('## Claude\n');
        lines.push(entry.content.trim());
        lines.push('');
        break;
      case 'tool_use': {
        const brief = getBriefToolInput(entry.name, [entry]);
        lines.push(`### Tool: ${entry.name}${brief}\n`);
        const inputJson = JSON.stringify(entry.input, (_k, v) => {
          if (typeof v === 'string' && v.length > 500) return v.slice(0, 500) + '\u2026 (truncated)';
          return v;
        }, 2);
        lines.push('**Input:**');
        lines.push('```json');
        lines.push(inputJson);
        lines.push('```\n');
        break;
      }
      case 'tool_result':
        lines.push('**Result:**');
        lines.push('```');
        lines.push(truncateStr(entry.result, 3000));
        lines.push('```\n');
        break;
      case 'status_change':
        lines.push(`> _Status: ${entry.message}_\n`);
        break;
      case 'user_message':
        lines.push('## User\n');
        lines.push(entry.content.trim());
        lines.push('');
        break;
    }
  }

  lines.push('---\n');
  lines.push('## Final Response\n');
  lines.push(finalResponse);

  return lines.join('\n');
}
