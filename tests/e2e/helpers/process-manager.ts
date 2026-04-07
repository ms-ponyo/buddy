import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { RpcClient } from '../../../packages/shared/src/index.js';
import { resolve } from 'node:path';

const PROJECT_ROOT = resolve(new URL('../../../', import.meta.url).pathname);

export interface SpawnOptions {
  socketDir: string;
  dbPath: string;
  persistenceSocket: string;
  gatewaySocket: string;
}

export interface SpawnedProcess {
  child: ChildProcess;
  pid: number;
  stdout: string[];
  stderr: string[];
}

export class ProcessManager {
  private processes: SpawnedProcess[] = [];

  async spawnPersistence(opts: SpawnOptions): Promise<SpawnedProcess> {
    const entryPoint = resolve(PROJECT_ROOT, 'packages/persistence/dist/index.js');
    const child = spawn(process.execPath, [entryPoint], {
      env: {
        ...process.env,
        PERSISTENCE_DB_PATH: opts.dbPath,
        PERSISTENCE_SOCKET_PATH: opts.persistenceSocket,
        WORKER_SOCKET_DIR: opts.socketDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const proc = this.trackProcess(child);
    await this.waitForSocket(opts.persistenceSocket, 10000);
    return proc;
  }

  async spawnWorker(threadKey: string, opts: SpawnOptions): Promise<SpawnedProcess> {
    const entryPoint = resolve(PROJECT_ROOT, 'packages/worker/dist/index.js');
    const child = spawn(process.execPath, [entryPoint], {
      env: {
        ...process.env,
        WORKER_THREAD_KEY: threadKey,
        PERSISTENCE_SOCKET_PATH: opts.persistenceSocket,
        GATEWAY_SOCKET_PATH: opts.gatewaySocket,
        WORKER_SOCKET_DIR: opts.socketDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return this.trackProcess(child);
  }

  async kill(pid: number): Promise<void> {
    try {
      process.kill(pid, 'SIGTERM');
      await this.waitForExit(pid, 5000);
    } catch {
      // Process may already be dead
    }
  }

  async crash(pid: number): Promise<void> {
    try {
      process.kill(pid, 'SIGKILL');
      await this.waitForExit(pid, 5000);
    } catch {
      // Process may already be dead
    }
  }

  async cleanupAll(): Promise<void> {
    for (const proc of this.processes) {
      try {
        process.kill(proc.pid, 'SIGKILL');
      } catch {
        // Already dead
      }
    }
    await Promise.all(
      this.processes.map((p) => this.waitForExit(p.pid, 3000).catch(() => {}))
    );
    this.processes = [];
  }

  getOutput(proc: SpawnedProcess): { stdout: string; stderr: string } {
    return {
      stdout: proc.stdout.join('\n'),
      stderr: proc.stderr.join('\n'),
    };
  }

  private trackProcess(child: ChildProcess): SpawnedProcess {
    const proc: SpawnedProcess = {
      child,
      pid: child.pid!,
      stdout: [],
      stderr: [],
    };

    child.stdout?.on('data', (data) => proc.stdout.push(data.toString()));
    child.stderr?.on('data', (data) => proc.stderr.push(data.toString()));

    this.processes.push(proc);
    return proc;
  }

  private async waitForSocket(socketPath: string, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (existsSync(socketPath)) {
        try {
          const testClient = new RpcClient({ socketPath, reconnect: false });
          await testClient.connect();
          await testClient.close();
          return;
        } catch {
          // Socket exists but not accepting yet
        }
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Timed out waiting for socket: ${socketPath}`);
  }

  private async waitForExit(pid: number, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 100));
      } catch {
        return;
      }
    }
  }
}
