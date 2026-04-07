// src/services/bot-command-handlers.ts — Pure handler functions for bot commands.
// Each handler takes (args, ctx) and returns a CommandHandlerResult.

import type { ConfigOverrides, EffortLevel } from './config-overrides.js';
import type { BuddyConfig, ThreadPermissionMode, ActiveExecution } from '../types.js';
import type { InitInfo, AccountInfo } from './claude-session.js';

// ── Types ─────────────────────────────────────────────────────────

export interface CommandHandlerResult {
  type: 'handled' | 'dispatch';
  reply?: string;
  clearSession?: boolean;
}

export interface CommandContext {
  config: BuddyConfig;
  configOverrides: ConfigOverrides;
  /** Current execution state (from WorkerLoop), if running */
  currentExecution?: ActiveExecution | null;
  /** Log file path for this thread's worker */
  logFile?: string;
  /** Cached SDK init info (version, cwd, MCP servers, plugins) */
  initInfo?: InitInfo | null;
  /** Cached account info (email, organization, subscription) */
  accountInfo?: AccountInfo | null;
  /** Session cost from persistence */
  sessionCost?: number;
}

export type CommandHandler = (args: string, ctx: CommandContext) => Promise<CommandHandlerResult>;

// ── Known models ──────────────────────────────────────────────────

const MODEL_OPTIONS = [
  { label: 'Sonnet 4.6', model: 'claude-sonnet-4-6' },
  { label: 'Opus 4.6', model: 'claude-opus-4-6' },
  { label: 'Haiku 4.5', model: 'claude-haiku-4-5-20251001' },
];

// ── Mode map ──────────────────────────────────────────────────────

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

// ── Effort levels ─────────────────────────────────────────────────

const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'max'];

// ── Handlers ──────────────────────────────────────────────────────

export const handleModel: CommandHandler = async (args, ctx) => {
  if (!args) {
    const modelNames = MODEL_OPTIONS.map((o) => o.model).join(', ');
    return {
      type: 'dispatch',
      reply: `Available models: ${modelNames}. Specify one with !model <name>.`,
    };
  }

  const matched = MODEL_OPTIONS.find((o) => o.model === args);
  if (!matched) {
    const modelNames = MODEL_OPTIONS.map((o) => o.model).join(', ');
    return {
      type: 'dispatch',
      reply: `Unknown model "${args}". Available: ${modelNames}.`,
    };
  }

  ctx.configOverrides.setModel(matched.model);
  return { type: 'handled', reply: `Model set to \`${matched.model}\` for this thread.` };
};

export const handleMode: CommandHandler = async (args, ctx) => {
  if (!args) {
    return {
      type: 'dispatch',
      reply: 'Available modes: default, acceptEdits, bypassPermissions, dontAsk, plan, auto.',
    };
  }

  const modeArg = args.toLowerCase().trim();
  const newMode = MODE_MAP[modeArg];
  if (!newMode) {
    return {
      type: 'dispatch',
      reply: `Unknown mode "${args}". Valid modes: default, acceptEdits, bypassPermissions, dontAsk, plan, auto.`,
    };
  }

  ctx.configOverrides.setPermissionMode(newMode);
  return { type: 'handled', reply: `Permission mode set to *${MODE_LABELS[newMode]}* for this thread.` };
};

export const handleEffort: CommandHandler = async (args, ctx) => {
  if (!args) {
    const current = ctx.configOverrides.getEffort() ?? 'default (high)';
    return {
      type: 'dispatch',
      reply: `Current effort: ${current}. Available: ${EFFORT_LEVELS.join(', ')}.`,
    };
  }

  const level = args.toLowerCase() as EffortLevel;
  if (!EFFORT_LEVELS.includes(level)) {
    return {
      type: 'dispatch',
      reply: `Invalid effort level "${args}". Valid: ${EFFORT_LEVELS.join(', ')}.`,
    };
  }

  ctx.configOverrides.setEffort(level);
  return { type: 'handled', reply: `Effort level set to *${level}* for this thread.` };
};

export const handleBudget: CommandHandler = async (args, ctx) => {
  if (!args) {
    const current = ctx.configOverrides.getBudget();
    const msg = current != null
      ? `Current budget: *$${current.toFixed(2)}*`
      : 'No budget limit set for this thread.';
    return { type: 'handled', reply: msg };
  }

  const amount = parseFloat(args.replace(/^\$/, ''));
  if (isNaN(amount) || amount <= 0) {
    return {
      type: 'dispatch',
      reply: `Invalid budget "${args}". Use a positive number, e.g. !budget 5.00`,
    };
  }

  ctx.configOverrides.setBudget(amount);
  return { type: 'handled', reply: `Budget limit set to *$${amount.toFixed(2)}* per execution for this thread.` };
};

export const handleClear: CommandHandler = async (_args, ctx) => {
  ctx.configOverrides.reset();
  return {
    type: 'handled',
    reply: 'Session cleared. Next message will start a fresh conversation.',
    clearSession: true,
  };
};

export const handleStatus: CommandHandler = async (_args, ctx) => {
  const model = ctx.configOverrides.getModel() ?? ctx.config.claudeModel;
  const mode = ctx.configOverrides.getPermissionMode() ?? ctx.config.permissionMode;
  const effort = ctx.configOverrides.getEffort();
  const budget = ctx.configOverrides.getBudget();
  const fallback = ctx.configOverrides.getFallbackModel();
  const agent = ctx.configOverrides.getAgent();
  const systemPrompt = ctx.configOverrides.getSystemPromptAppend();
  const exec = ctx.currentExecution;
  const initInfo = ctx.initInfo;
  const accountInfo = ctx.accountInfo;
  const sessionCost = ctx.sessionCost ?? 0;

  const lines: string[] = [];

  // Version
  if (initInfo) lines.push(`*Version:* ${initInfo.claudeCodeVersion}`);

  // Session ID
  if (exec?.sessionId) lines.push(`*Session ID:* \`${exec.sessionId.slice(0, 8)}\u2026\``);

  // cwd
  lines.push(`*cwd:* \`${initInfo?.cwd ?? ctx.config.projectDir}\``);

  // Account info
  if (accountInfo) {
    if (accountInfo.subscriptionType) lines.push(`*Login:* ${accountInfo.subscriptionType}`);
    if (accountInfo.organization) lines.push(`*Organization:* ${accountInfo.organization}`);
    if (accountInfo.email) lines.push(`*Email:* ${accountInfo.email}`);
  }

  lines.push(''); // blank line separator

  // Execution status
  if (exec) {
    const elapsed = Math.round((Date.now() - exec.createdAt) / 1000);
    lines.push(`*Status:* ${exec.interrupted ? 'Interrupted' : exec.isBackground ? 'Running (background)' : 'Running'}`);
    lines.push(`*Model:* \`${exec.model}\``);
    lines.push(`*Tools used:* ${exec.toolCount}`);
    lines.push(`*Files changed:* ${exec.filesChanged.size}`);
    lines.push(`*Elapsed:* ${elapsed}s`);
    if (exec.usage) {
      lines.push(`*Context:* ${exec.usage.contextWindowPercent}% | *Turns:* ${exec.usage.numTurns}`);
    }
  } else {
    lines.push('*Status:* Idle');
    lines.push(`*Model:* \`${model}\``);
  }

  // Config overrides
  lines.push(`*Mode:* ${mode}`);
  lines.push(`*Effort:* ${effort ?? 'medium (default)'}`);
  if (budget) lines.push(`*Budget:* $${budget.toFixed(2)}`);
  if (fallback) lines.push(`*Fallback model:* \`${fallback}\``);
  if (agent) lines.push(`*Agent:* ${agent}`);
  if (systemPrompt) lines.push('*System prompt:* set');
  if (sessionCost > 0) lines.push(`*Session cost:* $${sessionCost.toFixed(4)}`);

  // MCP servers (from init message — includes status)
  const mcpServers = initInfo?.mcpServers ?? [];
  if (mcpServers.length > 0) {
    const statusIcon = (s: string) => s === 'connected' ? '\u2714' : s === 'needs-auth' ? '\u25B3' : '\u2716';
    const serverList = mcpServers.map((s) => `${s.name} ${statusIcon(s.status)}`).join(', ');
    lines.push(`*MCP servers:* ${serverList}`);
  }

  // Plugins (from init message)
  const plugins = initInfo?.plugins ?? [];
  if (plugins.length > 0) {
    const pluginNames = plugins.map((p) => p.name);
    lines.push(`*Plugins:* ${pluginNames.join(', ')}`);
  }

  return { type: 'handled', reply: lines.join('\n') };
};

export const handleHelp: CommandHandler = async () => {
  return {
    type: 'dispatch',
    reply: 'User asked for help. Summarize available bot commands.',
  };
};

export const handleInterrupt: CommandHandler = async () => {
  // Interrupt is signaled via the result; the orchestrator acts on it.
  return { type: 'handled', reply: 'Interrupt signal sent.' };
};

export const handleCost: CommandHandler = async () => {
  return { type: 'handled', reply: 'Cost tracking is managed by the orchestrator.' };
};

// ── Compact ──────────────────────────────────────────────────────

export const handleCompact: CommandHandler = async () => {
  // Dispatch /compact to the main worker session
  return { type: 'dispatch', reply: '/compact' };
};

// ── Background ───────────────────────────────────────────────────

export const handleBg: CommandHandler = async (_args, ctx) => {
  const exec = ctx.currentExecution;
  if (!exec) {
    return { type: 'handled', reply: 'No active execution to background.' };
  }
  exec.isBackground = true;
  return { type: 'handled', reply: 'Execution sent to background.' };
};

// ── Version ──────────────────────────────────────────────────────

export const handleVersion: CommandHandler = async () => {
  try {
    const { execSync } = await import('node:child_process');
    const ver = execSync('claude --version', { encoding: 'utf-8', timeout: 5000 }).trim();
    return { type: 'handled', reply: `Claude Code CLI: \`${ver}\`` };
  } catch {
    return { type: 'handled', reply: ':x: Failed to get version.' };
  }
};

// ── Doctor ───────────────────────────────────────────────────────

export const handleDoctor: CommandHandler = async () => {
  try {
    const { execSync } = await import('node:child_process');
    const output = execSync('claude doctor 2>&1', { encoding: 'utf-8', timeout: 30000 }).trim();
    return { type: 'handled', reply: `\`\`\`\n${output.slice(0, 3000)}\n\`\`\`` };
  } catch (err: any) {
    const msg = err.stdout ? String(err.stdout) : String(err);
    return { type: 'handled', reply: `\`\`\`\n${msg.slice(0, 3000)}\n\`\`\`` };
  }
};

// ── Agents ───────────────────────────────────────────────────────

export const handleAgents: CommandHandler = async () => {
  try {
    const { execSync } = await import('node:child_process');
    const output = execSync('claude agents 2>&1', { encoding: 'utf-8', timeout: 10000 }).trim();
    return { type: 'handled', reply: `\`\`\`\n${output.slice(0, 3000)}\n\`\`\`` };
  } catch (err: any) {
    const msg = err.stdout ? String(err.stdout) : String(err);
    return { type: 'handled', reply: `\`\`\`\n${msg.slice(0, 3000)}\n\`\`\`` };
  }
};

// ── Fallback model ───────────────────────────────────────────────

export const handleFallback: CommandHandler = async (args, ctx) => {
  if (!args) {
    const current = ctx.configOverrides.getFallbackModel();
    if (current) {
      return { type: 'handled', reply: `Current fallback model: \`${current}\`` };
    }
    const modelNames = MODEL_OPTIONS.map((o) => o.model).join(', ');
    return {
      type: 'dispatch',
      reply: `No fallback model set. Available: ${modelNames}. Help them pick one.`,
    };
  }

  const matched = MODEL_OPTIONS.find((o) => o.model === args);
  if (!matched) {
    const modelNames = MODEL_OPTIONS.map((o) => o.model).join(', ');
    return {
      type: 'dispatch',
      reply: `Unknown model "${args}". Available: ${modelNames}. Help them pick one.`,
    };
  }

  ctx.configOverrides.setFallbackModel(matched.model);
  return { type: 'handled', reply: `Fallback model set to \`${matched.model}\` for this thread.` };
};

// ── Agent override ───────────────────────────────────────────────

export const handleAgent: CommandHandler = async (args, ctx) => {
  if (!args) {
    const current = ctx.configOverrides.getAgent();
    if (current) {
      return { type: 'handled', reply: `Current agent: \`${current}\`. Use \`!agent default\` to reset.` };
    }
    return {
      type: 'dispatch',
      reply: 'No custom agent set. Use !agents to list available agents, then !agent <name> to switch.',
    };
  }

  if (args.toLowerCase() === 'default' || args.toLowerCase() === 'reset') {
    ctx.configOverrides.deleteAgent();
    return { type: 'handled', reply: 'Agent reset to default. Session cleared.', clearSession: true };
  }

  ctx.configOverrides.setAgent(args);
  return { type: 'handled', reply: `Agent set to \`${args}\` for this thread. Session cleared.`, clearSession: true };
};

// ── System prompt ────────────────────────────────────────────────

export const handleSystem: CommandHandler = async (args, ctx) => {
  if (!args) {
    const current = ctx.configOverrides.getSystemPromptAppend();
    if (current) {
      const preview = current.length > 500 ? current.slice(0, 500) + '...' : current;
      return { type: 'handled', reply: `Current system prompt append:\n> ${preview}\nUse \`!system clear\` to remove.` };
    }
    return {
      type: 'dispatch',
      reply: 'No custom system prompt set. Use `!system <prompt>` to append custom instructions, or `!system clear` to remove them.',
    };
  }

  if (args.toLowerCase() === 'clear') {
    ctx.configOverrides.deleteSystemPromptAppend();
    return { type: 'handled', reply: 'Custom system prompt cleared for this thread.' };
  }

  ctx.configOverrides.setSystemPromptAppend(args);
  const preview = args.length > 500 ? args.slice(0, 500) + '...' : args;
  return { type: 'handled', reply: `Custom system prompt set for this thread:\n> ${preview}` };
};

// ── Tools override ───────────────────────────────────────────────

export const handleTools: CommandHandler = async (args, ctx) => {
  if (!args) {
    const current = ctx.configOverrides.getToolOverrides();
    if (current) {
      const parts: string[] = [];
      if (current.allowedTools?.length) parts.push(`Allowed: ${current.allowedTools.join(', ')}`);
      if (current.disallowedTools?.length) parts.push(`Denied: ${current.disallowedTools.join(', ')}`);
      return { type: 'handled', reply: `Tool restrictions:\n${parts.join('\n')}\nUse \`!tools clear\` to reset.` };
    }
    return {
      type: 'dispatch',
      reply: 'No tool restrictions set. Use `!tools allow Tool1,Tool2` to restrict, `!tools deny Tool1,Tool2` to block, or `!tools clear` to reset.',
    };
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

  return {
    type: 'dispatch',
    reply: `Invalid syntax "!tools ${args}". Use: !tools allow <list>, !tools deny <list>, or !tools clear.`,
  };
};

// ── Worktree ─────────────────────────────────────────────────────

export const handleWorktree: CommandHandler = async (args) => {
  const wtName = args || undefined;
  return {
    type: 'dispatch',
    reply: `User wants to create a git worktree${wtName ? ` named "${wtName}"` : ''}. Start a new session with the --worktree flag. Tell them you'll create an isolated worktree for their work.`,
  };
};

// ── PR ───────────────────────────────────────────────────────────

export const handlePr: CommandHandler = async (args) => {
  if (!args) {
    return {
      type: 'dispatch',
      reply: 'User typed !pr without a PR number or URL. They want to start a session from a pull request\'s context. Ask them for the PR number or URL.',
    };
  }
  return {
    type: 'dispatch',
    reply: `User wants to start a session from PR ${args}. Use the --from-pr flag to load the PR context. Help them get started.`,
  };
};

// ── Log ──────────────────────────────────────────────────────────

export const handleLog: CommandHandler = async (_args, ctx) => {
  const logFile = ctx.logFile ?? 'unknown';
  const lines = [
    'The user ran "!log" to view execution logs for this thread. Here are the relevant files:',
    '',
    `- **Session log** (detailed runtime log): \`${logFile}\``,
    `- **Main bot log**: \`${ctx.config.logFile}\``,
    '',
    'Introduce yourself and list these files. The user can ask you to read and analyze any of them.',
  ];
  return { type: 'dispatch', reply: lines.join('\n') };
};

// ── Restart ──────────────────────────────────────────────────────
// Note: !restart is handled by the gateway, not the worker.
// If it somehow reaches here, inform the user.

export const handleRestart: CommandHandler = async () => {
  return { type: 'handled', reply: '`!restart` is handled by the gateway. If this message appeared, the gateway did not intercept the command.' };
};

// ── Usage formatting helpers ─────────────────────────────────────────

function progressBar(pct: number, width = 20): string {
  const filled = Math.round((pct / 100) * width);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled);
}

function formatReset(isoDate: string): string {
  const d = new Date(isoDate);
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  if (diffMs <= 0) return 'now';
  const hours = Math.floor(diffMs / 3_600_000);
  const mins = Math.floor((diffMs % 3_600_000) / 60_000);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `in ${days}d`;
  }
  if (hours > 0) return `in ${hours}h ${mins}m`;
  return `in ${mins}m`;
}

// ── Usage handler ────────────────────────────────────────────────────

export const handleUsage: CommandHandler = async () => {
  try {
    // Read OAuth token from macOS keychain
    const { execSync } = await import('node:child_process');
    let token: string | undefined;
    try {
      const raw = execSync(
        'security find-generic-password -s "Claude Code-credentials" -w',
        { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim();
      const creds = JSON.parse(raw);
      token = creds?.claudeAiOauth?.accessToken;
    } catch {
      // Keychain entry not found — no OAuth credentials available
    }
    if (!token) {
      return { type: 'handled', reply: 'Usage data unavailable (no OAuth credentials in keychain).' };
    }

    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'claude-code/2.1.74',
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const body = await res.text();
      return { type: 'handled', reply: `:x: Usage API error (${res.status}): ${body}` };
    }
    const data = await res.json() as Record<string, unknown>;

    // Format usage data
    const lines: string[] = ['*Claude Code Plan Usage:*'];

    type Limit = { utilization?: number | null; resets_at?: string };
    const limitNames: Record<string, string> = {
      five_hour: '5-hour',
      seven_day: '7-day',
      seven_day_sonnet: '7-day Sonnet',
      seven_day_opus: '7-day Opus',
      seven_day_oauth_apps: '7-day OAuth apps',
      seven_day_cowork: '7-day Cowork',
    };
    let hasLimits = false;
    for (const [key, label] of Object.entries(limitNames)) {
      const limit = data[key] as Limit | null | undefined;
      if (limit && limit.utilization != null) {
        hasLimits = true;
        const pct = `${Math.floor(limit.utilization)}%`;
        const bar = progressBar(limit.utilization);
        const resetStr = limit.resets_at ? ` \u00b7 resets ${formatReset(limit.resets_at)}` : '';
        lines.push(`\`${bar}\` *${pct} used* (${label})${resetStr}`);
      }
    }

    // Legacy: support old limits array format
    const limitsArr = data.limits as Limit[] | undefined;
    if (Array.isArray(limitsArr)) {
      for (const limit of limitsArr) {
        hasLimits = true;
        const pct = limit.utilization != null ? `${Math.floor(limit.utilization)}%` : 'N/A';
        const bar = limit.utilization != null ? progressBar(limit.utilization) : '';
        const resetStr = limit.resets_at ? ` \u00b7 resets ${formatReset(limit.resets_at)}` : '';
        lines.push(`\`${bar}\` *${pct} used*${resetStr}`);
      }
    }

    // Format extra usage
    type ExtraUsage = { is_enabled?: boolean; used_credits?: number; monthly_limit?: number | null; utilization?: number };
    const extra = data.extra_usage as ExtraUsage | undefined;
    if (extra) {
      if (!extra.is_enabled) {
        lines.push('\u2022 Extra usage: not enabled');
      } else if (extra.monthly_limit === null) {
        lines.push('\u2022 Extra usage: unlimited');
      } else if (typeof extra.used_credits === 'number' && typeof extra.monthly_limit === 'number') {
        const used = (extra.used_credits / 100).toFixed(2);
        const limitAmt = (extra.monthly_limit / 100).toFixed(2);
        lines.push(`\u2022 Extra usage: $${used} / $${limitAmt}`);
      }
    }

    // Fallback: dump raw JSON if no recognized fields
    if (!hasLimits && !limitsArr && !extra) {
      lines.push('```' + JSON.stringify(data, null, 2) + '```');
    }

    return { type: 'handled', reply: lines.join('\n') };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { type: 'handled', reply: `:x: Failed to get usage: ${msg}` };
  }
};
