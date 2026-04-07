// src/services/remote-config-overrides.ts — RPC-backed proxy for ConfigOverrides.
// Used by the lite worker to read/write the main worker's configuration via IPC.

import type { EffortLevel } from './config-overrides.js';

// ── RPC client interface ───────────────────────────────────────────

export interface RpcClient {
  call(method: string, params?: unknown): Promise<unknown>;
}

// ── Status snapshot ───────────────────────────────────────────────

interface StatusSnapshot {
  model: string;
  mode: string;
  effort: string;
  budget: number | null;
  fallbackModel: string | null;
  agent: string | null;
  systemPromptAppend: string | null;
  isBackground: boolean;
  hasActiveExecution: boolean;
  sessionId: string | null;
}

const FALLBACK_SNAPSHOT: StatusSnapshot = {
  model: 'unknown',
  mode: 'unknown',
  effort: 'unknown',
  budget: null,
  fallbackModel: null,
  agent: null,
  systemPromptAppend: null,
  isBackground: false,
  hasActiveExecution: false,
  sessionId: null,
};

// ── RemoteConfigOverrides ─────────────────────────────────────────

/**
 * A proxy that looks like a local ConfigOverrides but delegates reads/writes
 * to the main worker over RPC.
 *
 * Caching: refresh() fetches a fresh snapshot and caches it.
 * Reads return from the cache (or fallback values if cache is null).
 * Writes call the corresponding RPC method and invalidate the cache.
 */
export class RemoteConfigOverrides {
  private cache: StatusSnapshot | null = null;

  constructor(private readonly rpc: RpcClient) {}

  // ── Cache management ─────────────────────────────────────────────

  /**
   * Fetch a fresh snapshot from worker.getStatus and cache it.
   * On failure, stores fallback values so reads remain usable.
   */
  async refresh(): Promise<void> {
    try {
      const snapshot = await this.rpc.call('worker.getStatus') as StatusSnapshot;
      this.cache = snapshot;
    } catch {
      this.cache = { ...FALLBACK_SNAPSHOT };
    }
  }

  private invalidateCache(): void {
    this.cache = null;
  }

  private getSnapshot(): StatusSnapshot {
    return this.cache ?? { ...FALLBACK_SNAPSHOT };
  }

  // ── Model ─────────────────────────────────────────────────────────

  getModel(): string | undefined {
    const value = this.getSnapshot().model;
    return value === 'unknown' && this.cache === null ? undefined : value;
  }

  async setModel(model: string): Promise<void> {
    await this.rpc.call('worker.switchModel', { model });
    this.invalidateCache();
  }

  // ── Permission Mode ───────────────────────────────────────────────

  getPermissionMode(): string | undefined {
    const value = this.getSnapshot().mode;
    return value === 'unknown' && this.cache === null ? undefined : value;
  }

  async setPermissionMode(mode: string): Promise<void> {
    await this.rpc.call('worker.switchMode', { mode });
    this.invalidateCache();
  }

  // ── Effort ────────────────────────────────────────────────────────

  getEffort(): EffortLevel | undefined {
    const value = this.getSnapshot().effort;
    if (value === 'unknown' && this.cache === null) return undefined;
    return value as EffortLevel;
  }

  async setEffort(effort: EffortLevel): Promise<void> {
    await this.rpc.call('worker.switchEffort', { effort });
    this.invalidateCache();
  }

  // ── Budget ────────────────────────────────────────────────────────

  getBudget(): number | undefined {
    const value = this.getSnapshot().budget;
    return value ?? undefined;
  }

  async setBudget(budget: number): Promise<void> {
    await this.rpc.call('worker.switchBudget', { budget });
    this.invalidateCache();
  }

  // ── Fallback Model ──────────────────────────────────────────────

  getFallbackModel(): string | undefined {
    return this.getSnapshot().fallbackModel ?? undefined;
  }

  // ── Agent ──────────────────────────────────────────────────────

  getAgent(): string | undefined {
    return this.getSnapshot().agent ?? undefined;
  }

  // ── System Prompt Append ───────────────────────────────────────

  getSystemPromptAppend(): string | undefined {
    return this.getSnapshot().systemPromptAppend ?? undefined;
  }

  // ── Extra status accessors ────────────────────────────────────────

  isBackground(): boolean {
    return this.getSnapshot().isBackground;
  }

  hasActiveExecution(): boolean {
    return this.getSnapshot().hasActiveExecution;
  }

  getSessionId(): string | null {
    return this.getSnapshot().sessionId;
  }
}
