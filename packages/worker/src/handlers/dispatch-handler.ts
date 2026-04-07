// src/handlers/dispatch-handler.ts — Dispatch handler for the lite worker.
// Port of DispatchLoop adapted for the lite worker: uses RPC-backed MCP tools
// and RemoteConfigOverrides instead of local in-memory objects.

import type { Logger } from '../logger.js';
import type { SlackAdapter } from '../adapters/slack-adapter.js';
import type { ClaudeSessionService } from '../services/claude-session.js';
import type { RemoteConfigOverrides } from '../services/remote-config-overrides.js';
import type { BuddyConfig, SessionCallbacks, SDKUserMessage } from '../types.js';
import type { RpcClient } from '../services/remote-config-overrides.js';
import { AsyncInputQueue } from '../orchestration/worker-loop.js';
import {
  buildDispatchBlocks,
  buildDispatchThinkingBlocks,
  buildDispatchErrorBlocks,
  friendlyToolLabel,
} from '../ui/dispatch-blocks.js';
import { createDispatchControlRpcServer } from '../mcp-servers/dispatch-control-rpc-server.js';

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ── System prompt ─────────────────────────────────────────────────────

const DISPATCH_BASE_PROMPT =
  'You are a concise command assistant. Answer in 1-2 sentences. ' +
  'You can control execution (stop, background), switch modes/models, check status, fork threads, ' +
  'and execute bot commands (clear, compact, cost, model, mode, project) via your MCP tools. ' +
  'When users ask for bot commands, ALWAYS use the execute_bot_command tool to run them directly — never tell users to type commands themselves. ' +
  'Do NOT perform complex coding tasks — delegate those to the main worker.';

// ── Constructor deps ──────────────────────────────────────────────────

export interface DispatchHandlerDeps {
  claudeSession: ClaudeSessionService;
  slack: SlackAdapter;
  logger: Logger;
  channel: string;
  threadTs: string;
  config: BuddyConfig;
  remoteConfig: RemoteConfigOverrides;
  mainWorkerRpc: RpcClient;
}

// ── DispatchHandler ──────────────────────────────────────────────────

export class DispatchHandler {
  private readonly claudeSession: ClaudeSessionService;
  private readonly slack: SlackAdapter;
  private readonly logger: Logger;
  private readonly channel: string;
  private readonly threadTs: string;
  private readonly threadKey: string;
  private readonly config: BuddyConfig;
  private readonly remoteConfig: RemoteConfigOverrides;
  private readonly mainWorkerRpc: RpcClient;

  private messageTs: string | null = null;
  private inputQueue: AsyncInputQueue<SDKUserMessage> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private isRunning = false;
  private stopping = false;
  private sessionGeneration = 0;
  private lastUserText = '';
  private sessionId: string | undefined;

  constructor(deps: DispatchHandlerDeps) {
    this.claudeSession = deps.claudeSession;
    this.slack = deps.slack;
    this.logger = deps.logger;
    this.channel = deps.channel;
    this.threadTs = deps.threadTs;
    this.threadKey = `${deps.channel}:${deps.threadTs}`;
    this.config = deps.config;
    this.remoteConfig = deps.remoteConfig;
    this.mainWorkerRpc = deps.mainWorkerRpc;
  }

  // ── feed — enqueue a message for the dispatch LLM ──────────────────

  async feed(text: string): Promise<void> {
    if (!this.isRunning) {
      this.isRunning = true;

      this.inputQueue = new AsyncInputQueue<SDKUserMessage>();

      let ts: string;
      try {
        ({ ts } = await this.slack.postMessageDirect(
          this.channel,
          this.threadTs,
          '_Dispatch session active\u2026_',
          buildDispatchBlocks(this.threadKey),
        ));
      } catch (err) {
        this.logger.error('DispatchHandler: failed to post dispatch message', { error: String(err) });
        this.isRunning = false;
        this.inputQueue = null;
        return;
      }

      this.messageTs = ts;
      this.logger.info('DispatchHandler: started', { threadKey: this.threadKey, messageTs: ts });

      const gen = ++this.sessionGeneration;
      this.runSession().catch((err) => {
        if (gen !== this.sessionGeneration) return;
        this.logger.error('DispatchHandler: session error', { error: String(err) });
        this.stop().catch(() => {});
      });
    }

    this.lastUserText = text;
    this.inputQueue?.enqueue({
      type: 'user' as const,
      message: { role: 'user' as const, content: text },
      parent_tool_use_id: null,
      session_id: '',
    });

    this.resetIdleTimer();
  }

  // ── stop ──────────────────────────────────────────────────────────

  async stop(): Promise<void> {
    if (this.stopping) return;
    if (!this.isRunning && !this.messageTs) return;

    this.stopping = true;
    this.logger.info('DispatchHandler: stopping', { threadKey: this.threadKey });

    try {
      this.inputQueue?.close();
      this.inputQueue = null;

      this.claudeSession.interrupt();

      if (this.messageTs) {
        await this.slack.queueDeleteMessage(this.channel, this.messageTs);
        this.messageTs = null;
      }
    } finally {
      this.clearIdleTimer();
      this.isRunning = false;
      this.stopping = false;
    }
  }

  // ── Accessors ──────────────────────────────────────────────────────

  get running(): boolean {
    return this.isRunning;
  }

  // ── runSession (internal) ──────────────────────────────────────────

  private async runSession(): Promise<void> {
    const queue = this.inputQueue!;

    // Build a dispatch-tailored config
    const dispatchConfig: BuddyConfig = {
      ...this.config,
      claudeModel: this.config.dispatchModel,
      permissionMode: 'bypassPermissions',
      mcpServers: {},   // Don't inherit global MCPs
      plugins: [],      // Don't load skills/plugins
    };

    // Create the dispatch-control MCP server backed by RPC to main worker
    const controlServer = createDispatchControlRpcServer(this.mainWorkerRpc);

    const callbacks: SessionCallbacks = {
      onSessionInit: (sessionId) => {
        this.sessionId = sessionId;
      },
      onStatusChange: () => {},
      onStreamDelta: () => {},
      onThinkingDelta: () => {},
      onAssistantText: () => {},
      onToolUse: (toolName) => {
        const label = friendlyToolLabel(toolName);
        this.logger.debug('Dispatch tool use', { toolName, label });
        if (this.messageTs) {
          const blocks = buildDispatchThinkingBlocks(
            this.threadKey,
            this.lastUserText,
            `${label}\u2026`,
          );
          this.slack.queueUpdateMessage(
            this.channel,
            this.messageTs,
            `\u{1F407} ${label}\u2026`,
            blocks,
          ).catch(() => {});
        }
      },
      onToolProgress: () => {},
      onToolResult: () => {},
      onImageContent: () => {},
      onTurnResult: (result) => {
        if (result.result.trim()) {
          this.updateDispatchMessage(result.result).catch((err) => {
            this.logger.warn('DispatchHandler: failed to update dispatch message', { error: String(err) });
          });
        }
        this.resetIdleTimer();
        return true;
      },
    };

    // Show thinking state when session starts
    if (this.messageTs) {
      const blocks = buildDispatchThinkingBlocks(this.threadKey, this.lastUserText);
      this.slack.queueUpdateMessage(
        this.channel,
        this.messageTs,
        '\u{1F407} _Thinking\u2026_',
        blocks,
      ).catch(() => {});
    }

    try {
      await this.claudeSession.invoke({
        queue,
        config: dispatchConfig,
        sessionId: this.sessionId,
        callbacks,
        mcpServers: { 'dispatch-control': controlServer },
        projectDir: dispatchConfig.projectDir,
        extraOptions: {
          tools: ['Read'],
          agents: {},
          systemPrompt: DISPATCH_BASE_PROMPT,
          settingSources: [],  // Don't load global skills/plugins/MCPs
        },
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error('DispatchHandler: session failed', { error: errMsg });
      if (this.messageTs) {
        const blocks = buildDispatchErrorBlocks(this.threadKey, `Dispatch failed: ${errMsg}`);
        this.slack.queueUpdateMessage(
          this.channel,
          this.messageTs,
          `\u{1F407} :x: Dispatch failed: ${errMsg}`,
          blocks,
        ).catch(() => {});
      }
    }
  }

  // ── updateDispatchMessage ─────────────────────────────────────────

  private async updateDispatchMessage(responseText: string): Promise<void> {
    if (!this.messageTs) return;
    await this.slack.queueUpdateMessage(
      this.channel,
      this.messageTs,
      `\u{1F407} ${responseText}`,
      buildDispatchBlocks(this.threadKey, responseText),
    );
  }

  // ── Idle timer ────────────────────────────────────────────────────

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.logger.info('DispatchHandler: idle timeout, stopping', { threadKey: this.threadKey });
      this.stop().catch((err) => {
        this.logger.warn('DispatchHandler: error during idle stop', { error: String(err) });
      });
    }, IDLE_TIMEOUT_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
