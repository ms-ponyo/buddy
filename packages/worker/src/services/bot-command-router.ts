// src/services/bot-command-router.ts — Lean command router.
// Parses "!command args" messages, routes to registered handlers.
// Individual handler logic lives in bot-command-handlers.ts.

import type { Logger } from '../logger.js';
import type { ParsedCommand, BuddyConfig, ActiveExecution } from '../types.js';
import type { ConfigOverrides } from './config-overrides.js';
import type { InitInfo, AccountInfo } from './claude-session.js';
import {
  handleModel,
  handleMode,
  handleEffort,
  handleBudget,
  handleClear,
  handleStatus,
  handleHelp,
  handleInterrupt,
  handleCost,
  handleUsage,
  handleCompact,
  handleBg,
  handleVersion,
  handleDoctor,
  handleAgents,
  handleFallback,
  handleAgent,
  handleSystem,
  handleTools,
  handleWorktree,
  handlePr,
  handleLog,
  handleRestart,
  type CommandHandler,
  type CommandHandlerResult,
  type CommandContext,
} from './bot-command-handlers.js';

// ── No-arg commands: if args are present, dispatch to LLM ────────

const NO_ARG_COMMANDS = new Set([
  'compact', 'cost', 'usage', 'interrupt', 'stop', 'bg',
  'status', 'help', 'restart', 'version', 'doctor', 'agents', 'log',
]);

// ── Constructor deps ─────────────────────────────────────────────

export interface BotCommandRouterDeps {
  logger: Logger;
  configOverrides: ConfigOverrides;
  config: BuddyConfig;
  /** Getter for current execution state (from WorkerLoop) */
  getCurrentExecution?: () => ActiveExecution | null;
  /** Worker log file path */
  logFile?: string;
  /** Getter for cached SDK init info */
  getInitInfo?: () => InitInfo | null;
  /** Getter for cached account info */
  getAccountInfo?: () => AccountInfo | null;
  /** Getter for session cost from persistence */
  getSessionCost?: () => Promise<number>;
}

// ── BotCommandRouter ─────────────────────────────────────────────

export class BotCommandRouter {
  private readonly logger: Logger;
  private readonly configOverrides: ConfigOverrides;
  private readonly config: BuddyConfig;
  private readonly getCurrentExecution?: () => ActiveExecution | null;
  private readonly logFile?: string;
  private readonly getInitInfo?: () => InitInfo | null;
  private readonly getAccountInfo?: () => AccountInfo | null;
  private readonly getSessionCost?: () => Promise<number>;
  private readonly commands = new Map<string, CommandHandler>();

  constructor(deps: BotCommandRouterDeps) {
    this.logger = deps.logger;
    this.configOverrides = deps.configOverrides;
    this.config = deps.config;
    this.getCurrentExecution = deps.getCurrentExecution;
    this.logFile = deps.logFile;
    this.getInitInfo = deps.getInitInfo;
    this.getAccountInfo = deps.getAccountInfo;
    this.getSessionCost = deps.getSessionCost;

    // Register built-in handlers
    this.commands.set('model', handleModel);
    this.commands.set('mode', handleMode);
    this.commands.set('effort', handleEffort);
    this.commands.set('budget', handleBudget);
    this.commands.set('clear', handleClear);
    this.commands.set('status', handleStatus);
    this.commands.set('help', handleHelp);
    this.commands.set('interrupt', handleInterrupt);
    this.commands.set('stop', handleInterrupt);
    this.commands.set('cost', handleCost);
    this.commands.set('usage', handleUsage);
    this.commands.set('compact', handleCompact);
    this.commands.set('bg', handleBg);
    this.commands.set('version', handleVersion);
    this.commands.set('doctor', handleDoctor);
    this.commands.set('agents', handleAgents);
    this.commands.set('fallback', handleFallback);
    this.commands.set('agent', handleAgent);
    this.commands.set('system', handleSystem);
    this.commands.set('tools', handleTools);
    this.commands.set('worktree', handleWorktree);
    this.commands.set('pr', handlePr);
    this.commands.set('log', handleLog);
    this.commands.set('restart', handleRestart);
  }

  // ── parse ───────────────────────────────────────────────────────

  /**
   * Parse text into a command + args if it starts with `!`.
   * Returns undefined if not a command.
   */
  parse(text: string): ParsedCommand | undefined {
    const match = text.match(/^!(\S+)\s*(.*)/s);
    if (!match) return undefined;
    return { command: match[1].toLowerCase(), args: match[2].trim() };
  }

  // ── rewriteSlashCommand ─────────────────────────────────────────

  /**
   * Convert `!slash-command args` to `/slash-command args` for the SDK.
   */
  rewriteSlashCommand(text: string): string {
    if (/^!\S/.test(text)) {
      return '/' + text.slice(1);
    }
    return text;
  }

  // ── hasCommand ──────────────────────────────────────────────────

  /**
   * Check if a command is registered in the router.
   */
  hasCommand(name: string): boolean {
    return this.commands.has(name);
  }

  // ── registerCommand ─────────────────────────────────────────────

  /**
   * Register a custom command handler.
   */
  registerCommand(name: string, handler: CommandHandler): void {
    this.commands.set(name, handler);
  }

  // ── execute ─────────────────────────────────────────────────────

  /**
   * Execute a parsed command. Returns a result indicating whether
   * the command was handled locally or should be dispatched to the LLM.
   */
  async execute(parsed: ParsedCommand): Promise<CommandHandlerResult> {
    this.logger.info('Bot command', { command: parsed.command, args: parsed.args || undefined });

    // No-arg commands with unexpected args → dispatch to LLM
    if (NO_ARG_COMMANDS.has(parsed.command) && parsed.args) {
      this.logger.info('No-arg command has args, dispatching', {
        command: parsed.command,
        args: parsed.args,
      });
      return {
        type: 'dispatch',
        reply: `!${parsed.command} ${parsed.args}`,
      };
    }

    const handler = this.commands.get(parsed.command);
    if (!handler) {
      return {
        type: 'dispatch',
        reply: `Unknown command "!${parsed.command}". Dispatching to assistant.`,
      };
    }

    const sessionCost = await this.getSessionCost?.() ?? 0;

    const ctx: CommandContext = {
      config: this.config,
      configOverrides: this.configOverrides,
      currentExecution: this.getCurrentExecution?.() ?? null,
      logFile: this.logFile,
      initInfo: this.getInitInfo?.() ?? null,
      accountInfo: this.getAccountInfo?.() ?? null,
      sessionCost,
    };

    return handler(parsed.args, ctx);
  }
}
