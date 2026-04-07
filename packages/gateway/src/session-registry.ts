import type { WorkerState, RpcClient } from '@buddy/shared';
import type { Logger } from './logger.js';

export type SessionType = 'worker' | 'lite';

export interface WorkerEntry {
  threadKey: string;
  type: SessionType;
  pid: number;
  socketPath: string;
  state: WorkerState;
  startedAt: number;
  lastHeartbeat: number;
  rpcClient: RpcClient | null;
}

export class SessionRegistry {
  private workers = new Map<string, WorkerEntry>();
  private callbackToThread = new Map<string, string>();

  constructor(private logger: Logger) {}

  /** Internal storage key — combines threadKey and type to allow two entries per thread. */
  private key(threadKey: string, type: SessionType): string {
    return `${threadKey}:${type}`;
  }

  has(threadKey: string, type: SessionType = 'worker'): boolean {
    return this.workers.has(this.key(threadKey, type));
  }

  get(threadKey: string, type: SessionType = 'worker'): WorkerEntry | undefined {
    return this.workers.get(this.key(threadKey, type));
  }

  register(threadKey: string, pid: number, socketPath: string, type: SessionType = 'worker'): WorkerEntry {
    const k = this.key(threadKey, type);
    if (this.workers.has(k)) {
      this.logger.warn('Worker already registered, replacing', { threadKey, type });
      this.remove(threadKey, type);
    }
    const entry: WorkerEntry = {
      threadKey,
      type,
      pid,
      socketPath,
      state: 'starting',
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
      rpcClient: null,
    };
    this.workers.set(k, entry);
    this.logger.info('Worker registered', { threadKey, type, pid: entry.pid });
    return entry;
  }

  setRpcClient(threadKey: string, client: RpcClient, type: SessionType = 'worker'): void {
    const entry = this.workers.get(this.key(threadKey, type));
    if (entry) entry.rpcClient = client;
  }

  getRpcClient(threadKey: string, type: SessionType = 'worker'): RpcClient | null {
    const entry = this.workers.get(this.key(threadKey, type));
    return entry?.rpcClient ?? null;
  }

  setState(threadKey: string, state: WorkerState, type: SessionType = 'worker'): void {
    const entry = this.workers.get(this.key(threadKey, type));
    if (entry) entry.state = state;
  }

  updateHeartbeat(threadKey: string, type: SessionType = 'worker'): void {
    const entry = this.workers.get(this.key(threadKey, type));
    if (entry) entry.lastHeartbeat = Date.now();
  }

  remove(threadKey: string, type: SessionType = 'worker'): void {
    this.workers.delete(this.key(threadKey, type));
    // Only clean up callbacks when removing the main worker (callbacks are worker-owned)
    if (type === 'worker') {
      for (const [callbackId, tk] of this.callbackToThread) {
        if (tk === threadKey) this.callbackToThread.delete(callbackId);
      }
    }
  }

  registerCallback(callbackId: string, threadKey: string): void {
    this.callbackToThread.set(callbackId, threadKey);
  }

  getThreadForCallback(callbackId: string): string | undefined {
    return this.callbackToThread.get(callbackId);
  }

  removeCallback(callbackId: string): void {
    this.callbackToThread.delete(callbackId);
  }

  /** Returns all entries (both worker and lite) for a given threadKey. */
  getAll(threadKey: string): WorkerEntry[] {
    const results: WorkerEntry[] = [];
    for (const type of ['worker', 'lite'] as SessionType[]) {
      const entry = this.workers.get(this.key(threadKey, type));
      if (entry) results.push(entry);
    }
    return results;
  }

  getAllEntries(): WorkerEntry[] {
    return Array.from(this.workers.values());
  }

  /** Returns all unique storage keys. */
  getAllThreadKeys(): string[] {
    return Array.from(this.workers.keys());
  }

  size(): number {
    return this.workers.size;
  }
}
