// src/commands/workflow-commands.ts — Workflow commands.

import { defineCommand } from './types.js';
import type { CommandDefinition } from './types.js';

export const workflowCommands: CommandDefinition[] = [
  defineCommand({
    name: 'clear',
    description: 'Clear session and reset all overrides',
    category: 'workflow',
    noArgBehavior: 'dispatch',
    handler: async (_args, ctx) => {
      ctx.configOverrides.reset();
      return { type: 'handled', reply: 'Session cleared. Next message will start a fresh conversation.', clearSession: true };
    },
  }),

  defineCommand({
    name: 'compact',
    description: 'Compact the current session context',
    category: 'workflow',
    noArgBehavior: 'dispatch',
    handler: async () => {
      return { type: 'dispatch', reply: '/compact' };
    },
  }),

  defineCommand({
    name: 'bg',
    description: 'Send the current execution to the background',
    category: 'workflow',
    noArgBehavior: 'dispatch',
    requiresExecution: true,
    handler: async (_args, ctx) => {
      const exec = ctx.currentExecution;
      if (!exec) {
        return { type: 'handled', reply: 'No active execution to background.' };
      }
      exec.isBackground = true;
      return { type: 'handled', reply: 'Execution sent to background.' };
    },
  }),

  defineCommand({
    name: 'status',
    description: 'Show current session status and configuration',
    category: 'workflow',
    noArgBehavior: 'dispatch',
    handler: async (_args, ctx) => {
      const model = ctx.configOverrides.getModel() ?? ctx.config.claudeModel;
      const mode = ctx.configOverrides.getPermissionMode() ?? ctx.config.permissionMode;
      const effort = ctx.configOverrides.getEffort();
      const budget = ctx.configOverrides.getBudget();
      const agent = ctx.configOverrides.getAgent();
      const systemPrompt = ctx.configOverrides.getSystemPromptAppend();
      const exec = ctx.currentExecution;
      const initInfo = ctx.initInfo;
      const accountInfo = ctx.accountInfo;
      const sessionCost = ctx.sessionCost ?? 0;

      const lines: string[] = [];
      if (initInfo) lines.push(`*Version:* ${initInfo.claudeCodeVersion}`);
      if (exec?.sessionId) lines.push(`*Session ID:* \`${exec.sessionId.slice(0, 8)}…\``);

      const projectOverride = ctx.configOverrides.getProjectDir();
      lines.push(`*cwd:* \`${projectOverride ?? initInfo?.cwd ?? ctx.config.projectDir}\``);
      if (projectOverride) lines.push(`*Project override:* \`${projectOverride}\``);

      if (accountInfo) {
        if (accountInfo.subscriptionType) lines.push(`*Login:* ${accountInfo.subscriptionType}`);
        if (accountInfo.organization) lines.push(`*Organization:* ${accountInfo.organization}`);
        if (accountInfo.email) lines.push(`*Email:* ${accountInfo.email}`);
      }

      lines.push('');

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

      lines.push(`*Mode:* ${mode}`);
      lines.push(`*Effort:* ${effort ?? 'medium (default)'}`);
      if (budget) lines.push(`*Budget:* $${budget.toFixed(2)}`);
      if (agent) lines.push(`*Agent:* ${agent}`);
      if (systemPrompt) lines.push('*System prompt:* set');
      if (sessionCost > 0) lines.push(`*Session cost:* $${sessionCost.toFixed(4)}`);

      const mcpServers = initInfo?.mcpServers ?? [];
      if (mcpServers.length > 0) {
        const statusIcon = (s: string) => s === 'connected' ? '✔' : s === 'needs-auth' ? '△' : '✖';
        const serverList = mcpServers.map((s) => `${s.name} ${statusIcon(s.status)}`).join(', ');
        lines.push(`*MCP servers:* ${serverList}`);
      }

      const plugins = initInfo?.plugins ?? [];
      if (plugins.length > 0) {
        const pluginNames = plugins.map((p) => p.name);
        lines.push(`*Plugins:* ${pluginNames.join(', ')}`);
      }

      return { type: 'handled', reply: lines.join('\n') };
    },
  }),

  defineCommand({
    name: 'help',
    description: 'Show available bot commands',
    category: 'workflow',
    noArgBehavior: 'dispatch',
    handler: async () => {
      return { type: 'dispatch', reply: 'User asked for help. Summarize available bot commands.' };
    },
  }),

  // SDK slash commands (dispatched directly to the Claude SDK)
  defineCommand({ name: 'context', description: 'Show current context window usage', category: 'workflow', sdkSlashCommand: true }),
  defineCommand({ name: 'plan', description: 'Enable plan mode or view current session plan', category: 'workflow', sdkSlashCommand: true, args: [{ name: 'instructions', description: 'Planning instructions', required: false, type: 'string' }] }),
  defineCommand({ name: 'resume', description: 'Resume a previous session or plan', category: 'workflow', sdkSlashCommand: true }),
  defineCommand({
    name: 'files',
    description: 'List files currently in context',
    category: 'workflow',
    handler: async () => {
      return { type: 'forward', reply: 'The user ran `!files`. List all files currently in your conversation context, showing their file paths.' };
    },
  }),
  defineCommand({ name: 'summary', description: 'Generate a summary of the current session', category: 'workflow', sdkSlashCommand: true }),
  defineCommand({ name: 'brief', description: 'Toggle brief response mode', category: 'workflow', sdkSlashCommand: true }),
  defineCommand({ name: 'fast', description: 'Toggle fast mode for quicker responses', category: 'workflow', sdkSlashCommand: true }),
  defineCommand({
    name: 'skills',
    description: 'List available skills',
    category: 'workflow',
    noArgBehavior: 'dispatch',
    handler: async (_args, ctx) => {
      if (!ctx.getSupportedCommands) {
        return { type: 'handled', reply: 'Skills listing is not available in this context.' };
      }
      const commands = await ctx.getSupportedCommands();
      if (!commands) {
        return { type: 'handled', reply: 'No active session. Send a message first, then use `!skills` to list available skills.' };
      }
      if (commands.length === 0) {
        return { type: 'handled', reply: 'No skills available in the current session.' };
      }
      const lines = ['*Available Skills:*', ''];
      for (const cmd of commands) {
        const hint = cmd.argumentHint ? ` \`${cmd.argumentHint}\`` : '';
        const desc = cmd.description ? ` — ${cmd.description}` : '';
        lines.push(`• \`/${cmd.name}\`${hint}${desc}`);
      }
      return { type: 'handled', reply: lines.join('\n') };
    },
  }),
];
