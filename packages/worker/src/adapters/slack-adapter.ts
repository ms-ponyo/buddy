// src/adapters/slack-adapter.ts — Wraps all Slack API calls via RPC to gateway/persistence.
// Replaces the module-level singleton in src/slack-proxy.ts with a proper class.

import type { RpcClient, StreamMessage } from '@buddy/shared';

// ── Types re-exported for consumers ────────────────────────────────

export interface SlackFileInfo {
  name?: string;
  size?: number;
  url_private_download?: string;
  url_private?: string;
}

export interface SlackMessage {
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
}

// ── SlackAdapter ───────────────────────────────────────────────────

/**
 * Wraps all Slack communication, proxying through RPC to the gateway
 * and persistence processes.
 *
 * Two-stage posting pattern:
 * - postMessage / uploadFile / sendInteractivePrompt -> persistence outbound queue
 *   (returns placeholder; actual ts comes from gateway processing the queue)
 * - updateMessage / addReaction / removeReaction / setTypingStatus etc. -> direct gateway call
 */
export class SlackAdapter {
  constructor(
    private readonly gatewayClient: RpcClient,
    private readonly persistenceClient: RpcClient,
    private readonly threadKey: string,
  ) {}

  // ── Persistence outbound queue methods ─────────────────────────

  async postMessage(
    channel: string,
    threadTs: string,
    text: string,
    blocks?: unknown[],
  ): Promise<{ ts: string }> {
    await this.persistenceClient.call('queue.enqueue', {
      queue: 'outbound',
      threadKey: this.threadKey,
      message: { type: 'postMessage', channel, thread_ts: threadTs, text, blocks },
    });
    return { ts: '' };
  }

  async appendToLastMessage(
    channel: string,
    threadTs: string,
    text: string,
    blocks?: unknown[],
  ): Promise<void> {
    await this.persistenceClient.call('queue.enqueue', {
      queue: 'outbound',
      threadKey: this.threadKey,
      message: { type: 'appendToLastMessage', channel, thread_ts: threadTs, text, blocks },
    });
  }

  async uploadFile(
    channel: string,
    threadTs: string,
    filename: string,
    filePath: string,
    caption?: string,
  ): Promise<{ fileId: string }> {
    const message: Record<string, unknown> = {
      type: 'fileUpload',
      channel_id: channel,
      thread_ts: threadTs,
      filename,
      file_path: filePath,
    };
    if (caption) message.initial_comment = caption;

    await this.persistenceClient.call('queue.enqueue', {
      queue: 'outbound',
      threadKey: this.threadKey,
      message,
    });
    return { fileId: '' };
  }

  async sendInteractivePrompt(
    callbackId: string,
    promptType: 'permission' | 'question' | 'terminal',
    display: unknown,
  ): Promise<void> {
    await this.persistenceClient.call('queue.enqueue', {
      queue: 'outbound',
      threadKey: this.threadKey,
      message: { type: 'interactivePrompt', callbackId, promptType, display },
    });
  }

  async registerCallback(callbackId: string): Promise<void> {
    await this.gatewayClient.call('slack.registerCallback', {
      callbackId,
      threadKey: this.threadKey,
    });
  }

  async postMessageDirect(
    channel: string,
    threadTs: string,
    text: string,
    blocks?: unknown[],
  ): Promise<{ ts: string }> {
    const { result } = await this.gatewayClient.call('slack.apiCall', {
      method: 'chat.postMessage',
      args: { channel, thread_ts: threadTs, text, blocks },
    }) as { result: { ts?: string } };
    return { ts: result?.ts ?? '' };
  }

  async queueUpdateMessage(
    channel: string,
    ts: string,
    text: string,
    blocks?: unknown[],
  ): Promise<void> {
    await this.persistenceClient.call('queue.enqueue', {
      queue: 'outbound',
      threadKey: this.threadKey,
      message: { type: 'updateMessage', channel, ts, text, blocks },
    });
  }

  async queueDeleteMessage(channel: string, ts: string): Promise<void> {
    await this.persistenceClient.call('queue.enqueue', {
      queue: 'outbound',
      threadKey: this.threadKey,
      message: { type: 'deleteMessage', channel, ts },
    });
  }

  async enqueueOutbound(message: StreamMessage): Promise<void> {
    await this.persistenceClient.call('queue.enqueue', {
      queue: 'outbound',
      threadKey: this.threadKey,
      message: message as unknown as Record<string, unknown>,
    });
  }

  // ── Direct gateway methods ─────────────────────────────────────

  async apiCall(method: string, args: Record<string, unknown>): Promise<any> {
    const { result } = await this.gatewayClient.call('slack.apiCall', { method, args }) as { result: unknown };
    return result;
  }

  async deleteMessage(channel: string, ts: string): Promise<void> {
    await this.gatewayClient.call('slack.apiCall', {
      method: 'chat.delete',
      args: { channel, ts },
    });
  }

  async updateMessage(channel: string, ts: string, text: string, blocks?: unknown[]): Promise<void> {
    await this.gatewayClient.call('slack.apiCall', {
      method: 'chat.update',
      args: { channel, ts, text, blocks },
    });
  }

  async postEphemeral(
    channel: string,
    threadTs: string,
    user: string,
    text: string,
    blocks?: unknown[],
  ): Promise<void> {
    await this.gatewayClient.call('slack.apiCall', {
      method: 'chat.postEphemeral',
      args: { channel, thread_ts: threadTs, user, text, blocks },
    });
  }

  async addReaction(channel: string, ts: string, emoji: string): Promise<void> {
    await this.gatewayClient.call('slack.apiCall', {
      method: 'reactions.add',
      args: { channel, timestamp: ts, name: emoji },
    });
  }

  async removeReaction(channel: string, ts: string, emoji: string): Promise<void> {
    await this.gatewayClient.call('slack.apiCall', {
      method: 'reactions.remove',
      args: { channel, timestamp: ts, name: emoji },
    });
  }

  async setTypingStatus(channel: string, threadTs: string, status: string): Promise<void> {
    await this.gatewayClient.call('slack.apiCall', {
      method: 'assistant.threads.setStatus',
      args: { channel_id: channel, thread_ts: threadTs, status },
    });
  }

  async openView(triggerId: string, view: unknown): Promise<{ viewId: string }> {
    const { result } = await this.gatewayClient.call('slack.apiCall', {
      method: 'views.open',
      args: { trigger_id: triggerId, view },
    }) as { result: any };
    return { viewId: result?.view?.id || '' };
  }

  async updateView(viewId: string, view: unknown): Promise<void> {
    await this.gatewayClient.call('slack.apiCall', {
      method: 'views.update',
      args: { view_id: viewId, view },
    });
  }

  async conversationsReplies(args: {
    channel: string;
    ts: string;
    limit?: number;
    cursor?: string;
    latest?: string;
    oldest?: string;
    inclusive?: boolean;
  }): Promise<{
    messages?: SlackMessage[];
    response_metadata?: { next_cursor?: string };
  }> {
    const { result } = await this.gatewayClient.call('slack.apiCall', {
      method: 'conversations.replies',
      args,
    }) as { result: any };
    return result;
  }

  async conversationsHistory(args: {
    channel: string;
    limit?: number;
    oldest?: string;
  }): Promise<{
    messages?: SlackMessage[];
  }> {
    const { result } = await this.gatewayClient.call('slack.apiCall', {
      method: 'conversations.history',
      args,
    }) as { result: any };
    return result;
  }

  async filesInfo(args: { file: string }): Promise<{
    file?: SlackFileInfo;
  }> {
    const { result } = await this.gatewayClient.call('slack.apiCall', {
      method: 'files.info',
      args,
    }) as { result: any };
    return result;
  }

  async searchMessages(args: {
    query: string;
    sort?: string;
    sort_dir?: string;
    count?: number;
    page?: number;
  }): Promise<{
    messages?: { total: number; matches: any[] };
  }> {
    const { result } = await this.gatewayClient.call('slack.apiCall', {
      method: 'search.messages',
      args,
    }) as { result: any };
    return result;
  }

  // ── Connection management ──────────────────────────────────────

  async connectGateway(): Promise<void> {
    await this.gatewayClient.connect();
  }

  async deregisterFromGateway(): Promise<void> {
    await this.gatewayClient.call('worker.deregister', {});
  }

  async close(): Promise<void> {
    await this.gatewayClient.close();
    await this.persistenceClient.close();
  }

  isGatewayConnected(): boolean {
    return this.gatewayClient.isConnected;
  }

  isPersistenceConnected(): boolean {
    return this.persistenceClient.isConnected;
  }
}
