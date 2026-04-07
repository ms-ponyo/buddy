import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Monorepo root — three levels up from packages/gateway/src/ (or dist/) */
const MONOREPO_ROOT = path.resolve(__dirname, '../../..');
const LOG_DIR = path.join(MONOREPO_ROOT, 'logs/gateway');

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export function createLogger(component: string, level?: LogLevel): Logger {
  const effectiveLevel = level ?? (process.env.LOG_LEVEL as LogLevel) ?? 'debug';
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

  const logFile = path.join(LOG_DIR, `gateway-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  const stream = fs.createWriteStream(logFile, { flags: 'a' });

  // Symlink logs/gateway/latest.log -> current log file
  const symlink = path.join(LOG_DIR, 'latest.log');
  try { fs.unlinkSync(symlink); } catch {}
  try { fs.symlinkSync(logFile, symlink); } catch {}

  const minLevel = LEVEL_ORDER[effectiveLevel];

  const write = (lvl: string, msg: string, data?: Record<string, unknown>) => {
    if (LEVEL_ORDER[lvl as LogLevel] < minLevel) return;
    const entry = JSON.stringify({ ts: new Date().toISOString(), level: lvl, component, msg, ...data });
    stream.write(entry + '\n');
    if (lvl === 'error') console.error(`[${component}] ${msg}`, data ? JSON.stringify(data) : '');
  };

  return {
    debug: (msg, data) => write('debug', msg, data),
    info: (msg, data) => write('info', msg, data),
    warn: (msg, data) => write('warn', msg, data),
    error: (msg, data) => write('error', msg, data),
  };
}
