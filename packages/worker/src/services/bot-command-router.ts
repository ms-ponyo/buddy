// src/services/bot-command-router.ts — Metadata-driven command router.
// Parses "!command args" messages, routes to handlers based on CommandDefinition metadata.
// All behavior (no-arg dispatch, aliases, SDK forwarding) is derived from definitions.

import type { Logger } from '../logger.js';
import type { ParsedCommand, BuddyConfig, ActiveExecution } from '../types.js';
import type { ConfigOverrides } from './config-overrides.js';
import type { InitInfo, AccountInfo, SDKSlashCommand } from './claude-session.js';
import type { CommandDefinition, CommandContext, CommandHandlerResult } from '../commands/types.js';
import { formatCatalogForLLM } from '../commands/index.js';

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
  /** Callback to interrupt the current execution */
  onInterrupt?: () => void | Promise<void>;
  /** Sync permission mode to the SDK session when changed via bot commands. */
  onPermissionModeChange?: (mode: string) => void;
  /** Getter for supported SDK commands/skills from the active query. */
  getSupportedCommands?: () => Promise<SDKSlashCommand[] | null>;
}

// ── BotCommandRouter ─────────────────────────────────────────────

export class BotCommandRouter {
  private readonly logger: Logger;
  private readonly deps: BotCommandRouterDeps;
  private readonly commands = new Map<string, CommandDefinition>();
  private readonly definitions: CommandDefinition[];

  constructor(deps: BotCommandRouterDeps, definitions: CommandDefinition[]) {
    this.logger = deps.logger;
    this.deps = deps;
    this.definitions = definitions;

    for (const def of definitions) {
      this.commands.set(def.name, def);
      for (const alias of def.aliases ?? []) {
        this.commands.set(alias, def);
      }
    }
  }

  parse(text: string): ParsedCommand | undefined {
    const match = text.match(/^!(\S+)\s*(.*)/s);
    if (!match) return undefined;
    return { command: match[1].toLowerCase(), args: match[2].trim() };
  }

  rewriteSlashCommand(text: string): string {
    if (/^!\S/.test(text)) {
      return '/' + text.slice(1);
    }
    return text;
  }

  hasCommand(name: string): boolean {
    return this.commands.has(name);
  }

  isSDKSlashCommand(name: string): boolean {
    const def = this.commands.get(name);
    return def?.sdkSlashCommand === true;
  }

  getCatalog(): CommandDefinition[] {
    return this.definitions;
  }

  getFormattedCatalog(): string {
    return formatCatalogForLLM(this.definitions);
  }

  async execute(parsed: ParsedCommand): Promise<CommandHandlerResult> {
    this.logger.info('Bot command', { command: parsed.command, args: parsed.args || undefined });

    const def = this.commands.get(parsed.command);
    if (!def) {
      return {
        type: 'dispatch',
        reply: `Unknown command "!${parsed.command}". Dispatching to assistant.`,
      };
    }

    // SDK commands should not reach execute() — they are forwarded before this point
    if (def.sdkSlashCommand) {
      return {
        type: 'dispatch',
        reply: `!${parsed.command} is an SDK command. Forwarding to SDK session.`,
      };
    }

    // No-arg commands with unexpected args → dispatch to LLM
    if (def.noArgBehavior === 'dispatch' && parsed.args) {
      this.logger.info('No-arg command has args, dispatching', {
        command: parsed.command,
        args: parsed.args,
      });
      return {
        type: 'dispatch',
        reply: `!${parsed.command} ${parsed.args}`,
      };
    }

    const sessionCost = await this.deps.getSessionCost?.() ?? 0;

    const ctx: CommandContext = {
      config: this.deps.config,
      configOverrides: this.deps.configOverrides,
      currentExecution: this.deps.getCurrentExecution?.() ?? null,
      logFile: this.deps.logFile,
      initInfo: this.deps.getInitInfo?.() ?? null,
      accountInfo: this.deps.getAccountInfo?.() ?? null,
      sessionCost,
      onInterrupt: this.deps.onInterrupt,
      onPermissionModeChange: this.deps.onPermissionModeChange,
      getSupportedCommands: this.deps.getSupportedCommands,
    };

    return def.handler(parsed.args, ctx);
  }
}
