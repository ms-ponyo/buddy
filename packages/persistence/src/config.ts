// packages/persistence/src/config.ts
import { PERSISTENCE_SOCKET } from '@buddy/shared';
import { resolve } from 'node:path';

// Resolve data dir relative to monorepo root
const MONOREPO_ROOT = new URL('../../../', import.meta.url).pathname;

export const CONFIG = {
  // Database
  DB_PATH: process.env.PERSISTENCE_DB_PATH || resolve(MONOREPO_ROOT, 'data/buddy.db'),
  // Socket
  SOCKET_PATH: process.env.PERSISTENCE_SOCKET_PATH || PERSISTENCE_SOCKET,

  // Queue
  MAX_RETRIES: 3,
  PRUNE_INTERVAL_MS: 60 * 60 * 1000,           // 1 hour
  PRUNE_AGE_MS: 7 * 24 * 60 * 60 * 1000,       // 7 days
  STALE_MESSAGE_THRESHOLD_MS: 5 * 60 * 1000,    // 5 minutes
} as const;
