import crypto from 'crypto';
import type { App } from '@slack/bolt';
import type { WorkerConfig, RpcClient, PersistenceHealth, WorkerHealth } from '@buddy/shared';
import type { Logger } from './logger.js';
import type { GatewayConfig } from './config.js';
import type { SessionRegistry } from './session-registry.js';
import type { WorkerManager } from './worker-manager.js';

/** Gateway-handled commands — these are NOT routed to lite workers. */
const GATEWAY_COMMANDS = new Set(['!update', '!update all', '!update workers', '!update persistence', '!health', '!restart', '!restart persistence']);

export class SlackRouter {
  constructor(
    private app: App,
    private config: GatewayConfig,
    private registry: SessionRegistry,
    private workerManager: WorkerManager,
    private persistenceClient: RpcClient,
    private logger: Logger,
    private onRestart: (threadKey: string, channel: string, threadTs: string) => Promise<void>,
    private onRestartAll: (channel: string, threadTs: string) => Promise<void>,
    private onRestartFull: (threadKey: string, channel: string, threadTs: string) => Promise<void>,
    private onRestartPersistenceOnly: (channel: string, threadTs: string) => Promise<void>,
    private onRestartWorkers: (channel: string, threadTs: string) => Promise<void>,
    private onRestartPersistence: (channel: string, threadTs: string) => Promise<void>,
  ) {}

  /** Track recent app_mention event timestamps to deduplicate against message events */
  private recentMentionTs = new Set<string>();
  /** Track recently routed message timestamps to prevent double-enqueue from concurrent events */
  private recentlyRouted = new Set<string>();

  register(): void {
    // Handle @mentions
    this.app.event('app_mention', async ({ event, body, context }) => {
      // Record this message ts so the message handler skips it
      this.recentMentionTs.add(event.ts);
      setTimeout(() => this.recentMentionTs.delete(event.ts), 30_000);

      const threadTs = event.thread_ts || event.ts;
      const threadKey = `${event.channel}:${threadTs}`;
      const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
      const files = this.extractSlackFiles(event);
      const teamId = context.teamId ?? (body as any).team_id ?? (event as any).team;
      this.logger.info('app_mention team debug', { contextTeamId: context.teamId, bodyTeamId: (body as any).team_id, eventTeam: (event as any).team, resolved: teamId });

      if (text === '!update') {
        await this.onRestart(threadKey, event.channel, threadTs);
        return;
      }
      if (text === '!update all') {
        await this.onRestartAll(event.channel, threadTs);
        return;
      }
      if (text === '!update workers') {
        await this.onRestartWorkers(event.channel, threadTs);
        return;
      }
      if (text === '!update persistence') {
        await this.onRestartPersistence(event.channel, threadTs);
        return;
      }
      if (text === '!health') {
        await this.handleHealth(threadKey, event.channel, threadTs);
        return;
      }
      if (text === '!restart') {
        await this.onRestartFull(threadKey, event.channel, threadTs);
        return;
      }
      if (text === '!restart persistence') {
        await this.onRestartPersistenceOnly(event.channel, threadTs);
        return;
      }

      // Non-gateway !commands → route to lite worker via inbound-lite queue
      if (text.startsWith('!') && !GATEWAY_COMMANDS.has(text)) {
        await this.routeLiteCommand(threadKey, event.channel, event.ts, {
          id: crypto.randomUUID(),
          prompt: text,
          userId: event.user,
          teamId,
          timestamp: Date.now(),
          messageTs: event.ts,
        });
        return;
      }

      await this.routeMessage(threadKey, event.channel, event.ts, {
        id: crypto.randomUUID(),
        prompt: text,
        userId: event.user,
        teamId,
        timestamp: Date.now(),
        messageTs: event.ts,
        ...(files.length > 0 && { files }),
      });
    });

    // Handle direct messages and thread replies without @mention.
    // Skip @mentions — already handled by app_mention above.
    this.app.event('message', async ({ event, body, context }) => {
      if (event.subtype && event.subtype !== 'file_share') return;
      const files = this.extractSlackFiles(event);
      const text = ('text' in event && event.text) ? event.text : '';
      // Skip messages with no text AND no files
      if (!text && files.length === 0) return;
      // Deduplicate: skip if app_mention already routed this exact message
      if (this.recentMentionTs.has(event.ts)) return;
      // Skip messages that @mention the bot — app_mention handler will process these.
      // This is needed because Slack delivers `message` before `app_mention`,
      // so the timing-based recentMentionTs check above can miss.
      const botUserId = (context as any).botUserId;
      if (botUserId && text.includes(`<@${botUserId}>`)) return;

      const threadTs = (event as any).thread_ts || event.ts;
      const channel = event.channel;
      const threadKey = `${channel}:${threadTs}`;

      if (text === '!update') {
        await this.onRestart(threadKey, channel, threadTs);
        return;
      }
      if (text === '!update all') {
        await this.onRestartAll(channel, threadTs);
        return;
      }
      if (text === '!update workers') {
        await this.onRestartWorkers(channel, threadTs);
        return;
      }
      if (text === '!update persistence') {
        await this.onRestartPersistence(channel, threadTs);
        return;
      }
      if (text === '!health') {
        await this.handleHealth(threadKey, channel, threadTs);
        return;
      }
      if (text === '!restart') {
        await this.onRestartFull(threadKey, channel, threadTs);
        return;
      }
      if (text === '!restart persistence') {
        await this.onRestartPersistenceOnly(channel, threadTs);
        return;
      }

      // Non-gateway !commands → route to lite worker via inbound-lite queue
      if (text.startsWith('!') && !GATEWAY_COMMANDS.has(text)) {
        await this.routeLiteCommand(threadKey, channel, event.ts, {
          id: crypto.randomUUID(),
          prompt: text,
          userId: (event as any).user,
          teamId: context.teamId ?? (body as any).team_id ?? (event as any).team,
          timestamp: Date.now(),
          messageTs: event.ts,
        });
        return;
      }

      await this.routeMessage(threadKey, event.channel, event.ts, {
        id: crypto.randomUUID(),
        prompt: text,
        userId: (event as any).user,
        teamId: context.teamId ?? (body as any).team_id ?? (event as any).team,
        timestamp: Date.now(),
        messageTs: event.ts,
        ...(files.length > 0 && { files }),
      });
    });

    // Handle interactive actions (buttons, selects)
    this.app.action(/.*/, async ({ action, ack, body }) => {
      await ack();
      const actionId = (action as any).action_id || '';
      const responseUrl = (body as any).response_url;

      // ── Haiku actions → route to lite worker via inbound-lite queue ──

      if (actionId === 'haiku_done') {
        // Enqueue to inbound-lite so the lite worker can handle dispatch close
        const actionValue = action && typeof action === 'object' && 'value' in action
          ? (action as { value?: string }).value
          : undefined;
        const threadKey = typeof actionValue === 'string' ? actionValue : '';
        if (!threadKey.includes(':')) {
          this.logger.warn('haiku_done: missing or invalid threadKey in action value', { actionValue });
          return;
        }
        await this.enqueueToLite(threadKey, { action: 'haiku_done' });
        return;
      }

      if (actionId === 'haiku_reply') {
        // Text input dispatched on enter — route to lite worker
        const text = (action as any).value || '';
        const blockId: string = (action as any).block_id || '';
        const threadKey = blockId.replace(/^haiku_input:/, '');
        if (!text.trim() || !threadKey.includes(':')) {
          this.logger.warn('Haiku reply missing text or threadKey', { blockId, text });
          return;
        }
        await this.enqueueToLite(threadKey, {
          id: crypto.randomUUID(),
          prompt: text,
          userId: (body as any).user?.id,
          timestamp: Date.now(),
          responseUrl,
        });
        return;
      }

      if (actionId === 'haiku_send') {
        // "Send" button — extract input text and route to lite worker's LLM.
        // INTENTIONAL CHANGE: Previously routed to the main worker as a regular message.
        // Now goes to the lite worker. If the LLM decides it's unrelated to dispatch,
        // it can re-route to the main worker.
        const threadKey = (action as any).value || '';
        const stateValues = (body as any).state?.values || {};
        let text = '';
        // Find the haiku_reply input value from state.values
        for (const blockValues of Object.values(stateValues) as any[]) {
          if (blockValues?.haiku_reply?.value) {
            text = blockValues.haiku_reply.value;
            break;
          }
        }
        if (!text.trim() || !threadKey.includes(':')) {
          this.logger.warn('Haiku send missing text or threadKey', { threadKey, text });
          return;
        }
        await this.enqueueToLite(threadKey, {
          id: crypto.randomUUID(),
          prompt: text,
          action: 'haiku_send',
          userId: (body as any).user?.id,
          timestamp: Date.now(),
        });
        return;
      }

      // ── Generic callback-based actions (permissions, questions) ────
      // Action IDs may have a suffix (e.g., "_0" for question options, "_allow"/"_deny"/"_always" for permissions).
      let callbackId = actionId;
      let threadKey = this.registry.getThreadForCallback(callbackId);
      if (!threadKey) {
        const baseId = actionId.replace(/_(?:\d+|allow|always|deny|input(?:_\d+)?)$/, '');
        threadKey = this.registry.getThreadForCallback(baseId);
        if (threadKey) callbackId = baseId;
      }

      if (!threadKey) {
        this.logger.warn('No worker found for callback', { actionId });
        return;
      }

      // Delete the interactive prompt message now that the user has responded
      if (responseUrl) {
        fetch(responseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ delete_original: true }),
          signal: AbortSignal.timeout(10000),
        }).catch(() => {});
      }

      // Call worker's RPC server directly
      const workerClient = this.registry.getRpcClient(threadKey);
      if (workerClient) {
        workerClient.call('worker.interactiveResponse', {
          callbackId,
          action: (action as any).value || (action as any).selected_option?.value,
        }).catch(err => this.logger.error('Failed to forward interactive response', { error: (err as Error).message }));
      } else {
        this.logger.warn('No RPC client for worker', { threadKey, callbackId });
      }
    });

    this.logger.info('Slack router registered');
  }

  private async handleHealth(threadKey: string, channel: string, threadTs: string): Promise<void> {
    const lines: string[] = [];

    // ── Worker health ──
    const entry = this.registry.get(threadKey);
    if (entry) {
      const uptimeSec = Math.floor((Date.now() - entry.startedAt) / 1000);
      const heartbeatAgo = Math.floor((Date.now() - entry.lastHeartbeat) / 1000);
      lines.push(`*Worker (this thread)*`);
      lines.push(`  PID: ${entry.pid}  |  State: ${entry.state}  |  Uptime: ${formatDuration(uptimeSec)}`);
      lines.push(`  Last heartbeat: ${heartbeatAgo}s ago`);

      // Try pinging the worker for live status
      if (entry.rpcClient) {
        try {
          const wh = await entry.rpcClient.call('worker.health.ping', {}, 5_000) as WorkerHealth;
          lines.push(`  Last activity: ${Math.floor(wh.last_activity_sec)}s ago`);
          if (wh.execution) {
            const ex = wh.execution;
            lines.push(`  Model: ${ex.model}  |  Duration: ${formatDuration(ex.duration_sec)}`);
            lines.push(`  Tools: ${ex.tool_count}  |  Files changed: ${ex.files_changed}  |  Cost: $${ex.cost_usd.toFixed(4)}`);
            if (wh.awaiting_user_input) {
              lines.push(`  :raised_hand: *Awaiting user input*`);
            }
          }
        } catch {
          lines.push(`  _Worker unresponsive to ping_`);
        }
      }
    } else {
      lines.push(`*Worker (this thread)*\n  No worker running`);
    }

    // ── Lite worker health (this thread) ──
    const liteEntry = this.registry.get(threadKey, 'lite');
    if (liteEntry) {
      const uptimeSec = Math.floor((Date.now() - liteEntry.startedAt) / 1000);
      lines.push(`\n*Lite worker (this thread)*`);
      lines.push(`  PID: ${liteEntry.pid}  |  State: ${liteEntry.state}  |  Uptime: ${formatDuration(uptimeSec)}`);
    }

    // ── All workers summary ──
    const allEntries = this.registry.getAllEntries();
    const mainWorkers = allEntries.filter(e => e.type === 'worker');
    const liteWorkers = allEntries.filter(e => e.type === 'lite');
    lines.push(`\n*All workers:* ${mainWorkers.length} main, ${liteWorkers.length} lite`);
    for (const w of allEntries) {
      const up = Math.floor((Date.now() - w.startedAt) / 1000);
      const marker = w.threadKey === threadKey ? ' ← this thread' : '';
      const typeLabel = w.type === 'lite' ? ' [lite]' : '';
      lines.push(`  \`${w.threadKey}\`${typeLabel} pid=${w.pid} state=${w.state} up=${formatDuration(up)}${marker}`);
    }

    // ── Queue health ──
    try {
      const health = await this.persistenceClient.call('health.ping') as PersistenceHealth;
      const threadMetrics = health.queues.inbound.by_thread[threadKey];

      lines.push(`\n*Queue (this thread)*`);
      if (threadMetrics) {
        lines.push(`  Pending: ${threadMetrics.pending}  |  Delivered: ${threadMetrics.delivered}`);
        if (threadMetrics.oldest_unfinished_age_sec > 0) {
          lines.push(`  Oldest unfinished: ${Math.floor(threadMetrics.oldest_unfinished_age_sec)}s ago`);
        }
      } else {
        lines.push(`  No queued messages`);
      }

      lines.push(`\n*Queue (global)*`);
      lines.push(`  Inbound — pending: ${health.queues.inbound.total_pending}  |  delivered: ${health.queues.inbound.total_delivered}`);
      lines.push(`  Inbound-lite — pending: ${health.queues['inbound-lite'].total_pending}  |  delivered: ${health.queues['inbound-lite'].total_delivered}`);
      lines.push(`  Outbound — pending: ${health.queues.outbound.total_pending}  |  delivered: ${health.queues.outbound.total_delivered}`);
      lines.push(`\n*Persistence:* ${health.status}  |  Uptime: ${formatDuration(Math.floor(health.uptime))}`);
    } catch (err) {
      lines.push(`\n*Queue:* _persistence unreachable_ (${(err as Error).message})`);
    }

    await this.app.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: lines.join('\n'),
    });
  }

  private async routeMessage(threadKey: string, channel: string, eventTs: string, message: any): Promise<void> {
    // Deduplicate: skip if this exact Slack message was already routed
    // (guards against app_mention + message race condition and Slack retries)
    if (eventTs && this.recentlyRouted.has(eventTs)) return;
    if (eventTs) {
      this.recentlyRouted.add(eventTs);
      setTimeout(() => this.recentlyRouted.delete(eventTs), 30_000);
    }

    // Add reaction immediately so the user sees feedback
    // Use ⚡ for bot commands, ⏳ for regular messages
    const isBotCommand = typeof message.prompt === 'string' && message.prompt.startsWith('!');
    const reactionEmoji = isBotCommand ? 'zap' : 'hourglass_flowing_sand';
    if (eventTs) {
      try {
        await this.app.client.reactions.add({ channel, timestamp: eventTs, name: reactionEmoji });
      } catch {
        // Ignore — reaction may already exist or eventTs is empty
      }
    }

    // Enqueue via persistence service
    await this.persistenceClient.call('queue.enqueue', {
      queue: 'inbound',
      threadKey,
      message,
    });

    // Spawn worker if not already running
    // No pushPendingMessages — persistence notifies the worker directly
    if (!this.registry.has(threadKey)) {
      const workerConfig = this.buildWorkerConfig();
      this.workerManager.spawn(threadKey, workerConfig);
    }
  }

  /**
   * Route a non-gateway !command to the lite worker via the inbound-lite queue.
   * Also spawns the main worker if not running (lite worker needs it as an RPC target).
   */
  private async routeLiteCommand(threadKey: string, channel: string, eventTs: string, message: any): Promise<void> {
    // Deduplicate
    if (eventTs && this.recentlyRouted.has(eventTs)) return;
    if (eventTs) {
      this.recentlyRouted.add(eventTs);
      setTimeout(() => this.recentlyRouted.delete(eventTs), 30_000);
    }

    // Add ⚡ reaction for commands
    if (eventTs) {
      try {
        await this.app.client.reactions.add({ channel, timestamp: eventTs, name: 'zap' });
      } catch {
        // Ignore
      }
    }

    // Enqueue to inbound-lite queue
    await this.persistenceClient.call('queue.enqueue', {
      queue: 'inbound-lite',
      threadKey,
      message,
    });

    // Spawn main worker if not running (lite worker needs it as an RPC target)
    if (!this.registry.has(threadKey)) {
      const workerConfig = this.buildWorkerConfig();
      this.workerManager.spawn(threadKey, workerConfig);
    }

    // Spawn lite worker if not running
    if (!this.registry.has(threadKey, 'lite')) {
      const workerConfig = this.buildWorkerConfig();
      this.workerManager.spawnLite(threadKey, 'dispatch', workerConfig);
    }
  }

  /**
   * Enqueue a payload to the inbound-lite queue for a thread.
   * Spawns main worker and lite worker as needed.
   */
  private async enqueueToLite(threadKey: string, payload: Record<string, unknown>): Promise<void> {
    await this.persistenceClient.call('queue.enqueue', {
      queue: 'inbound-lite',
      threadKey,
      message: payload,
    });

    // Spawn main worker if not running (lite worker needs it as an RPC target)
    if (!this.registry.has(threadKey)) {
      const workerConfig = this.buildWorkerConfig();
      this.workerManager.spawn(threadKey, workerConfig);
    }

    // Spawn lite worker if not running
    if (!this.registry.has(threadKey, 'lite')) {
      const workerConfig = this.buildWorkerConfig();
      this.workerManager.spawnLite(threadKey, 'dispatch', workerConfig);
    }
  }

  /** Extract file metadata from a Slack event's files array. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractSlackFiles(event: any): Array<{ id: string; url: string; name: string; size: number }> {
    const files = event.files as Array<Record<string, unknown>> | undefined;
    if (!files) return [];
    return files
      .filter((f) => f.id)
      .map((f) => ({
        id: String(f.id ?? ''),
        url: String(f.url_private ?? ''),
        name: String(f.name ?? 'file'),
        size: Number(f.size ?? 0),
      }));
  }

  private buildWorkerConfig(): WorkerConfig {
    return {
      model: this.config.defaultModel,
      permissionMode: this.config.defaultPermissionMode,
      mcpServers: this.config.mcpServers,
    };
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}
