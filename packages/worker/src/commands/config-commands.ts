// src/commands/config-commands.ts — Configuration commands.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineCommand } from './types.js';
import type { CommandDefinition } from './types.js';
import type { EffortLevel } from '../services/config-overrides.js';
import type { ThreadPermissionMode } from '../types.js';

// ── Constants ────────────────────────────────────────────────────

const MODEL_OPTIONS = [
  { label: 'Opus', model: 'opus[1m]', aliases: ['opus'] },
  { label: 'Sonnet', model: 'sonnet', aliases: [] },
  { label: 'Haiku', model: 'haiku', aliases: [] },
];

const MODE_MAP: Record<string, ThreadPermissionMode> = {
  default: 'default', d: 'default',
  acceptedits: 'acceptEdits', ae: 'acceptEdits', accept: 'acceptEdits',
  bypasspermissions: 'bypassPermissions', bypass: 'bypassPermissions', bp: 'bypassPermissions',
  dontask: 'dontAsk', da: 'dontAsk',
  plan: 'plan', p: 'plan',
  auto: 'auto', a: 'auto',
};

const MODE_LABELS: Record<ThreadPermissionMode, string> = {
  default: 'Default',
  acceptEdits: 'Accept Edits',
  bypassPermissions: 'Bypass Permissions',
  dontAsk: "Don't Ask",
  plan: 'Plan Only',
  auto: 'Auto',
};

const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'max'];

// ── Commands ─────────────────────────────────────────────────────

export const configCommands: CommandDefinition[] = [
  defineCommand({
    name: 'model',
    description: 'Switch the Claude model for this thread',
    category: 'config',
    args: [
      { name: 'model', description: 'Model name or alias', required: false, type: 'string' },
    ],
    examples: ['!model sonnet', '!model opus', '!model haiku'],
    handler: async (args, ctx) => {
      if (!args) {
        const modelNames = MODEL_OPTIONS.map((o) => o.model).join(', ');
        return { type: 'dispatch', reply: `Available models: ${modelNames}. Specify one with !model <name>.` };
      }
      const input = args.trim().toLowerCase();
      const matched = MODEL_OPTIONS.find((o) => o.model === input || o.label.toLowerCase() === input || o.aliases.includes(input));
      if (!matched) {
        const modelNames = MODEL_OPTIONS.map((o) => o.model).join(', ');
        return { type: 'dispatch', reply: `Unknown model "${args}". Available: ${modelNames}.` };
      }
      ctx.configOverrides.setModel(matched.model);
      return { type: 'handled', reply: `Model set to \`${matched.model}\` for this thread.` };
    },
  }),

  defineCommand({
    name: 'mode',
    description: 'Set permission mode for this thread',
    category: 'config',
    args: [
      { name: 'mode', description: 'Permission mode', required: false, type: 'enum', options: ['default', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'plan', 'auto'] },
    ],
    examples: ['!mode default', '!mode acceptEdits', '!mode bypassPermissions', '!mode plan', '!mode auto'],
    handler: async (args, ctx) => {
      if (!args) {
        return { type: 'dispatch', reply: 'Available modes: default, acceptEdits, bypassPermissions, dontAsk, plan, auto.' };
      }
      const modeArg = args.toLowerCase().trim();
      const newMode = MODE_MAP[modeArg];
      if (!newMode) {
        return { type: 'dispatch', reply: `Unknown mode "${args}". Valid modes: default, acceptEdits, bypassPermissions, dontAsk, plan, auto.` };
      }
      ctx.configOverrides.setPermissionMode(newMode);
      ctx.onPermissionModeChange?.(newMode);
      return { type: 'handled', reply: `Permission mode set to *${MODE_LABELS[newMode]}* for this thread.` };
    },
  }),

  defineCommand({
    name: 'effort',
    description: 'Set the effort level for this thread',
    category: 'config',
    args: [
      { name: 'level', description: 'Effort level', required: false, type: 'enum', options: ['low', 'medium', 'high', 'max'] },
    ],
    examples: ['!effort low', '!effort medium', '!effort high', '!effort max'],
    handler: async (args, ctx) => {
      if (!args) {
        const current = ctx.configOverrides.getEffort() ?? 'default (high)';
        return { type: 'dispatch', reply: `Current effort: ${current}. Available: ${EFFORT_LEVELS.join(', ')}.` };
      }
      const level = args.toLowerCase() as EffortLevel;
      if (!EFFORT_LEVELS.includes(level)) {
        return { type: 'dispatch', reply: `Invalid effort level "${args}". Valid: ${EFFORT_LEVELS.join(', ')}.` };
      }
      ctx.configOverrides.setEffort(level);
      return { type: 'handled', reply: `Effort level set to *${level}* for this thread.` };
    },
  }),

  defineCommand({
    name: 'budget',
    description: 'Set or view the cost budget limit for this thread',
    category: 'config',
    args: [
      { name: 'amount', description: 'Budget amount in dollars (e.g. 5.00)', required: false, type: 'number' },
    ],
    examples: ['!budget', '!budget 5.00', '!budget $10'],
    handler: async (args, ctx) => {
      if (!args) {
        const current = ctx.configOverrides.getBudget();
        const msg = current != null ? `Current budget: *$${current.toFixed(2)}*` : 'No budget limit set for this thread.';
        return { type: 'handled', reply: msg };
      }
      const amount = parseFloat(args.replace(/^\$/, ''));
      if (isNaN(amount) || amount <= 0) {
        return { type: 'dispatch', reply: `Invalid budget "${args}". Use a positive number, e.g. !budget 5.00` };
      }
      ctx.configOverrides.setBudget(amount);
      return { type: 'handled', reply: `Budget limit set to *$${amount.toFixed(2)}* per execution for this thread.` };
    },
  }),

  defineCommand({
    name: 'project',
    description: 'View or change the project directory for this thread',
    category: 'config',
    args: [
      { name: 'path', description: 'Relative or absolute path to project directory', required: false, type: 'string' },
    ],
    examples: ['!project', '!project ./my-project', '!project /Users/me/code/app'],
    handler: async (args, ctx) => {
      if (!args) {
        const current = ctx.configOverrides.getProjectDir() ?? ctx.config.projectDir;
        return { type: 'handled', reply: `Current project: \`${current}\`` };
      }
      const dir = resolve(ctx.config.projectDir, args.trim());
      if (!existsSync(dir)) {
        return { type: 'handled', reply: `Directory not found: \`${dir}\`` };
      }
      ctx.configOverrides.setProjectDir(dir);
      return { type: 'handled', reply: `Project set to \`${dir}\` for this thread.`, clearSession: true };
    },
  }),

  defineCommand({
    name: 'agent',
    description: 'View or switch the agent for this thread',
    category: 'config',
    args: [
      { name: 'name', description: 'Agent name, or "default"/"reset" to clear', required: false, type: 'string' },
    ],
    examples: ['!agent', '!agent my-agent', '!agent default'],
    handler: async (args, ctx) => {
      if (!args) {
        const current = ctx.configOverrides.getAgent();
        if (current) {
          return { type: 'handled', reply: `Current agent: \`${current}\`. Use \`!agent default\` to reset.` };
        }
        return { type: 'dispatch', reply: 'No custom agent set. Use !agents to list available agents, then !agent <name> to switch.' };
      }
      if (args.toLowerCase() === 'default' || args.toLowerCase() === 'reset') {
        ctx.configOverrides.deleteAgent();
        return { type: 'handled', reply: 'Agent reset to default. Session cleared.', clearSession: true };
      }
      ctx.configOverrides.setAgent(args);
      return { type: 'handled', reply: `Agent set to \`${args}\` for this thread. Session cleared.`, clearSession: true };
    },
  }),

  defineCommand({
    name: 'system',
    description: 'View, set, or clear the custom system prompt append for this thread',
    category: 'config',
    args: [
      { name: 'prompt', description: 'System prompt text to append, or "clear" to remove', required: false, type: 'string' },
    ],
    examples: ['!system', '!system Always respond in JSON.', '!system clear'],
    handler: async (args, ctx) => {
      if (!args) {
        const current = ctx.configOverrides.getSystemPromptAppend();
        if (current) {
          const preview = current.length > 500 ? current.slice(0, 500) + '...' : current;
          return { type: 'handled', reply: `Current system prompt append:\n> ${preview}\nUse \`!system clear\` to remove.` };
        }
        return { type: 'dispatch', reply: 'No custom system prompt set. Use `!system <prompt>` to append custom instructions, or `!system clear` to remove them.' };
      }
      if (args.toLowerCase() === 'clear') {
        ctx.configOverrides.deleteSystemPromptAppend();
        return { type: 'handled', reply: 'Custom system prompt cleared for this thread.' };
      }
      ctx.configOverrides.setSystemPromptAppend(args);
      const preview = args.length > 500 ? args.slice(0, 500) + '...' : args;
      return { type: 'handled', reply: `Custom system prompt set for this thread:\n> ${preview}` };
    },
  }),

  defineCommand({
    name: 'tools',
    description: 'View, allow, deny, or clear tool restrictions for this thread',
    category: 'config',
    args: [
      { name: 'subcommand', description: '"allow <list>", "deny <list>", "clear", or omit to view', required: false, type: 'string' },
    ],
    examples: ['!tools', '!tools allow Bash,Read', '!tools deny Write', '!tools clear'],
    handler: async (args, ctx) => {
      if (!args) {
        const current = ctx.configOverrides.getToolOverrides();
        if (current) {
          const parts: string[] = [];
          if (current.allowedTools?.length) parts.push(`Allowed: ${current.allowedTools.join(', ')}`);
          if (current.disallowedTools?.length) parts.push(`Denied: ${current.disallowedTools.join(', ')}`);
          return { type: 'handled', reply: `Tool restrictions:\n${parts.join('\n')}\nUse \`!tools clear\` to reset.` };
        }
        return { type: 'dispatch', reply: 'No tool restrictions set. Use `!tools allow Tool1,Tool2` to restrict, `!tools deny Tool1,Tool2` to block, or `!tools clear` to reset.' };
      }
      const sub = args.toLowerCase();
      if (sub === 'clear' || sub === 'reset') {
        ctx.configOverrides.deleteToolOverrides();
        return { type: 'handled', reply: 'Tool restrictions cleared for this thread.' };
      }
      const allowMatch = args.match(/^allow\s+(.+)/i);
      const denyMatch = args.match(/^deny\s+(.+)/i);
      if (allowMatch) {
        const tools = allowMatch[1].split(/[,\s]+/).filter(Boolean);
        const existing = ctx.configOverrides.getToolOverrides() ?? {};
        ctx.configOverrides.setToolOverrides({ ...existing, allowedTools: tools });
        return { type: 'handled', reply: `Allowed tools set: ${tools.join(', ')}` };
      }
      if (denyMatch) {
        const tools = denyMatch[1].split(/[,\s]+/).filter(Boolean);
        const existing = ctx.configOverrides.getToolOverrides() ?? {};
        ctx.configOverrides.setToolOverrides({ ...existing, disallowedTools: tools });
        return { type: 'handled', reply: `Denied tools set: ${tools.join(', ')}` };
      }
      return { type: 'dispatch', reply: `Invalid syntax "!tools ${args}". Use: !tools allow <list>, !tools deny <list>, or !tools clear.` };
    },
  }),
];
