// src/commands/diagnostic-commands.ts — Diagnostics & utility commands.

import { join } from 'node:path';
import { defineCommand } from './types.js';
import type { CommandDefinition } from './types.js';

// ── Usage formatting helpers (module-scoped) ─────────────────

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

// ── Commands ──────────────────────────────────────────────────

export const diagnosticCommands: CommandDefinition[] = [
  defineCommand({
    name: 'interrupt',
    aliases: ['stop'],
    description: 'Send an interrupt signal to the current execution',
    category: 'diagnostic',
    noArgBehavior: 'dispatch',
    handler: async (_args, ctx) => {
      if (!ctx.onInterrupt) {
        return { type: 'handled', reply: 'No interrupt handler available.' };
      }
      await ctx.onInterrupt();
      return { type: 'handled', reply: 'Interrupt signal sent.' };
    },
  }),

  defineCommand({
    name: 'cost',
    description: 'Show cost information for the current session',
    category: 'diagnostic',
    noArgBehavior: 'dispatch',
    handler: async () => {
      return { type: 'handled', reply: 'Cost tracking is managed by the orchestrator.' };
    },
  }),

  defineCommand({
    name: 'version',
    description: 'Show the Claude Code CLI version',
    category: 'diagnostic',
    noArgBehavior: 'dispatch',
    handler: async () => {
      try {
        const { execSync } = await import('node:child_process');
        const ver = execSync('claude --version', { encoding: 'utf-8', timeout: 5000 }).trim();
        return { type: 'handled', reply: `Claude Code CLI: \`${ver}\`` };
      } catch {
        return { type: 'handled', reply: ':x: Failed to get version.' };
      }
    },
  }),

  defineCommand({
    name: 'doctor',
    description: 'Run claude doctor to check the environment',
    category: 'diagnostic',
    noArgBehavior: 'dispatch',
    handler: async () => {
      try {
        const { execSync } = await import('node:child_process');
        const output = execSync('claude doctor 2>&1', { encoding: 'utf-8', timeout: 30000 }).trim();
        return { type: 'handled', reply: `\`\`\`\n${output.slice(0, 3000)}\n\`\`\`` };
      } catch (err: any) {
        const msg = err.stdout ? String(err.stdout) : String(err);
        return { type: 'handled', reply: `\`\`\`\n${msg.slice(0, 3000)}\n\`\`\`` };
      }
    },
  }),

  defineCommand({
    name: 'agents',
    description: 'List available Claude Code agents',
    category: 'diagnostic',
    noArgBehavior: 'dispatch',
    handler: async () => {
      try {
        const { execSync } = await import('node:child_process');
        const output = execSync('claude agents 2>&1', { encoding: 'utf-8', timeout: 10000 }).trim();
        return { type: 'handled', reply: `\`\`\`\n${output.slice(0, 3000)}\n\`\`\`` };
      } catch (err: any) {
        const msg = err.stdout ? String(err.stdout) : String(err);
        return { type: 'handled', reply: `\`\`\`\n${msg.slice(0, 3000)}\n\`\`\`` };
      }
    },
  }),

  defineCommand({
    name: 'log',
    description: 'Show log file paths for this thread',
    category: 'diagnostic',
    noArgBehavior: 'dispatch',
    handler: async (_args, ctx) => {
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
    },
  }),

  defineCommand({
    name: 'usage',
    description: 'Show Claude Code plan usage and limits',
    category: 'diagnostic',
    noArgBehavior: 'dispatch',
    handler: async () => {
      try {
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
          // Keychain entry not found
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

        if (!hasLimits && !limitsArr && !extra) {
          lines.push('```' + JSON.stringify(data, null, 2) + '```');
        }

        return { type: 'handled', reply: lines.join('\n') };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { type: 'handled', reply: `:x: Failed to get usage: ${msg}` };
      }
    },
  }),

  defineCommand({
    name: 'restart',
    description: 'Restart the bot gateway (handled by the gateway process)',
    category: 'diagnostic',
    noArgBehavior: 'dispatch',
    handler: async () => {
      return { type: 'handled', reply: '`!restart` is handled by the gateway. If this message appeared, the gateway did not intercept the command.' };
    },
  }),

  defineCommand({
    name: 'insights-report',
    description: 'Upload the latest Claude Code insights HTML report',
    category: 'diagnostic',
    noArgBehavior: 'dispatch',
    handler: async () => {
      try {
        const { stat } = await import('node:fs/promises');
        const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
        const reportPath = join(homeDir, '.claude', 'usage-data', 'report.html');
        const info = await stat(reportPath);
        const age = Date.now() - info.mtimeMs;
        const ageStr = age < 3_600_000
          ? `${Math.floor(age / 60_000)}m ago`
          : age < 86_400_000
            ? `${Math.floor(age / 3_600_000)}h ago`
            : `${Math.floor(age / 86_400_000)}d ago`;
        return {
          type: 'dispatch',
          reply: [
            `The user ran \`!insights-report\`. The latest insights HTML report is at:`,
            `\`${reportPath}\` (generated ${ageStr})`,
            '',
            'Read this file and upload it to the current Slack thread using the upload_file_to_slack MCP tool.',
            'If upload fails, share a brief summary of the report contents instead.',
          ].join('\n'),
        };
      } catch {
        return {
          type: 'handled',
          reply: 'No insights report found. Run `!insights` first to generate one.',
        };
      }
    },
  }),

  // SDK slash commands (forwarded directly to the Claude SDK)
  defineCommand({
    name: 'insights',
    description: 'Generate a usage report analyzing your Claude Code sessions (SDK command, may take a few minutes)',
    category: 'diagnostic',
    sdkSlashCommand: true,
  }),

  defineCommand({
    name: 'stats',
    description: 'Show session statistics (SDK command)',
    category: 'diagnostic',
    sdkSlashCommand: true,
  }),

  defineCommand({
    name: 'rewind',
    description: 'Rewind the conversation to a previous point (SDK command)',
    category: 'diagnostic',
    sdkSlashCommand: true,
  }),
];
