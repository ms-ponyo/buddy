// src/services/config-overrides.ts — Per-worker config overrides.
// Unlike the old Map-based approach (keyed by channel:threadTs), each worker
// owns exactly one thread, so overrides are simple scalar fields.

import type { BuddyConfig, ThreadPermissionMode } from '../types.js';

export type EffortLevel = 'low' | 'medium' | 'high' | 'max';

export interface ToolOverrides {
  allowedTools?: string[];
  disallowedTools?: string[];
}

export class ConfigOverrides {
  private model: string | undefined;
  private effort: EffortLevel | undefined;
  private budget: number | undefined;
  private permissionMode: ThreadPermissionMode | undefined;
  private fallbackModel: string | undefined;
  private agent: string | undefined;
  private systemPromptAppend: string | undefined;
  private toolOverrides: ToolOverrides | undefined;

  // ── Model ───────────────────────────────────────────────────────

  setModel(model: string): void {
    this.model = model;
  }

  getModel(): string | undefined {
    return this.model;
  }

  // ── Effort ──────────────────────────────────────────────────────

  setEffort(effort: EffortLevel): void {
    this.effort = effort;
  }

  getEffort(): EffortLevel | undefined {
    return this.effort;
  }

  // ── Budget ──────────────────────────────────────────────────────

  setBudget(budget: number): void {
    this.budget = budget;
  }

  getBudget(): number | undefined {
    return this.budget;
  }

  // ── Permission Mode ─────────────────────────────────────────────

  setPermissionMode(mode: ThreadPermissionMode): void {
    if (mode === 'default') {
      this.permissionMode = undefined;
    } else {
      this.permissionMode = mode;
    }
  }

  getPermissionMode(): ThreadPermissionMode | undefined {
    return this.permissionMode;
  }

  // ── Fallback Model ──────────────────────────────────────────────

  setFallbackModel(model: string): void {
    this.fallbackModel = model;
  }

  getFallbackModel(): string | undefined {
    return this.fallbackModel;
  }

  deleteFallbackModel(): void {
    this.fallbackModel = undefined;
  }

  // ── Agent ───────────────────────────────────────────────────────

  setAgent(agent: string): void {
    this.agent = agent;
  }

  getAgent(): string | undefined {
    return this.agent;
  }

  deleteAgent(): void {
    this.agent = undefined;
  }

  // ── System Prompt Append ────────────────────────────────────────

  setSystemPromptAppend(prompt: string): void {
    this.systemPromptAppend = prompt;
  }

  getSystemPromptAppend(): string | undefined {
    return this.systemPromptAppend;
  }

  deleteSystemPromptAppend(): void {
    this.systemPromptAppend = undefined;
  }

  // ── Tool Overrides ──────────────────────────────────────────────

  setToolOverrides(overrides: ToolOverrides): void {
    this.toolOverrides = overrides;
  }

  getToolOverrides(): ToolOverrides | undefined {
    return this.toolOverrides;
  }

  deleteToolOverrides(): void {
    this.toolOverrides = undefined;
  }

  // ── Reset ───────────────────────────────────────────────────────

  reset(): void {
    this.model = undefined;
    this.effort = undefined;
    this.budget = undefined;
    this.permissionMode = undefined;
    this.fallbackModel = undefined;
    this.agent = undefined;
    this.systemPromptAppend = undefined;
    this.toolOverrides = undefined;
  }

  // ── resolveConfig ───────────────────────────────────────────────

  /**
   * Merge overrides onto a base config, returning a new config object.
   * The base config is not mutated.
   */
  resolveConfig(base: BuddyConfig): BuddyConfig {
    const resolved = { ...base };

    if (this.model !== undefined) {
      resolved.claudeModel = this.model;
    }

    if (this.permissionMode !== undefined) {
      resolved.permissionMode = this.permissionMode;
    }

    return resolved;
  }
}
