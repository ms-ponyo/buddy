// src/orchestration/worker-loop.ts — Core orchestrator for a single thread's session lifecycle.
// Ties together all services: ClaudeSessionService, ProgressTracker,
// PermissionManager, InteractiveBridge, ConfigOverrides, McpRegistry, etc.
// Stream lifecycle is owned by the gateway; worker enqueues stream messages.
// Ported from src/slack-handler/core/worker.ts runWorker() (532 lines → class-based).

import type { QueueMessage, StreamMessage } from '@buddy/shared';
import type { Logger } from '../logger.js';
import type {
  BuddyConfig,
  ActiveExecution,
  ExecEntry,
  ClaudeResult,
  SessionCallbacks,
  BufferedMessage,
  SDKUserMessage,
} from '../types.js';
import type { SlackAdapter } from '../adapters/slack-adapter.js';
import type { PersistenceAdapter } from '../adapters/persistence-adapter.js';
import type { ClaudeSessionService } from '../services/claude-session.js';
import type { ProgressTracker } from '../services/progress-tracker.js';
import type { PermissionManager } from '../services/permission-manager.js';
import type { InteractiveBridge } from '../services/interactive-bridge.js';
import type { ConfigOverrides } from '../services/config-overrides.js';
import type { McpRegistry } from '../services/mcp-registry.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildCallbacks } from './callback-builder.js';
import { withRetry, isAuthError } from '../util/retry.js';
import { formatExecutionLog, buildCompletionContextBlock } from '../util/execution-log.js';
import { splitMarkdownIntoMessages } from '../util/format.js';
import { buildFileHints } from '../util/file-helpers.js';
import { consumeForkedHistory } from '../util/thread-history.js';
import { swapReactions } from '../ui/reaction-manager.js';
import { createCanUseToolHook } from '../hooks/can-use-tool.js';
import { createPreToolUseHook } from '../hooks/pre-tool-use.js';

// Slack rejects messages whose payload exceeds ~40 KB.  The gateway
// already splits text into 3 000-char blocks, but the raw `text` field
// (used for notifications / fallback) is sent unsplit.  If the combined
// payload is too large, Slack returns `msg_too_long` and the outbound
// message is silently dead-lettered.  We cap at 30 000 chars to leave
// headroom for blocks overhead, and fall back to a file upload.
const SLACK_MSG_CHAR_LIMIT = 30_000;

// ── AsyncInputQueue (lightweight, embedded) ──────────────────────────
// Single-consumer async iterable.

export class AsyncInputQueue<T> implements AsyncIterable<T> {
  private _buffer: T[] = [];
  private waiter?: { resolve: (r: IteratorResult<T>) => void };
  private isDone = false;
  private consumed = false;

  enqueue(item: T): boolean {
    if (this.isDone) return false;
    if (this.waiter) {
      const { resolve } = this.waiter;
      this.waiter = undefined;
      resolve({ done: false, value: item });
    } else {
      this._buffer.push(item);
    }
    return true;
  }

  close(): void {
    if (this.isDone) return;
    this.isDone = true;
    if (this.waiter) {
      const { resolve } = this.waiter;
      this.waiter = undefined;
      resolve({ done: true, value: undefined as unknown as T });
    }
  }

  get closed(): boolean {
    return this.isDone;
  }

  get pending(): number {
    return this._buffer.length;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.consumed) throw new Error('AsyncInputQueue: already consumed');
    this.consumed = true;
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this._buffer.length > 0)
          return Promise.resolve({ done: false, value: this._buffer.shift()! });
        if (this.isDone)
          return Promise.resolve({ done: true, value: undefined as unknown as T });
        return new Promise((resolve) => {
          this.waiter = { resolve };
        });
      },
    };
  }
}

// ── Constructor deps ─────────────────────────────────────────────────

export interface WorkerLoopDeps {
  config: BuddyConfig;
  slack: SlackAdapter;
  persistence: PersistenceAdapter;
  claudeSession: ClaudeSessionService;
  progress: ProgressTracker;
  permissions: PermissionManager;
  bridge: InteractiveBridge;
  configOverrides: ConfigOverrides;
  mcpRegistry: McpRegistry;
  logger: Logger;
  threadKey: string;
  channel: string;
  threadTs: string;
}

// ── WorkerLoop ──────────────────────────────────────────────────────

export class WorkerLoop {
  private readonly config: BuddyConfig;
  private readonly slack: SlackAdapter;
  private readonly persistence: PersistenceAdapter;
  private readonly claudeSession: ClaudeSessionService;
  private readonly progress: ProgressTracker;
  private readonly permissions: PermissionManager;
  private readonly bridge: InteractiveBridge;
  private readonly configOverrides: ConfigOverrides;
  private readonly mcpRegistry: McpRegistry;
  private readonly logger: Logger;
  private readonly threadKey: string;
  private readonly channel: string;
  private readonly threadTs: string;

  private userId: string | null = null;
  private sessionId: string | null = null;
  private inputQueue: AsyncInputQueue<SDKUserMessage> | null = null;
  private _currentExecution: ActiveExecution | null = null;
  private _lastActivityAt: number = Date.now();
  private _interrupted = false;
  private _messageTimestamps: string[] = [];
  /** Name of currently executing tool (set on onToolUse, cleared on onToolResult). */
  private _activeToolName: string | null = null;

  /** Per-message turn completion tracking (FIFO). Each entry is resolved
   *  by onTurnResult when the SDK finishes processing that message. */
  private _turnCompletions: Array<{ ack?: () => Promise<void>; resolve: () => void }> = [];
  /** Promise for the background long-running session. */
  private _activeSessionPromise: Promise<void> | null = null;

  constructor(deps: WorkerLoopDeps) {
    this.config = deps.config;
    this.slack = deps.slack;
    this.persistence = deps.persistence;
    this.claudeSession = deps.claudeSession;
    this.progress = deps.progress;
    this.permissions = deps.permissions;
    this.bridge = deps.bridge;
    this.configOverrides = deps.configOverrides;
    this.mcpRegistry = deps.mcpRegistry;
    this.logger = deps.logger;
    this.threadKey = deps.threadKey;
    this.channel = deps.channel;
    this.threadTs = deps.threadTs;
  }

  // ── init ──────────────────────────────────────────────────────────

  /**
   * Hydrate session ID from persistence. Call once after construction.
   */
  async init(): Promise<void> {
    this.sessionId = await this.persistence.getSessionId(this.channel, this.threadTs);
    if (this.sessionId) {
      this.logger.info('Hydrated session ID from persistence', { sessionId: this.sessionId });
    }
  }

  // ── handleMessage ─────────────────────────────────────────────────

  /**
   * Main entry point for inbound messages. If a session is alive,
   * enqueues directly to the SDK. Otherwise starts a long-running session
   * in the background. Returns when this specific message's turn completes.
   */
  async handleMessage(msg: QueueMessage, onResponsePosted?: () => Promise<void>): Promise<void> {
    const prompt = typeof msg.payload.prompt === 'string' ? msg.payload.prompt : '';
    const files = msg.payload.files as BufferedMessage['files'];
    const messageTs = typeof msg.payload.messageTs === 'string' ? msg.payload.messageTs : '';
    const userId = typeof msg.payload.userId === 'string' ? msg.payload.userId : undefined;
    const teamId = typeof msg.payload.teamId === 'string' ? msg.payload.teamId : undefined;

    const buffered: BufferedMessage = { prompt, messageTs, userId, teamId, files };

    // Touch activity immediately so the health monitor doesn't see a stale
    // last_activity_sec while the SDK is still bootstrapping the new turn.
    this._lastActivityAt = Date.now();

    // Track message timestamp for reaction swapping
    if (messageTs) {
      this._messageTimestamps.push(messageTs);
    }

    // Create a per-message promise that resolves when onTurnResult fires
    const turnDone = new Promise<void>((resolve) => {
      this._turnCompletions.push({ ack: onResponsePosted, resolve });
    });

    if (userId) this.userId = userId;

    if (this.inputQueue && !this.inputQueue.closed) {
      // Session alive — enqueue directly and restart the stream
      this.enqueueToSDK(this.inputQueue, buffered);
      await this.slack.enqueueOutbound({ type: 'stream_start', channel: this.channel, threadTs: this.threadTs, userId: this.userId ?? '' });
      await turnDone;
      return;
    }

    // Start a new long-running session in the background
    this._activeSessionPromise = this.runSession(buffered).catch((err) => {
      this.logger.error('Background session error', { error: String(err) });
    });
    await turnDone;
  }

  // ── interrupt ─────────────────────────────────────────────────────

  /**
   * Interrupt the current active session.
   * Closes the input queue, drains pending turn completions, and aborts the SDK.
   */
  interrupt(): void {
    this._interrupted = true;
    this.claudeSession.interrupt();
    if (this.inputQueue) {
      this.inputQueue.close();
    }
    // Drain pending turn completions so handleMessage callers don't hang
    for (const turn of this._turnCompletions) turn.resolve();
    this._turnCompletions = [];
    this.logger.info('WorkerLoop interrupted');
  }

  /**
   * Interrupt and wait for the active session to fully shut down (including
   * the SDK subprocess).  Returns immediately if no session is running.
   * Caps the wait at {@link timeoutMs} to avoid blocking shutdown forever.
   */
  async interruptAndWait(timeoutMs = 7_000): Promise<void> {
    const sessionPromise = this._activeSessionPromise;
    this.interrupt();
    if (!sessionPromise) return;

    await Promise.race([
      sessionPromise,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  // ── awaitingUserInput ─────────────────────────────────────────────

  /**
   * True if any service is awaiting user interaction.
   */
  get awaitingUserInput(): boolean {
    return (
      this.permissions.hasPending ||
      this.bridge.hasPending
    );
  }

  // ── lastActivityAge ───────────────────────────────────────────────

  /**
   * Milliseconds since last activity.
   */
  get lastActivityAge(): number {
    return Date.now() - this._lastActivityAt;
  }

  /** Name of tool currently being executed, or null if idle between tools. */
  get activeToolName(): string | null {
    return this._activeToolName;
  }

  // ── currentExecution ──────────────────────────────────────────────

  get currentExecution(): ActiveExecution | null {
    return this._currentExecution;
  }

  // ── runSession (internal) ─────────────────────────────────────────

  /**
   * Long-running session: starts the SDK, keeps it alive across messages.
   * Each inbound message is enqueued to the same input queue. onTurnResult
   * handles per-turn acking, session persistence, usage posting, and reactions.
   * Only returns when the session is interrupted or an unrecoverable error occurs.
   */
  private async runSession(firstMsg: BufferedMessage): Promise<void> {
    if (firstMsg.userId) this.userId = firstMsg.userId;
    const effectiveConfig = this.configOverrides.resolveConfig(this.config);
    const execLog: ExecEntry[] = [];

    const executionState: ActiveExecution = {
      execLog,
      channel: this.channel,
      threadTs: this.threadTs,
      toolCount: 0,
      filesChanged: new Set(),
      lastIntent: '',
      statusTs: '',
      isBackground: false,
      interrupted: false,
      model: effectiveConfig.claudeModel,
      costUsd: 0,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    this._currentExecution = executionState;
    this._interrupted = false;

    // Create input queue — stays open for the worker's lifetime
    const queue = new AsyncInputQueue<SDKUserMessage>();
    this.inputQueue = queue;

    // Build prompt (with forked history injection if present)
    const prompt = this.buildPrompt(firstMsg);
    queue.enqueue({
      type: 'user' as const,
      message: { role: 'user' as const, content: prompt },
      parent_tool_use_id: null,
      session_id: '',
    });
    execLog.push({ type: 'user_message', content: firstMsg.prompt });

    // Build callbacks
    const touchActivity = (): void => {
      this._lastActivityAt = Date.now();
      executionState.lastActivityAt = Date.now();
    };

    // Track whether we've posted a successful (non-error) response to Slack.
    // Once true, retrying the session would produce duplicate messages.
    // Error-only results don't set this flag so the resume fallback can still trigger.
    let responsePosted = false;

    const onTurnResult = (result: ClaudeResult): boolean => {
      // Finalize stream first so it completes before the final reply appears below it
      this.progress.finalizeCurrentCard();
      const finalMainChunks = this.progress.buildMainChunks();
      if (finalMainChunks.length) {
        this.slack.enqueueOutbound({ type: 'stream_chunk', channel: this.channel, threadTs: this.threadTs, userId: this.userId ?? '', streamType: 'main', chunks: finalMainChunks } as StreamMessage)
          .catch((err) => this.logger.warn('Failed to enqueue final main chunks', { error: String(err) }));
      }
      const finalTodoChunks = this.progress.buildTodoChunks();
      if (finalTodoChunks.length) {
        this.slack.enqueueOutbound({ type: 'stream_chunk', channel: this.channel, threadTs: this.threadTs, userId: this.userId ?? '', streamType: 'todo', chunks: finalTodoChunks } as StreamMessage)
          .catch((err) => this.logger.warn('Failed to enqueue final todo chunks', { error: String(err) }));
      }
      this.slack.enqueueOutbound({ type: 'stream_stop', channel: this.channel, threadTs: this.threadTs, streamTypes: ['main'] })
        .catch((err) => this.logger.warn('Failed to enqueue stream stop', { error: String(err) }));

      // Post turn result to Slack (after stream is stopped)
      if (result.isError && result.result.trim()) {
        const errText = result.result.length > 3000
          ? result.result.slice(0, 3000) + '\n\n_(error truncated)_'
          : result.result;
        this.slack.postMessage(this.channel, this.threadTs, `:warning: Error:\n${errText}`,
          [{ type: 'markdown', text: `:warning: Error:\n${errText}` }])
          .catch((err) => this.logger.warn('Failed to post turn error', { error: String(err) }));
        // Don't set responsePosted for errors — allows resume fallback to still trigger
      } else if (result.result.trim()) {
        if (result.result.length > SLACK_MSG_CHAR_LIMIT) {
          this.postLongResult(result.result)
            .catch((err) => this.logger.warn('Failed to post long turn result', { error: String(err) }));
        } else {
          const messageGroups = splitMarkdownIntoMessages(result.result);
          for (const blocks of messageGroups) {
            const groupText = blocks.map((b) => b.text).join('\n\n');
            this.slack.postMessage(this.channel, this.threadTs, groupText, blocks)
              .catch((err) => this.logger.warn('Failed to post turn result', { error: String(err) }));
          }
        }
        responsePosted = true;
      }

      // Persist session ID once (it never changes within a session)
      if (!this.sessionId) {
        this.persistence.setSessionId(this.channel, this.threadTs, result.sessionId)
          .catch((err) => this.logger.warn('Failed to save session ID', { error: String(err) }));
      }
      this.sessionId = result.sessionId;
      executionState.sessionId = result.sessionId;

      // ── Per-turn: accumulate cost ──
      executionState.costUsd += result.costUsd;
      this.persistence.addCost(this.channel, this.threadTs, result.costUsd)
        .catch((err) => this.logger.warn('Failed to add cost per-turn', { error: String(err) }));

      // ── Per-turn: ack inbound messages consumed by the SDK ──
      // The SDK may coalesce multiple queued user messages into a single
      // turn, producing fewer results than messages.  We ack every entry
      // whose message has already been consumed from the input queue:
      //   consumed = _turnCompletions.length − inputQueue.pending
      const pendingInQueue = this.inputQueue?.pending ?? 0;
      const toAck = this._turnCompletions.length - pendingInQueue;
      if (toAck > 1) {
        this.logger.info('Acking coalesced turn completions', { count: toAck });
      }
      for (let i = 0; i < toAck; i++) {
        const turn = this._turnCompletions.shift();
        if (!turn) break;
        if (turn.ack) {
          turn.ack().catch((err) =>
            this.logger.warn('Failed to ack message per-turn', { error: String(err) }),
          );
        }
        turn.resolve();
      }

      // ── Per-turn: post usage summary footer ──
      const usage = result.usage;
      const effort = this.configOverrides.getEffort() ?? 'medium';
      const mode = this.configOverrides.getPermissionMode()
        ?? this.claudeSession.getInitInfo()?.permissionMode
        ?? effectiveConfig.permissionMode;
      const ctxPct = usage.contextWindowPercent > 0 ? usage.contextWindowPercent : 0;
      const filledBlocks = Math.round((ctxPct / 100) * 10);
      const ctxBar = '█'.repeat(filledBlocks) + '░'.repeat(10 - filledBlocks);
      const usageNote =
        `${effectiveConfig.claudeModel} | ` +
        `Effort: ${effort} | ` +
        `Mode: ${mode} | ` +
        `Context: \`${ctxBar}\` ${ctxPct}%`;
      const blocks = [buildCompletionContextBlock(usageNote)];
      this.slack.appendToLastMessage(this.channel, this.threadTs, usageNote, blocks)
        .catch((err) => this.logger.warn('Failed to post usage per-turn', { error: String(err) }));

      // ── Per-turn: swap hourglass → checkmark ──
      const timestamps = this._messageTimestamps.splice(0);
      if (timestamps.length > 0) {
        swapReactions(this.slack, this.channel, timestamps, 'white_check_mark')
          .catch((err) => this.logger.warn('Failed to swap reactions per-turn', { error: String(err) }));
      }

      // Always keep session alive — wait for the next message
      return true;
    };

    const callbacks = buildCallbacks({
      progress: this.progress,
      logger: this.logger,
      touchActivity,
      onToolStart: (toolName: string) => { this._activeToolName = toolName; },
      onToolEnd: () => { this._activeToolName = null; },
      onImageContent: (imageData: Buffer, mediaType: string, toolName?: string) => {
        // Delegate to slack upload (fire-and-forget)
        this.logger.debug('Image content received', { toolName, mediaType });
      },
      onTurnResult,
      enqueueMainChunks: () => {
        const chunks = this.progress.buildMainChunks();
        if (chunks.length === 0) return;
        this.slack.enqueueOutbound({
          type: 'stream_chunk', channel: this.channel, threadTs: this.threadTs,
          userId: this.userId ?? '', streamType: 'main', chunks,
        } as StreamMessage).catch((err) => {
          this.logger.warn('Main chunk enqueue failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      },
      enqueueTodoChunks: () => {
        const chunks = this.progress.buildTodoChunks();
        if (chunks.length === 0) return;
        this.slack.enqueueOutbound({
          type: 'stream_chunk', channel: this.channel, threadTs: this.threadTs,
          userId: this.userId ?? '', streamType: 'todo', chunks,
        } as StreamMessage).catch((err) => {
          this.logger.warn('Todo chunk enqueue failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      },
      enqueueTodoStop: () => {
        this.slack.enqueueOutbound({
          type: 'stream_stop', channel: this.channel, threadTs: this.threadTs,
          streamTypes: ['todo'],
        }).catch((err) => {
          this.logger.warn('Todo stream stop failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      },
      setTypingStatus: (status: string) => {
        this.slack.setTypingStatus(this.channel, this.threadTs, status)
          .catch((err) => {
            this.logger.debug('Failed to set typing status', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
      },
    });

    // Start the Slack stream (shows "Working..." indicator + tool progress)
    await this.slack.enqueueOutbound({ type: 'stream_start', channel: this.channel, threadTs: this.threadTs, userId: this.userId ?? '' });

    // Create MCP servers
    const mcpServers = this.mcpRegistry.createServers(
      { channel: this.channel, threadTs: this.threadTs, config: effectiveConfig },
      effectiveConfig.enabledMcpServers.length > 0 ? effectiveConfig.enabledMcpServers : undefined,
    );

    // Build SDK hooks
    const canUseTool = createCanUseToolHook({
      permissions: this.permissions,
      configOverrides: this.configOverrides,
      logger: this.logger,
      channel: this.channel,
      threadTs: this.threadTs,
      previewMode: effectiveConfig.previewMode as 'off' | 'destructive' | 'moderate',
      projectDir: effectiveConfig.projectDir,
    });

    const preToolUseMatchers = createPreToolUseHook({
      bridge: this.bridge,
      permissions: this.permissions,
      configOverrides: this.configOverrides,
      logger: this.logger,
      channel: this.channel,
      threadTs: this.threadTs,
      interactivePatterns: (effectiveConfig.interactiveBridgePatterns ?? []).map(p => p.base),
    });

    const hooks = { PreToolUse: preToolUseMatchers };

    // Build extra SDK options from overrides
    const extraOptions: Record<string, unknown> = {};
    const effort = this.configOverrides.getEffort();
    const budget = this.configOverrides.getBudget();
    if (effort) extraOptions.effort = effort;
    if (budget) extraOptions.maxBudgetUsd = budget;

    try {
      // Invoke with resume fallback — runs until interrupted or error
      await this.invokeWithResumeFallback({
        queue,
        config: effectiveConfig,
        callbacks,
        mcpServers,
        hooks,
        canUseTool,
        extraOptions: Object.keys(extraOptions).length > 0 ? extraOptions : undefined,
        execLog,
        executionState,
        firstMsg,
        responsePosted: () => responsePosted,
      });

      // Session ended (interrupted or queue closed)
      this.logger.info('Session ended', { sessionId: this.sessionId });
    } catch (error) {
      queue.close();
      await this.onSessionError(error, executionState, effectiveConfig, execLog);
    } finally {
      this.inputQueue = null;
      this._currentExecution = null;
      this._activeSessionPromise = null;
      // Always stop the stream
      await this.slack.enqueueOutbound({ type: 'stream_stop', channel: this.channel, threadTs: this.threadTs });
      // Drain any pending turn completions (e.g. if session died mid-turn)
      for (const turn of this._turnCompletions) turn.resolve();
      this._turnCompletions = [];
    }
  }

  // ── invokeWithResumeFallback ──────────────────────────────────────

  /**
   * Invoke the Claude session with retry logic and resume fallback.
   * If resume fails, retries as a new session.
   * If SDK returns 0 tokens on resume (crash-result), also falls back.
   */
  private async invokeWithResumeFallback(params: {
    queue: AsyncInputQueue<SDKUserMessage>;
    config: BuddyConfig;
    callbacks: SessionCallbacks;
    mcpServers: Record<string, unknown>;
    hooks?: Record<string, unknown>;
    canUseTool?: import('@anthropic-ai/claude-agent-sdk').CanUseTool;
    extraOptions?: Record<string, unknown>;
    execLog: ExecEntry[];
    executionState: ActiveExecution;
    firstMsg: BufferedMessage;
    responsePosted: () => boolean;
  }): Promise<ClaudeResult> {
    const { config, callbacks, mcpServers, hooks, canUseTool, extraOptions, execLog, executionState, firstMsg, responsePosted } = params;
    let { queue } = params;
    const existingSessionId = this.sessionId;

    let result: ClaudeResult;
    let isRetry = false;

    try {
      result = await withRetry(
        () => {
          // Only retry if no response has been posted to Slack yet.
          // Once posted, retrying would produce duplicate messages.
          if (isRetry && responsePosted()) {
            throw Object.assign(
              new Error('SDK error after response was already posted to Slack'),
              { _skipRetry: true },
            );
          }
          if (isRetry) {
            queue.close();
            queue = new AsyncInputQueue<SDKUserMessage>();
            this.inputQueue = queue;
            this.enqueueToSDK(queue, firstMsg);
          }
          isRetry = true;

          return this.claudeSession.invoke({
            queue,
            config,
            sessionId: existingSessionId,
            callbacks,
            mcpServers,
            hooks,
            canUseTool,
            extraOptions,
            projectDir: config.projectDir,
          });
        },
        { maxRetries: 3 },
        this.logger,
      );
    } catch (resumeError) {
      // Unwrap our skip-retry sentinel
      if ((resumeError as any)?._skipRetry) {
        throw (resumeError as any).cause ?? resumeError;
      }

      // Auth errors should not trigger resume fallback
      if (isAuthError(resumeError)) {
        throw resumeError;
      }

      // If we had an existing session and haven't posted anything,
      // try as new session
      if (existingSessionId && !responsePosted()) {
        result = await this.retryAsNewSession(firstMsg, config, callbacks, mcpServers, hooks, canUseTool, extraOptions);
      } else {
        throw resumeError;
      }
    }

    // Resume error guard: SDK returned error result on resume attempt.
    // Covers both zero-token crashes and session-not-found errors.
    if (
      existingSessionId &&
      result.isError &&
      !responsePosted()
    ) {
      this.logger.warn('SDK returned error on resume, falling back to new session', {
        sessionId: existingSessionId,
        error: result.result.slice(0, 200),
      });
      result = await this.retryAsNewSession(firstMsg, config, callbacks, mcpServers, hooks, canUseTool, extraOptions);
    }

    return result;
  }

  // ── retryAsNewSession ──────────────────────────────────────────────

  private async retryAsNewSession(
    firstMsg: BufferedMessage,
    config: BuddyConfig,
    callbacks: SessionCallbacks,
    mcpServers: Record<string, unknown>,
    hooks?: Record<string, unknown>,
    canUseTool?: import('@anthropic-ai/claude-agent-sdk').CanUseTool,
    extraOptions?: Record<string, unknown>,
  ): Promise<ClaudeResult> {
    this.logger.warn('Retrying as new session (resume failed)');

    // Delete old session
    await this.persistence.deleteSession(this.channel, this.threadTs);
    this.sessionId = null;

    // Post warning to Slack
    await this.slack.postMessage(
      this.channel,
      this.threadTs,
      ':warning: Previous session could not be resumed. Replaying thread history into a new conversation.',
      [{ type: 'markdown', text: ':warning: Previous session could not be resumed. Replaying thread history into a new conversation.' }],
    ).catch(() => {}); // best-effort

    // Fetch thread history from Slack to preserve context
    let historyPrefix = '';
    try {
      const { messages } = await this.slack.conversationsReplies({
        channel: this.channel,
        ts: this.threadTs,
        limit: 200,
      });
      if (messages && messages.length > 0) {
        const formatted = messages
          .map((m) => {
            const prefix = m.bot_id ? '[assistant]' : `[user <@${m.user ?? 'unknown'}>]`;
            return `${prefix}: ${m.text ?? ''}`;
          })
          .join('\n\n');
        historyPrefix =
          `[Previous conversation history from this Slack thread — your session was reset but here is the context]\n\n` +
          `${formatted}\n\n` +
          `---\n\n` +
          `[End of history. The following is the new message — continue the conversation naturally.]\n\n`;
        this.logger.info('Injected thread history for new session', { messageCount: messages.length });
      }
    } catch (err) {
      this.logger.warn('Failed to fetch thread history for new session', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Create fresh queue with history-enriched prompt
    const newQueue = new AsyncInputQueue<SDKUserMessage>();
    this.inputQueue = newQueue;

    const enrichedMsg: BufferedMessage = historyPrefix
      ? { ...firstMsg, prompt: historyPrefix + firstMsg.prompt }
      : firstMsg;
    this.enqueueToSDK(newQueue, enrichedMsg);

    return this.claudeSession.invoke({
      queue: newQueue,
      config,
      sessionId: undefined,
      callbacks,
      mcpServers,
      hooks,
      canUseTool,
      extraOptions,
      projectDir: config.projectDir,
    });
  }

  // ── onSessionError ────────────────────────────────────────────────

  private async onSessionError(
    error: unknown,
    executionState: ActiveExecution,
    config: BuddyConfig,
    execLog: ExecEntry[],
  ): Promise<void> {
    const errMsg = error instanceof Error ? error.message : 'Unknown error occurred';
    this.logger.error('Claude Code call failed', { error: errMsg });

    this.persistExecLog(execLog, `Error: ${errMsg}`, executionState, config.claudeModel);

    this.slack.postMessage(
      this.channel,
      this.threadTs,
      `:x: Failed to run Claude Code: ${errMsg}`,
      [{ type: 'markdown', text: `:x: Failed to run Claude Code: ${errMsg}` }],
    ).catch((err) => this.logger.warn('Failed to post error message', { error: String(err) }));

    // Swap hourglass → warning on all tracked messages
    const timestamps = this._messageTimestamps.splice(0);
    if (timestamps.length > 0) {
      swapReactions(this.slack, this.channel, timestamps, 'warning')
        .catch((err) => this.logger.warn('Failed to swap reactions on error', { error: String(err) }));
    }
  }

  // ── postLongResult ────────────────────────────────────────────────

  /**
   * Post a result that exceeds Slack's message size limit.
   * Writes the full text to a temp file and uploads it, with a
   * truncated preview posted as the caption.
   */
  private async postLongResult(text: string): Promise<void> {
    const dir = join(tmpdir(), 'buddy-uploads');
    mkdirSync(dir, { recursive: true });
    const filename = `response-${Date.now()}.md`;
    const filePath = join(dir, filename);
    writeFileSync(filePath, text);

    const preview = text.slice(0, 256).trimEnd() + '...\n\n_(full response attached as file — exceeded Slack message limit)_';
    await this.slack.uploadFile(this.channel, this.threadTs, filename, filePath, preview);
    this.logger.info('Posted long result as file upload', { length: text.length, filePath });
  }

  // ── buildPrompt ───────────────────────────────────────────────────

  private buildPrompt(msg: BufferedMessage): string {
    // Check for forked history
    const forkedHistory = consumeForkedHistory(this.channel, this.threadTs);
    if (forkedHistory) {
      this.logger.info('Found forked thread history, injecting as context', {
        filePath: forkedHistory.filePath,
        chars: forkedHistory.content.length,
      });

      let logPathsHint = '';
      if (forkedHistory.logPaths) {
        const paths = forkedHistory.logPaths;
        const lines: string[] = [];
        if (paths.mainLog) lines.push(`Main bot log: ${paths.mainLog}`);
        if (paths.sessionLog) lines.push(`Session log: ${paths.sessionLog}`);
        if (paths.execLog) lines.push(`Execution log: ${paths.execLog}`);
        if (lines.length > 0) {
          logPathsHint = `\nSource thread log files:\n${lines.join('\n')}\n`;
        }
      }

      return (
        `[Context from forked source thread — read the file below for full conversation history]\n` +
        `Full thread history saved to: ${forkedHistory.filePath}\n` +
        logPathsHint +
        `Read this file for context before responding.\n\n` +
        `---\n\n${msg.prompt}`
      );
    }

    // Standard prompt with file hints
    const fileHints = buildFileHints(msg.files ?? []);
    return fileHints
      ? `${fileHints}\n\n${msg.prompt}`
      : msg.prompt;
  }

  // ── enqueueToSDK ──────────────────────────────────────────────────

  private enqueueToSDK(queue: AsyncInputQueue<SDKUserMessage>, msg: BufferedMessage): void {
    const fileHints = buildFileHints(msg.files ?? []);
    const content = fileHints
      ? (msg.prompt ? `${fileHints}\n\n${msg.prompt}` : fileHints)
      : msg.prompt;

    queue.enqueue({
      type: 'user' as const,
      message: { role: 'user' as const, content },
      parent_tool_use_id: null,
      session_id: '',
    });
  }

  // ── persistExecLog ────────────────────────────────────────────────

  private persistExecLog(
    execLog: ExecEntry[],
    resultText: string,
    executionState: ActiveExecution,
    model: string,
    usage?: ClaudeResult['usage'],
  ): void {
    if (execLog.length === 0) return;
    const markdown = formatExecutionLog(
      execLog,
      resultText,
      usage ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        contextWindowPercent: 0,
        numTurns: 0,
      },
      executionState.sessionId ?? 'unknown',
      model,
      executionState.costUsd,
    );
    executionState.finalMarkdown = markdown;
    executionState.usage = usage;
  }
}
