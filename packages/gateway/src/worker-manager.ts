import { spawn, exec, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));
/** Monorepo root — three levels up from packages/gateway/src/ */
const MONOREPO_ROOT = resolve(__dirname, '../../..');

import type { WorkerConfig } from '@buddy/shared';
import { RpcClient, workerSocketPath, liteWorkerSocketPath, PERSISTENCE_SOCKET } from '@buddy/shared';
import { connect as netConnect } from 'node:net';
import type { Logger } from './logger.js';
import type { SessionRegistry } from './session-registry.js';
import type { GatewayConfig } from './config.js';

export class WorkerManager {
  private spawningPersistence = false;
  private onLiteWorkerExit?: (threadKey: string, expected: boolean) => void;

  constructor(
    private config: GatewayConfig,
    private registry: SessionRegistry,
    private logger: Logger,
    private onWorkerExit: (threadKey: string, expected: boolean) => void,
  ) {}

  /** Register a callback for lite worker unexpected exits. */
  setLiteWorkerExitHandler(handler: (threadKey: string, expected: boolean) => void): void {
    this.onLiteWorkerExit = handler;
  }

  spawn(threadKey: string, workerConfig: WorkerConfig): ChildProcess {
    // Guard against duplicate spawns
    const existing = this.registry.get(threadKey);
    if (existing) {
      this.logger.warn('Worker already exists for thread, killing old one', { threadKey });
      this.kill(threadKey);
    }

    const child = spawn(process.execPath, [this.config.workerEntryPoint], {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        WORKER_THREAD_KEY: threadKey,
      },
    });
    child.unref();

    const workerSocket = workerSocketPath(threadKey);
    const entry = this.registry.register(threadKey, child.pid!, workerSocket);

    // Connect to the worker's RPC server in the background (for health pings)
    this.connectToRpc(threadKey, workerSocket, 'worker');

    child.on('exit', (code, signal) => {
      // Check that WE are still the registered worker — a replacement may have
      // been spawned while we were shutting down (idle timeout, kill, etc.).
      const current = this.registry.get(threadKey);
      if (current && current.pid !== child.pid) {
        // A newer worker owns this threadKey — our exit is stale, ignore it.
        this.logger.info('Old worker exited after replacement, ignoring', { threadKey, pid: entry.pid, code, signal });
        return;
      }

      const expected = !current; // removed before exit = expected (kill / idle)
      if (!expected) {
        this.logger.error('Worker crashed', { threadKey, pid: entry.pid, code, signal });
      } else {
        this.logger.info('Worker exited', { threadKey, pid: entry.pid, code, signal });
      }
      this.registry.remove(threadKey);
      this.onWorkerExit(threadKey, expected);
    });

    child.on('error', (err) => {
      this.logger.error('Worker process error', { threadKey, error: err.message });
    });

    // Workers log to their own files (logs/workers/).
    // Only forward stderr lines that look like crashes (non-JSON) to gateway log.
    child.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line && !line.startsWith('{')) {
        this.logger.error(`[worker:${threadKey}] ${line}`);
      }
    });

    return child;
  }

  /**
   * Spawn a lite worker for a given thread.
   * Same pattern as spawn() but uses liteWorkerEntryPoint and registers with type='lite'.
   */
  spawnLite(threadKey: string, purpose: string, workerConfig: WorkerConfig): ChildProcess {
    // Guard against duplicate spawns
    const existing = this.registry.get(threadKey, 'lite');
    if (existing) {
      this.logger.warn('Lite worker already exists for thread, killing old one', { threadKey });
      this.killLite(threadKey);
    }

    const child = spawn(process.execPath, [this.config.liteWorkerEntryPoint], {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        WORKER_THREAD_KEY: threadKey,
        LITE_WORKER_PURPOSE: purpose,
        SLACK_BOT_TOKEN: this.config.slackBotToken,
        DISPATCH_MODEL: workerConfig.model || 'claude-haiku-4-5-20251001',
      },
    });
    child.unref();

    const socketPath = liteWorkerSocketPath(threadKey, purpose);
    const entry = this.registry.register(threadKey, child.pid!, socketPath, 'lite');

    // Connect to the lite worker's RPC server in the background
    this.connectToRpc(threadKey, socketPath, 'lite');

    child.on('exit', (code, signal) => {
      // Check that WE are still the registered lite worker
      const current = this.registry.get(threadKey, 'lite');
      if (current && current.pid !== child.pid) {
        this.logger.info('Old lite worker exited after replacement, ignoring', { threadKey, pid: entry.pid, code, signal });
        return;
      }

      const expected = !current; // removed before exit = expected (kill / idle)
      if (!expected) {
        this.logger.error('Lite worker crashed', { threadKey, pid: entry.pid, code, signal });
      } else {
        this.logger.info('Lite worker exited', { threadKey, pid: entry.pid, code, signal });
      }
      this.registry.remove(threadKey, 'lite');
      this.onLiteWorkerExit?.(threadKey, expected);
    });

    child.on('error', (err) => {
      this.logger.error('Lite worker process error', { threadKey, error: err.message });
    });

    child.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line && !line.startsWith('{')) {
        this.logger.error(`[lite-worker:${threadKey}] ${line}`);
      }
    });

    return child;
  }

  private async connectToRpc(threadKey: string, socketPath: string, type: 'worker' | 'lite'): Promise<void> {
    // Retry connecting to the worker's RPC server (it takes a moment to start)
    for (let i = 0; i < 20; i++) {
      // Abort if the worker was removed (killed/crashed before we connected)
      if (!this.registry.get(threadKey, type)) return;
      try {
        const client = new RpcClient({ socketPath, reconnect: false });
        await client.connect();
        // Double-check worker still registered (may have exited during connect)
        if (this.registry.get(threadKey, type)) {
          this.registry.setRpcClient(threadKey, client, type);
          this.logger.info(`Connected to ${type} RPC server`, { threadKey });
        } else {
          await client.close();
        }
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    this.logger.warn(`Failed to connect to ${type} RPC server after retries`, { threadKey });
  }

  kill(threadKey: string): Promise<void> {
    const entry = this.registry.get(threadKey);
    if (!entry) return Promise.resolve();

    this.logger.info('Killing worker', { threadKey, pid: entry.pid });
    this.registry.remove(threadKey); // remove first so exit handler knows it's expected

    // Graceful SIGTERM, then force SIGKILL after 5s
    try {
      process.kill(entry.pid, 'SIGTERM');
    } catch {
      // Process already dead
      return Promise.resolve();
    }

    const pid = entry.pid;
    return new Promise<void>((resolve) => {
      const forceKillTimer = setTimeout(() => {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
      }, 5000);

      // Poll until process exits (or safety timeout)
      const poll = setInterval(() => {
        try {
          process.kill(pid, 0); // throws if process is gone
        } catch {
          clearInterval(poll);
          clearTimeout(forceKillTimer);
          clearTimeout(safetyTimer);
          resolve();
        }
      }, 50);

      // Safety: don't wait longer than 6s (5s graceful + 1s buffer)
      const safetyTimer = setTimeout(() => {
        clearInterval(poll);
        clearTimeout(forceKillTimer);
        resolve();
      }, 6000);
    });
  }

  killLite(threadKey: string): void {
    const entry = this.registry.get(threadKey, 'lite');
    if (!entry) return;

    this.logger.info('Killing lite worker', { threadKey, pid: entry.pid });
    this.registry.remove(threadKey, 'lite'); // remove first so exit handler knows it's expected

    // Graceful SIGTERM, then force SIGKILL after 5s
    try {
      process.kill(entry.pid, 'SIGTERM');
    } catch {
      // Process already dead
      return;
    }
    setTimeout(() => {
      try {
        process.kill(entry.pid, 'SIGKILL');
      } catch {
        // Already dead
      }
    }, 5000);
  }

  killAll(): string[] {
    const allKeys = this.registry.getAllThreadKeys();
    for (const key of allKeys) {
      // getAllThreadKeys returns composite keys like "threadKey:worker" and "threadKey:lite"
      // We need to handle both types
      const entry = this.registry.getAllEntries().find(
        e => `${e.threadKey}:${e.type}` === key,
      );
      if (entry) {
        if (entry.type === 'lite') {
          this.killLite(entry.threadKey);
        } else {
          this.kill(entry.threadKey);
        }
      }
    }
    return allKeys;
  }

  async spawnPersistence(): Promise<ChildProcess | null> {
    // Prevent concurrent spawn attempts
    if (this.spawningPersistence) {
      this.logger.info('Persistence spawn already in progress, skipping');
      return null;
    }
    this.spawningPersistence = true;

    try {
      // Check if persistence is already accepting connections
      const alive = await new Promise<boolean>((resolve) => {
        const sock = netConnect(PERSISTENCE_SOCKET);
        sock.on('connect', () => { sock.destroy(); resolve(true); });
        sock.on('error', () => { resolve(false); });
        setTimeout(() => { sock.destroy(); resolve(false); }, 1000);
      });

      if (alive) {
        this.logger.info('Persistence already running, skipping spawn');
        return null;
      }

      const child = spawn(process.execPath, [this.config.persistenceEntryPoint], {
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.unref();

      // Persistence logs to its own file (logs/persistence/).
      // Only forward stderr lines that look like crashes (non-JSON) to gateway log.
      child.stderr?.on('data', (data: Buffer) => {
        const line = data.toString().trim();
        if (line && !line.startsWith('{')) {
          this.logger.error(`[persistence] ${line}`);
        }
      });

      return child;
    } finally {
      this.spawningPersistence = false;
    }
  }

  async updateRepo(): Promise<{ success: boolean; output: string }> {
    this.logger.info('Updating repository: stash → checkout main → rebase → install');
    try {
      const { stdout, stderr } = await execAsync(
        '(git stash || true) && git checkout main && git pull --rebase && npm install',
        { cwd: MONOREPO_ROOT, timeout: 120_000 },
      );
      this.logger.info('Repository updated');
      return { success: true, output: stdout + stderr };
    } catch (err: any) {
      const output = err.stdout || err.stderr || err.message;
      this.logger.error('Repository update failed', { output });
      return { success: false, output };
    }
  }

  async rebuild(): Promise<{ success: boolean; output: string }> {
    this.logger.info('Rebuilding worker package');
    try {
      const { stdout, stderr } = await execAsync('npm run build:worker', {
        cwd: MONOREPO_ROOT,
        timeout: 60_000,
      });
      this.logger.info('Worker rebuild succeeded');
      return { success: true, output: stdout + stderr };
    } catch (err: any) {
      const output = err.stdout || err.stderr || err.message;
      this.logger.error('Worker rebuild failed', { output });
      return { success: false, output };
    }
  }

  /**
   * Rebuild both worker and persistence packages.
   * Used by !restart to ensure both services get the latest code.
   */
  async rebuildAll(): Promise<{ success: boolean; output: string }> {
    this.logger.info('Rebuilding worker + persistence packages');
    try {
      const { stdout, stderr } = await execAsync('npm run build:worker && npm run build:persistence', {
        cwd: MONOREPO_ROOT,
        timeout: 120_000,
      });
      this.logger.info('Full rebuild succeeded');
      return { success: true, output: stdout + stderr };
    } catch (err: any) {
      const output = err.stdout || err.stderr || err.message;
      this.logger.error('Full rebuild failed', { output });
      return { success: false, output };
    }
  }

  async rebuildPersistence(): Promise<{ success: boolean; output: string }> {
    this.logger.info('Rebuilding persistence package');
    try {
      const { stdout, stderr } = await execAsync('npm run build:persistence', {
        cwd: MONOREPO_ROOT,
        timeout: 60_000,
      });
      this.logger.info('Persistence rebuild succeeded');
      return { success: true, output: stdout + stderr };
    } catch (err: any) {
      const output = err.stdout || err.stderr || err.message;
      this.logger.error('Persistence rebuild failed', { output });
      return { success: false, output };
    }
  }

  async rebuildEverything(): Promise<{ success: boolean; output: string }> {
    this.logger.info('Rebuilding all packages');
    try {
      const { stdout, stderr } = await execAsync('npm run build', {
        cwd: MONOREPO_ROOT,
        timeout: 120_000,
      });
      this.logger.info('Full rebuild succeeded');
      return { success: true, output: stdout + stderr };
    } catch (err: any) {
      const output = err.stdout || err.stderr || err.message;
      this.logger.error('Full rebuild failed', { output });
      return { success: false, output };
    }
  }

  /**
   * Kill the persistence service by sending SIGTERM to any process on PERSISTENCE_SOCKET.
   * The gateway will auto-reconnect and respawn it.
   */
  async killPersistence(): Promise<void> {
    this.logger.info('Killing persistence service');
    try {
      // Find the pid via lsof on the socket
      const { stdout } = await execAsync(`lsof -t ${PERSISTENCE_SOCKET} 2>/dev/null`, { timeout: 5000 });
      const pids = stdout.trim().split('\n').filter(Boolean);
      for (const pidStr of pids) {
        const pid = parseInt(pidStr, 10);
        if (!isNaN(pid)) {
          try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
        }
      }
    } catch {
      // No process on socket — already dead
    }
  }
}
