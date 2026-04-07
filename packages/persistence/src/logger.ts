import { mkdirSync, appendFileSync, unlinkSync, symlinkSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Monorepo root — three levels up from packages/persistence/src/ (or dist/) */
const MONOREPO_ROOT = resolve(__dirname, '../../..');
const LOG_DIR = resolve(MONOREPO_ROOT, 'logs/persistence');
const LOG_FILE = resolve(LOG_DIR, `persistence-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);

try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}

// Symlink logs/persistence/latest.log -> current log file
const symlink = `${LOG_DIR}/latest.log`;
try { unlinkSync(symlink); } catch {}
try { symlinkSync(LOG_FILE, symlink); } catch {}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const level = (process.env.LOG_LEVEL as LogLevel) ?? 'debug';
const minLevel = LEVEL_ORDER[level] ?? LEVEL_ORDER.debug;

function write(lvl: string, msg: string, data?: Record<string, unknown>): void {
  if (LEVEL_ORDER[lvl as LogLevel] < minLevel) return;
  const entry = JSON.stringify({ ts: new Date().toISOString(), level: lvl, component: 'persistence', msg, ...data });
  process.stderr.write(entry + '\n');
  try { appendFileSync(LOG_FILE, entry + '\n'); } catch {}
}

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>) => write('debug', msg, data),
  info: (msg: string, data?: Record<string, unknown>) => write('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => write('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => write('error', msg, data),
};
