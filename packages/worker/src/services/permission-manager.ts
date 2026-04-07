// src/services/permission-manager.ts — Owns all pending permission/question/plan-review state.
// One thread = one worker. Concurrent permission requests are batched into a
// single Slack message so the user can approve/deny all at once.
// UI block building is delegated to src/ui/*.ts; this service posts them
// via SlackAdapter and manages the pending promise lifecycle.

import type { Logger } from '../logger.js';
import type { SlackAdapter } from '../adapters/slack-adapter.js';
import type {
  ToolRisk,
  AskUserQuestionItem,
  PlanReviewResult,
} from '../types.js';
import { buildPlanReviewBlocks } from '../ui/plan-blocks.js';

// ── Input/Result types ─────────────────────────────────────────────

export interface PermissionRequestOpts {
  toolName: string;
  toolInput: Record<string, unknown>;
  callbackId: string;
  channel: string;
  threadTs: string;
  risk: ToolRisk;
  lockText: string;
  /** SDK-provided permission suggestions (wildcard rules) for "Always allow". */
  suggestions?: unknown[];
}

export interface PermissionResult {
  approved: boolean;
  message?: string;
  updatedPermissions?: unknown[];
}

export interface AskUserQuestionOpts {
  callbackId: string;
  questions: AskUserQuestionItem[];
}

// ── Internal pending-item shapes ──────────────────────────────────

interface PendingItem<T> {
  callbackId: string;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
  createdAt: number;
}

interface PendingPermissionItem extends PendingItem<PermissionResult> {
  /** SDK-provided suggestions to return as updatedPermissions on "Always allow". */
  suggestions?: unknown[];
  /** Tool name for batch display. */
  toolName: string;
  /** Description text for batch display. */
  lockText: string;
}

// ── Constructor deps ──────────────────────────────────────────────

export interface PermissionManagerDeps {
  slack: SlackAdapter;
  logger: Logger;
  onAwaitingInput?: () => void;
  onInputReceived?: () => void;
}

// ── Batch state ───────────────────────────────────────────────────

/** Debounce window for batching concurrent permission requests (ms). */
const BATCH_DEBOUNCE_MS = 200;

interface PermissionBatch {
  /** The callbackId used for the Slack message (individual or generated batch-*). */
  callbackId: string;
  /** Individual callbackIds in this batch. */
  itemIds: Set<string>;
}

// ── PermissionManager ─────────────────────────────────────────────

export class PermissionManager {
  private readonly slack: SlackAdapter;
  private readonly logger: Logger;
  private readonly onAwaitingInput?: () => void;
  private readonly onInputReceived?: () => void;

  /** All pending permission items, keyed by their individual callbackId. */
  private pendingPermissions = new Map<string, PendingPermissionItem>();
  /** Items waiting to be flushed as a batch (not yet posted to Slack). */
  private unflushedIds = new Set<string>();
  /** Timer for batching debounce. */
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  /** Channel/threadTs captured from the first request (same for all in a worker). */
  private batchChannel = '';
  private batchThreadTs = '';
  /** Flushed batches: maps batch callbackId → batch info. */
  private flushedBatches = new Map<string, PermissionBatch>();

  private pendingQuestion: PendingItem<string> | null = null;
  private pendingPlanReview: PendingItem<PlanReviewResult> | null = null;

  constructor(deps: PermissionManagerDeps) {
    this.slack = deps.slack;
    this.logger = deps.logger;
    this.onAwaitingInput = deps.onAwaitingInput;
    this.onInputReceived = deps.onInputReceived;
  }

  // ── requestPermission ─────────────────────────────────────────

  /**
   * Queue a permission request. Concurrent requests within a short window
   * are batched into a single Slack message. Returns a promise that resolves
   * when the user clicks Allow/Deny.
   */
  requestPermission(opts: PermissionRequestOpts): Promise<PermissionResult> {
    const { toolName, toolInput, callbackId, channel, threadTs, lockText, suggestions } = opts;

    this.batchChannel = channel;
    this.batchThreadTs = threadTs;

    this.logger.info('Permission requested', { toolName, callbackId, risk: opts.risk });

    // Signal awaiting input (only once per batch)
    if (this.pendingPermissions.size === 0) {
      this.onAwaitingInput?.();
    }

    // Reset debounce timer — wait for more concurrent requests
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = setTimeout(() => this.flushBatch(), BATCH_DEBOUNCE_MS);

    return new Promise<PermissionResult>((resolve, reject) => {
      this.pendingPermissions.set(callbackId, {
        callbackId,
        resolve,
        reject,
        createdAt: Date.now(),
        suggestions,
        toolName,
        lockText,
      });
      this.unflushedIds.add(callbackId);
    });
  }

  /**
   * Flush unflushed permission items as a single Slack message.
   */
  private flushBatch(): void {
    this.batchTimer = null;

    const ids = Array.from(this.unflushedIds);
    if (ids.length === 0) return;

    const items = ids.map(id => this.pendingPermissions.get(id)!).filter(Boolean);
    this.unflushedIds.clear();

    if (items.length === 1) {
      // Single item — post as a normal permission message
      const item = items[0];
      const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
      const alwaysAllowLabel = item.suggestions && item.suggestions.length > 0
        ? (FILE_TOOLS.has(item.toolName) ? 'switch to acceptEdits mode' : formatSuggestionsLabel(item.suggestions))
        : undefined;

      const batchId = item.callbackId;
      this.flushedBatches.set(batchId, { callbackId: batchId, itemIds: new Set([item.callbackId]) });

      this.slack.sendInteractivePrompt(batchId, 'permission', {
        tool: item.toolName,
        command: item.toolName === 'Bash' && typeof (this.pendingPermissions.get(item.callbackId) as any)?.toolInput?.command === 'string'
          ? undefined : undefined,
        description: item.lockText,
        alwaysAllowLabel,
      }).catch((err) => {
        this.logger.warn('Failed to post permission message', {
          callbackId: batchId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      this.logger.info('Permission posted (single)', { callbackId: batchId });
    } else {
      // Multiple items — post as a batch
      const batchId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const itemIds = new Set(items.map(i => i.callbackId));
      this.flushedBatches.set(batchId, { callbackId: batchId, itemIds });

      this.slack.sendInteractivePrompt(batchId, 'permission', {
        tool: 'batch',
        description: `${items.length} tools requiring permission`,
        tools: items.map(i => ({ tool: i.toolName, description: i.lockText })),
      }).catch((err) => {
        this.logger.warn('Failed to post batch permission message', {
          callbackId: batchId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      this.logger.info('Permission posted (batch)', { callbackId: batchId, count: items.length });
    }
  }

  // ── askUserQuestion ───────────────────────────────────────────

  /**
   * Post question blocks to Slack and return a promise that resolves
   * with the user's answer string when resolveInteraction is called.
   */
  askUserQuestion(input: AskUserQuestionOpts): Promise<string> {
    // Supersede any existing pending question
    if (this.pendingQuestion) {
      this.pendingQuestion.reject(new Error('Superseded by new question'));
      this.pendingQuestion = null;
    }

    const { callbackId, questions } = input;

    this.slack.sendInteractivePrompt(callbackId, 'question', {
      questions,
    }).catch((err) => {
      this.logger.warn('Failed to post question message', {
        callbackId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    this.logger.info('Question posted', { callbackId, questionCount: questions.length });

    this.onAwaitingInput?.();

    return new Promise<string>((resolve, reject) => {
      this.pendingQuestion = {
        callbackId,
        resolve: (value) => { this.onInputReceived?.(); resolve(value); },
        reject,
        createdAt: Date.now(),
      };
    });
  }

  // ── requestPlanReview ─────────────────────────────────────────

  /**
   * Post plan review blocks to Slack and return a promise that resolves
   * with the user's approval/rejection when resolveInteraction is called.
   */
  requestPlanReview(planContent: string, callbackId: string): Promise<PlanReviewResult> {
    // Supersede any existing pending plan review
    if (this.pendingPlanReview) {
      this.pendingPlanReview.reject(new Error('Superseded by new plan review'));
      this.pendingPlanReview = null;
    }

    const { text, blocks, splitMessages } = buildPlanReviewBlocks({
      planContent,
      callbackId,
    });

    if (splitMessages) {
      for (const msgBlocks of splitMessages) {
        this.slack.postMessage('', '', text, msgBlocks).catch((err) => {
          this.logger.warn('Failed to post plan review split message', {
            callbackId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    } else {
      this.slack.postMessage('', '', text, blocks).catch((err) => {
        this.logger.warn('Failed to post plan review message', {
          callbackId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    this.logger.info('Plan review posted', { callbackId });

    this.onAwaitingInput?.();

    return new Promise<PlanReviewResult>((resolve, reject) => {
      this.pendingPlanReview = {
        callbackId,
        resolve: (value) => { this.onInputReceived?.(); resolve(value); },
        reject,
        createdAt: Date.now(),
      };
    });
  }

  // ── resolveInteraction ────────────────────────────────────────

  /**
   * Resolve the pending promise for the given callbackId.
   * If callbackId is a batch ID, resolves ALL permissions in that batch.
   * Returns true if a matching pending item was found and resolved, false otherwise.
   */
  resolveInteraction(callbackId: string, payload: any): boolean {
    // Check if this is a batch callbackId
    const batch = this.flushedBatches.get(callbackId);
    if (batch) {
      const permPayload = payload as PermissionResult;
      let resolved = false;
      for (const itemId of batch.itemIds) {
        const item = this.pendingPermissions.get(itemId);
        if (item) {
          this.pendingPermissions.delete(itemId);
          item.resolve(permPayload);
          resolved = true;
        }
      }
      this.flushedBatches.delete(callbackId);
      if (resolved) {
        this.onInputReceived?.();
        this.logger.info('Permission batch resolved', {
          callbackId,
          count: batch.itemIds.size,
          approved: permPayload.approved,
        });
        return true;
      }
    }

    // Check individual permission (non-batched or single-item batch already cleaned)
    const permItem = this.pendingPermissions.get(callbackId);
    if (permItem) {
      this.pendingPermissions.delete(callbackId);
      permItem.resolve(payload as PermissionResult);
      this.onInputReceived?.();
      this.logger.info('Permission resolved', { callbackId });
      return true;
    }

    // Check question
    if (this.pendingQuestion?.callbackId === callbackId) {
      const item = this.pendingQuestion;
      this.pendingQuestion = null;
      item.resolve(payload.answer as string);
      this.logger.info('Question resolved', { callbackId });
      return true;
    }

    // Check plan review
    if (this.pendingPlanReview?.callbackId === callbackId) {
      const item = this.pendingPlanReview;
      this.pendingPlanReview = null;
      item.resolve(payload as PlanReviewResult);
      this.logger.info('Plan review resolved', { callbackId });
      return true;
    }

    this.logger.warn('resolveInteraction: no matching callbackId', { callbackId });
    return false;
  }

  // ── hasPending ────────────────────────────────────────────────

  /**
   * True if any permission, question, or plan review is pending.
   */
  get hasPending(): boolean {
    return (
      this.pendingPermissions.size > 0 ||
      this.pendingQuestion !== null ||
      this.pendingPlanReview !== null
    );
  }

  // ── staleCount ────────────────────────────────────────────────

  /**
   * Count of pending items older than the given threshold in milliseconds.
   */
  staleCount(thresholdMs: number): number {
    const now = Date.now();
    let count = 0;

    for (const item of this.pendingPermissions.values()) {
      if ((now - item.createdAt) > thresholdMs) count++;
    }
    if (this.pendingQuestion && (now - this.pendingQuestion.createdAt) > thresholdMs) {
      count++;
    }
    if (this.pendingPlanReview && (now - this.pendingPlanReview.createdAt) > thresholdMs) {
      count++;
    }

    return count;
  }

  // ── clearAll ──────────────────────────────────────────────────

  /**
   * Reject all pending promises. Used for cleanup when a worker is shutting down.
   */
  clearAll(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.unflushedIds.clear();
    this.flushedBatches.clear();

    for (const item of this.pendingPermissions.values()) {
      item.reject(new Error('Cleared'));
    }
    this.pendingPermissions.clear();

    if (this.pendingQuestion) {
      this.pendingQuestion.reject(new Error('Cleared'));
      this.pendingQuestion = null;
    }
    if (this.pendingPlanReview) {
      this.pendingPlanReview.reject(new Error('Cleared'));
      this.pendingPlanReview = null;
    }
  }

  /**
   * Get the tool name(s) for the pending permission with the given callbackId.
   * For batch callbackIds, returns all tool names in the batch.
   */
  getToolNames(callbackId: string): string[] {
    // Check batch
    const batch = this.flushedBatches.get(callbackId);
    if (batch) {
      const names: string[] = [];
      for (const itemId of batch.itemIds) {
        const item = this.pendingPermissions.get(itemId);
        if (item) names.push(item.toolName);
      }
      return names;
    }

    // Check individual
    const item = this.pendingPermissions.get(callbackId);
    return item ? [item.toolName] : [];
  }

  /**
   * Get the stored SDK suggestions for the pending permission with the given callbackId.
   * For batch callbackIds, merges suggestions from all items in the batch.
   * Used by the worker to return updatedPermissions on "Always allow".
   */
  getSuggestions(callbackId: string): unknown[] | undefined {
    // Check batch
    const batch = this.flushedBatches.get(callbackId);
    if (batch) {
      const allSuggestions: unknown[] = [];
      for (const itemId of batch.itemIds) {
        const item = this.pendingPermissions.get(itemId);
        if (item?.suggestions) allSuggestions.push(...item.suggestions);
      }
      return allSuggestions.length > 0 ? allSuggestions : undefined;
    }

    // Check individual
    const item = this.pendingPermissions.get(callbackId);
    return item?.suggestions;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Build a human-readable label from SDK PermissionUpdate suggestions.
 * e.g. "Bash(git add:*)" or "Edit(/Users/biliu/Workspace/src/**)"
 */
function formatSuggestionsLabel(suggestions: unknown[]): string {
  const labels: string[] = [];
  for (const s of suggestions) {
    if (typeof s !== 'object' || s === null) continue;
    const suggestion = s as Record<string, unknown>;
    if (suggestion.type !== 'addRules' && suggestion.type !== 'replaceRules') continue;
    const rules = suggestion.rules;
    if (!Array.isArray(rules)) continue;
    for (const rule of rules) {
      if (typeof rule !== 'object' || rule === null) continue;
      const { toolName, ruleContent } = rule as Record<string, unknown>;
      if (typeof toolName === 'string' && typeof ruleContent === 'string') {
        labels.push(`${toolName}(${ruleContent})`);
      }
    }
  }
  return labels.join(', ') || 'this pattern';
}
