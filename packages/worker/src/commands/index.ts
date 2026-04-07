// src/commands/index.ts — Barrel file combining all command definitions + catalog formatter.

import { configCommands } from './config-commands.js';
import { workflowCommands } from './workflow-commands.js';
import { gitCommands } from './git-commands.js';
import { diagnosticCommands } from './diagnostic-commands.js';
import type { CommandDefinition, CommandCategory } from './types.js';

// ── All commands ────────────────────────────────────────────────

export const allCommands: CommandDefinition[] = [
  ...configCommands,
  ...workflowCommands,
  ...gitCommands,
  ...diagnosticCommands,
];

// ── Catalog formatter for LLM prompt injection ─────────────────

const CATEGORY_LABELS: Record<CommandCategory, string> = {
  config: 'Configuration',
  workflow: 'Workflow',
  git: 'Code Review & Git',
  diagnostic: 'Diagnostics',
  advanced: 'Advanced',
};

export function formatCatalogForLLM(commands: CommandDefinition[]): string {
  const grouped = new Map<CommandCategory, CommandDefinition[]>();
  for (const cmd of commands) {
    const list = grouped.get(cmd.category) ?? [];
    list.push(cmd);
    grouped.set(cmd.category, list);
  }

  const sections: string[] = [];
  for (const [category, cmds] of grouped) {
    const label = CATEGORY_LABELS[category] ?? category;
    const lines = cmds.map((cmd) => {
      const argStr = cmd.args?.map((a) => a.required ? `<${a.name}>` : `[${a.name}]`).join(' ') ?? '';
      const aliasStr = cmd.aliases?.length ? ` (aliases: ${cmd.aliases.map((a) => '!' + a).join(', ')})` : '';
      return `  !${cmd.name}${argStr ? ' ' + argStr : ''} — ${cmd.description}${aliasStr}`;
    });
    sections.push(`${label}:\n${lines.join('\n')}`);
  }

  return `Available bot commands:\n\n${sections.join('\n\n')}`;
}

// ── Re-exports ──────────────────────────────────────────────────

export type {
  CommandDefinition,
  CommandContext,
  CommandHandlerResult,
  CommandHandler,
  CommandCategory,
  CommandArg,
  WorkerTarget,
} from './types.js';
export { defineCommand } from './types.js';
