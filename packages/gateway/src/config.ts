import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { type AuthConfig, parseCommaSeparated } from './authorization.js';

// Load .env from monorepo root (three levels up from src/)
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../../.env') });

export interface GatewayConfig {
  slackBotToken: string;
  slackAppToken: string;
  slackUserToken?: string;
  anthropicApiKey?: string;
  defaultModel: string;
  defaultPermissionMode: string;
  mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  workerEntryPoint: string;
  liteWorkerEntryPoint: string;
  persistenceEntryPoint: string;
  auth: AuthConfig;
}

export function loadConfig(): GatewayConfig {
  const required = (name: string): string => {
    const val = process.env[name];
    if (!val) throw new Error(`Missing required env var: ${name}`);
    return val;
  };

  let mcpServers: GatewayConfig['mcpServers'] = {};
  const mcpServersFile = process.env.MCP_SERVERS_FILE;
  if (mcpServersFile) {
    const content = fs.readFileSync(mcpServersFile, 'utf-8');
    mcpServers = JSON.parse(content);
  }

  return {
    slackBotToken: required('SLACK_BOT_TOKEN'),
    slackAppToken: required('SLACK_APP_TOKEN'),
    slackUserToken: process.env.SLACK_USER_TOKEN || undefined,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    defaultModel: process.env.MODEL || 'claude-sonnet-4-6',
    defaultPermissionMode: process.env.PERMISSION_MODE || 'auto',
    mcpServers,
    workerEntryPoint: new URL('../../worker/dist/index.js', import.meta.url).pathname,
    liteWorkerEntryPoint: new URL('../../worker/dist/lite-index.js', import.meta.url).pathname,
    persistenceEntryPoint: new URL('../../persistence/dist/index.js', import.meta.url).pathname,
    auth: {
      allowedUserIds: parseCommaSeparated(process.env.ALLOWED_USER_IDS),
      allowedChannelIds: parseCommaSeparated(process.env.ALLOWED_CHANNEL_IDS),
      adminUserIds: parseCommaSeparated(process.env.ADMIN_USER_IDS),
    },
  };
}
