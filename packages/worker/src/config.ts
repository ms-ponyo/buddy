import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { workerSocketPath, PERSISTENCE_SOCKET, GATEWAY_SOCKET } from '@buddy/shared';
import type { BuddyConfig } from './types.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** Generate a local-time timestamp string for log filenames, e.g. "20260313-143025" */
function localTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function parseCommaSeparated(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function loadMcpServers(): BuddyConfig['mcpServers'] {
  const file = process.env.MCP_SERVERS_FILE;
  if (!file) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return {};
  }
}

function discoverPlugins(projectDir: string): BuddyConfig['plugins'] {
  const plugins: BuddyConfig['plugins'] = [];

  // 1. Explicit PLUGINS env var (comma-separated paths) — highest priority
  const explicit = process.env.PLUGINS;
  if (explicit) {
    for (const p of explicit.split(',').map((s) => s.trim()).filter(Boolean)) {
      plugins.push({ type: 'local', path: p });
    }
  }

  // 2. Auto-discover from ~/.claude/plugins/installed_plugins.json
  if (process.env.INHERIT_PLUGINS !== 'false') {
    const installedFile = join(homedir(), '.claude', 'plugins', 'installed_plugins.json');
    try {
      const data = JSON.parse(readFileSync(installedFile, 'utf-8'));
      const installed = data.plugins as Record<string, Array<{ scope: string; installPath: string }>>;
      const explicitPaths = new Set(plugins.map((p) => p.path));

      for (const versions of Object.values(installed)) {
        for (const entry of versions) {
          if (!explicitPaths.has(entry.installPath)) {
            plugins.push({ type: 'local', path: entry.installPath });
          }
        }
      }
    } catch {
      // No installed plugins file — that's fine
    }

    // 3. Project-level .claude/plugins directory
    try {
      const projectPluginDir = join(projectDir, '.claude', 'plugins');
      const entries = readFileSync(join(projectPluginDir, 'installed_plugins.json'), 'utf-8');
      const data = JSON.parse(entries);
      const installed = data.plugins as Record<string, Array<{ scope: string; installPath: string }>>;
      const existingPaths = new Set(plugins.map((p) => p.path));

      for (const versions of Object.values(installed)) {
        for (const entry of versions) {
          if (!existingPaths.has(entry.installPath)) {
            plugins.push({ type: 'local', path: entry.installPath });
          }
        }
      }
    } catch {
      // No project plugins — that's fine
    }
  }

  return plugins;
}

/**
 * Parses a thread key of the form "CHANNEL:THREAD_TS" into its components.
 * Throws if the format is invalid.
 */
export function parseThreadKey(threadKey: string): { channel: string; threadTs: string } {
  const colonIdx = threadKey.indexOf(':');
  if (colonIdx < 1) {
    throw new Error(`Invalid thread key format: "${threadKey}". Expected "CHANNEL:THREAD_TS"`);
  }
  const channel = threadKey.slice(0, colonIdx);
  const threadTs = threadKey.slice(colonIdx + 1);
  if (!channel || !threadTs) {
    throw new Error(`Invalid thread key format: "${threadKey}". Expected "CHANNEL:THREAD_TS"`);
  }
  return { channel, threadTs };
}

export function loadConfig(): BuddyConfig {
  const projectDir = requireEnv('PROJECT_DIR');
  const threadKey = process.env.WORKER_THREAD_KEY ?? '';
  return {
    slackBotToken: process.env.SLACK_BOT_TOKEN ?? '',
    slackUserToken: process.env.SLACK_USER_TOKEN || undefined,
    projectDir,
    claudeModel: process.env.CLAUDE_MODEL ?? 'opus[1m]',
    dispatchModel: process.env.DISPATCH_MODEL ?? process.env.HAIKU_MODEL ?? 'haiku',
    permissionMode: process.env.PERMISSION_MODE ?? 'auto',
    permissionDestination: process.env.PERMISSION_DESTINATION ?? 'projectSettings',
    logLevel: process.env.LOG_LEVEL ?? 'debug',
    logFile: process.env.LOG_FILE ?? `logs/bot-${localTimestamp()}.log`,
    allowedUserIds: parseCommaSeparated(process.env.ALLOWED_USER_IDS),
    allowedChannelIds: parseCommaSeparated(process.env.ALLOWED_CHANNEL_IDS),
    adminUserIds: parseCommaSeparated(process.env.ADMIN_USER_IDS),
    triggerEmoji: process.env.TRIGGER_EMOJI ?? 'robot_face',
    previewMode: (process.env.PREVIEW_MODE as BuddyConfig['previewMode']) ?? 'moderate',
    projectMappingsFile: process.env.PROJECT_MAPPINGS_FILE ?? 'data/project-mappings.json',
    mcpServers: loadMcpServers(),
    enabledMcpServers: parseCommaSeparated(process.env.MCP_SERVERS),
    plugins: discoverPlugins(projectDir),
    socketPath: workerSocketPath(threadKey),
    persistenceSocket: PERSISTENCE_SOCKET,
    gatewaySocket: GATEWAY_SOCKET,
  };
}
