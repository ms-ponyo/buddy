// src/commands/types.ts — Command definition types and defineCommand() helper.

import type { ConfigOverrides } from '../services/config-overrides.js';
import type { BuddyConfig, ActiveExecution } from '../types.js';
import type { InitInfo, AccountInfo, SDKSlashCommand } from '../services/claude-session.js';

// ── Categories ──────────────────────────────────────────────────

export type CommandCategory = 'config' | 'workflow' | 'git' | 'diagnostic' | 'advanced';

export type WorkerTarget = 'lite' | 'main' | 'either';

// ── Arg schema ──────────────────────────────────────────────────

export interface CommandArg {
  name: string;
  description: string;
  required: boolean;
  type: 'string' | 'number' | 'enum';
  options?: string[];
}

// ── Handler types ───────────────────────────────────────────────

export interface CommandHandlerResult {
  type: 'handled' | 'dispatch' | 'forward';
  reply?: string;
  clearSession?: boolean;
}

export interface CommandContext {
  config: BuddyConfig;
  configOverrides: ConfigOverrides;
  currentExecution?: ActiveExecution | null;
  logFile?: string;
  initInfo?: InitInfo | null;
  accountInfo?: AccountInfo | null;
  sessionCost?: number;
  onInterrupt?: () => void | Promise<void>;
  onPermissionModeChange?: (mode: string) => void;
  getSupportedCommands?: () => Promise<SDKSlashCommand[] | null>;
}

export type CommandHandler = (args: string, ctx: CommandContext) => Promise<CommandHandlerResult>;

// ── Command definition (discriminated union) ────────────────────

interface BaseCommandDefinition {
  name: string;
  description: string;
  category: CommandCategory;
  aliases?: string[];
  args?: CommandArg[];
  examples?: string[];
  noArgBehavior?: 'dispatch';
  requiresExecution?: boolean;
}

interface SDKCommandDefinition extends BaseCommandDefinition {
  sdkSlashCommand: true;
  workerTarget?: never;
  handler?: never;
}

interface HandledCommandDefinition extends BaseCommandDefinition {
  sdkSlashCommand?: false;
  workerTarget?: WorkerTarget;
  handler: CommandHandler;
}

export type CommandDefinition = SDKCommandDefinition | HandledCommandDefinition;

// ── defineCommand() ─────────────────────────────────────────────

export function defineCommand<T extends CommandDefinition>(def: T): T {
  return def;
}
