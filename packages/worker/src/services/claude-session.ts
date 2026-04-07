// src/services/claude-session.ts — Wraps the Claude Agent SDK query lifecycle.
// Ports from src/claude-handler.ts with a class-based design.

import type { Logger } from '../logger.js';
import type {
  BuddyConfig,
  ClaudeResult,
  UsageInfo,
  InvokeParams,
  SessionCallbacks,
} from '../types.js';

// ── Types for the SDK query function ────────────────────────────

/** Minimal interface for a Query returned by the SDK. */
interface SDKQuery extends AsyncIterable<Record<string, unknown>> {
  close(): void;
  setPermissionMode(mode: string): void;
  accountInfo(): Promise<Record<string, unknown>>;
}

/** Function signature for the SDK's query() function. */
export type QueryFn = (opts: {
  prompt: unknown;
  options: Record<string, unknown>;
}) => SDKQuery;

// ── Cached info from SDK init message ────────────────────────────

export interface InitInfo {
  claudeCodeVersion: string;
  cwd: string;
  model: string;
  permissionMode: string;
  mcpServers: { name: string; status: string }[];
  plugins: { name: string; path: string }[];
}

export interface AccountInfo {
  email?: string;
  organization?: string;
  subscriptionType?: string;
}

// ── Constructor deps ─────────────────────────────────────────────

export interface ClaudeSessionDeps {
  logger: Logger;
  queryFn: QueryFn;
}

// ── ClaudeSessionService ─────────────────────────────────────────

export class ClaudeSessionService {
  private readonly logger: Logger;
  private readonly queryFn: QueryFn;

  private activeQuery: SDKQuery | null = null;
  private currentSessionId: string | undefined;
  private interrupted = false;
  private cachedInitInfo: InitInfo | null = null;
  private cachedAccountInfo: AccountInfo | null = null;

  constructor(deps: ClaudeSessionDeps) {
    this.logger = deps.logger;
    this.queryFn = deps.queryFn;
  }

  // ── Public API ────────────────────────────────────────────────

  /**
   * Main entry point. Calls the SDK query() and streams through messages,
   * dispatching to the appropriate callback for each message type.
   */
  async invoke(params: InvokeParams): Promise<ClaudeResult> {
    const log = this.logger.child({ module: 'claude-session' });
    const { queue, config, sessionId, callbacks, mcpServers, hooks, canUseTool, systemPromptAppend, extraOptions, projectDir } = params;

    this.interrupted = false;

    // Build SDK options
    const allMcpServers = {
      ...(Object.keys(config.mcpServers).length > 0 ? config.mcpServers : {}),
      ...mcpServers,
    };
    const hasAnyMcp = Object.keys(allMcpServers).length > 0;

    const options: Record<string, unknown> = {
      model: config.claudeModel,
      executable: process.execPath,
      permissionMode: config.permissionMode,
      ...(config.permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: systemPromptAppend ?? 'You are running inside a Slack bot. Interactive commands are supported.',
      },
      settingSources: ['user', 'project', 'local'],
      ...(projectDir ? { cwd: projectDir } : {}),
      ...(hooks ? { hooks } : {}),
      ...(canUseTool ? { canUseTool } : {}),
      ...(hasAnyMcp ? { mcpServers: allMcpServers } : {}),
      ...(sessionId ? { resume: sessionId } : {}),
      ...extraOptions,
    };

    const q = this.queryFn({ prompt: queue, options });
    this.activeQuery = q;

    if (sessionId) {
      this.currentSessionId = sessionId;
    }

    let resultText = '';
    let isError = false;
    let costUsd = 0;
    let usage: UsageInfo = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      contextWindowPercent: 0,
      numTurns: 0,
    };
    let lastAssistantText = '';
    let lastTurnInputTokens = 0;
    const lastToolNameById = new Map<string, string>();

    try {
      for await (const message of q) {
        const msg = message as Record<string, unknown>;

        // ── System messages ──────────────────────────────────
        if (msg.type === 'system') {
          if (msg.subtype === 'init') {
            const initSessionId = msg.session_id as string;
            if (!this.currentSessionId) {
              this.currentSessionId = initSessionId;
              callbacks.onSessionInit(initSessionId);
            }
            log.info('Session init', { sessionId: initSessionId });

            // Cache init info for !status
            this.cachedInitInfo = {
              claudeCodeVersion: msg.claude_code_version as string,
              cwd: msg.cwd as string,
              model: msg.model as string,
              permissionMode: msg.permissionMode as string,
              mcpServers: (msg.mcp_servers as InitInfo['mcpServers']) ?? [],
              plugins: (msg.plugins as InitInfo['plugins']) ?? [],
            };

            // Fetch account info once
            if (!this.cachedAccountInfo) {
              q.accountInfo().then((info) => {
                this.cachedAccountInfo = {
                  email: info.email as string | undefined,
                  organization: info.organization as string | undefined,
                  subscriptionType: info.subscriptionType as string | undefined,
                };
              }).catch(() => { /* ignore */ });
            }
          }

          if (msg.subtype === 'status') {
            callbacks.onStatusChange(msg.status as 'compacting' | null);
          }
        }

        // ── Stream events ────────────────────────────────────
        if (msg.type === 'stream_event') {
          const ev = msg.event as Record<string, unknown>;

          // Per-turn input tokens from message_start
          if (ev.type === 'message_start') {
            const msgUsage = (ev.message as Record<string, unknown>)?.usage as Record<string, number> | undefined;
            if (msgUsage) {
              lastTurnInputTokens =
                (msgUsage.input_tokens ?? 0) +
                (msgUsage.cache_read_input_tokens ?? 0) +
                (msgUsage.cache_creation_input_tokens ?? 0);
            }
          }

          // Stream text deltas
          if (ev.type === 'content_block_delta') {
            const delta = ev.delta as Record<string, unknown> | undefined;
            if (delta?.type === 'text_delta' && delta.text) {
              callbacks.onStreamDelta(delta.text as string);
            }
            if (delta?.type === 'thinking_delta' && delta.thinking) {
              callbacks.onThinkingDelta(delta.thinking as string);
            }
          }
        }

        // ── Tool progress ────────────────────────────────────
        if (msg.type === 'tool_progress') {
          callbacks.onToolProgress(
            msg.tool_name as string,
            msg.elapsed_time_seconds as number,
            msg.tool_use_id as string,
          );
        }

        // ── User messages (tool results) ─────────────────────
        if (msg.type === 'user') {
          this.handleUserMessage(msg, lastToolNameById, callbacks, log);
        }

        // ── Assistant messages ────────────────────────────────
        if (msg.type === 'assistant') {
          const content = this.handleAssistantMessage(msg, lastToolNameById, callbacks);
          if (content) lastAssistantText = content;

          // Track input tokens from assistant usage
          const assistantUsage = (msg.message as Record<string, unknown>)?.usage as Record<string, number> | undefined;
          if (assistantUsage) {
            const turnInput =
              (assistantUsage.input_tokens ?? 0) +
              (assistantUsage.cache_read_input_tokens ?? 0) +
              (assistantUsage.cache_creation_input_tokens ?? 0);
            if (turnInput > 0) lastTurnInputTokens = turnInput;
          }
        }

        // ── Result message ───────────────────────────────────
        if (msg.type === 'result') {
          const resultData = this.handleResultMessage(msg, lastTurnInputTokens);
          this.currentSessionId = resultData.sessionId;
          resultText = resultData.resultText || lastAssistantText;
          isError = resultData.isError;
          costUsd = resultData.costUsd;
          usage = resultData.usage;

          // Ask the orchestrator if we should continue with more messages.
          // If not, close the input queue so the SDK ends the session.
          const turnResult: ClaudeResult = {
            result: resultText,
            isError,
            sessionId: this.currentSessionId ?? '',
            costUsd,
            usage,
          };
          const shouldContinue = callbacks.onTurnResult(turnResult);
          if (!shouldContinue) {
            queue.close();
          }
        }
      }
    } catch (queryError) {
      // If interrupted, return gracefully
      if (this.interrupted) {
        this.activeQuery = null;
        log.info('Query interrupted', { sessionId: this.currentSessionId });
        return {
          result: resultText || '(no response)',
          sessionId: this.currentSessionId ?? '',
          isError: false,
          usage,
          costUsd,
          interrupted: true,
        };
      }

      this.activeQuery = null;
      throw queryError;
    }

    this.activeQuery = null;

    // Check if we were interrupted (close() called, iterator ended normally)
    if (this.interrupted) {
      log.info('Query interrupted (post-loop)', { sessionId: this.currentSessionId });
      return {
        result: resultText || '(no response)',
        sessionId: this.currentSessionId ?? '',
        isError: false,
        usage,
        costUsd,
        interrupted: true,
      };
    }

    log.info('Query complete', {
      sessionId: this.currentSessionId,
      isError,
      costUsd,
      numTurns: usage.numTurns,
    });

    return {
      result: resultText || '(no response)',
      sessionId: this.currentSessionId ?? '',
      isError,
      usage,
      costUsd,
    };
  }

  /**
   * Return the current/last session ID.
   */
  getSessionId(): string | undefined {
    return this.currentSessionId;
  }

  /**
   * Return cached init info from the SDK init message, or null if not yet received.
   */
  getInitInfo(): InitInfo | null {
    return this.cachedInitInfo;
  }

  /**
   * Return cached account info, or null if not yet fetched.
   */
  getAccountInfo(): AccountInfo | null {
    return this.cachedAccountInfo;
  }

  /**
   * Returns true if there is a currently active query.
   */
  hasActiveQuery(): boolean {
    return this.activeQuery !== null;
  }

  /**
   * Interrupt the current active query.
   * Returns true if there was an active query to interrupt.
   */
  interrupt(): boolean {
    if (!this.activeQuery) return false;
    this.interrupted = true;
    this.activeQuery.close();
    this.activeQuery = null;
    this.logger.info('Session interrupted', { sessionId: this.currentSessionId });
    return true;
  }

  /**
   * Change the permission mode on the active query.
   */
  setPermissionMode(mode: string): void {
    if (this.activeQuery) {
      this.activeQuery.setPermissionMode(mode);
    }
  }

  // ── Private message handlers ──────────────────────────────────

  private handleAssistantMessage(
    msg: Record<string, unknown>,
    lastToolNameById: Map<string, string>,
    callbacks: SessionCallbacks,
  ): string {
    let lastText = '';
    const message = msg.message as Record<string, unknown>;
    const content = message?.content as Array<Record<string, unknown>> | undefined;

    if (!content) return lastText;

    for (const block of content) {
      if (block.type === 'thinking') {
        const thinking = block.thinking as string;
        if (thinking) callbacks.onThinkingDelta(thinking);
      }
      if (block.type === 'text') {
        const text = block.text as string;
        if (text) lastText = text;
        callbacks.onAssistantText(text);
      }
      if (block.type === 'tool_use') {
        lastToolNameById.set(block.id as string, block.name as string);
        callbacks.onToolUse(
          block.name as string,
          block.input as Record<string, unknown>,
          block.id as string,
        );
      }
    }

    return lastText;
  }

  private handleUserMessage(
    msg: Record<string, unknown>,
    lastToolNameById: Map<string, string>,
    callbacks: SessionCallbacks,
    log: Logger,
  ): void {
    const message = msg.message as Record<string, unknown> | undefined;
    const content = message?.content as Array<Record<string, unknown>> | undefined;

    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (block.type !== 'tool_result') continue;

      const toolUseId = block.tool_use_id as string | undefined;
      const toolName = toolUseId ? lastToolNameById.get(toolUseId) : undefined;

      if (typeof block.content === 'string' && toolUseId && toolName) {
        callbacks.onToolResult(toolName, toolUseId, block.content);
      } else if (Array.isArray(block.content)) {
        for (const inner of block.content as Array<Record<string, unknown>>) {
          if (inner.type === 'image' && callbacks.onImageContent) {
            const source = inner.source as { type: string; media_type: string; data: string } | undefined;
            if (source?.type === 'base64' && source.data) {
              callbacks.onImageContent(
                Buffer.from(source.data, 'base64'),
                source.media_type,
                toolName,
              );
            }
          }
          if (inner.type === 'text' && toolUseId && toolName) {
            callbacks.onToolResult(toolName, toolUseId, inner.text as string);
          }
        }
      }
    }
  }

  private handleResultMessage(
    msg: Record<string, unknown>,
    lastTurnInputTokens: number,
  ): {
    sessionId: string;
    resultText: string;
    isError: boolean;
    costUsd: number;
    usage: UsageInfo;
  } {
    const sessionId = msg.session_id as string;
    const isError = msg.is_error as boolean;
    const costUsd = (msg.total_cost_usd as number) ?? 0;
    const numTurns = msg.num_turns as number;

    const u = msg.usage as Record<string, number>;
    const totalInputTokens =
      (u.input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0);
    const totalOutputTokens = u.output_tokens ?? 0;

    // Compute context window percentage from last turn's input tokens
    let contextWindow = 0;
    const modelUsage = msg.modelUsage as Record<string, { contextWindow: number }> | undefined;
    if (modelUsage) {
      for (const model of Object.values(modelUsage)) {
        if (model.contextWindow > contextWindow) {
          contextWindow = model.contextWindow;
        }
      }
    }

    const contextWindowPercent =
      contextWindow > 0 && lastTurnInputTokens > 0
        ? Math.round((lastTurnInputTokens / contextWindow) * 100)
        : 0;

    const usage: UsageInfo = {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
      contextWindowPercent,
      numTurns,
    };

    let resultText: string;
    if (msg.subtype === 'success') {
      resultText = (msg.result as string) || '';
    } else {
      const errors = msg.errors as string[];
      resultText = errors?.join('\n') ?? '';
    }

    return { sessionId, resultText, isError, costUsd, usage };
  }
}
