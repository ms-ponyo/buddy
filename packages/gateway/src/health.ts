import type { App } from '@slack/bolt';
import type { RpcClient, PersistenceHealth, WorkerHealth, WorkerConfig } from '@buddy/shared';
import type { Logger } from './logger.js';
import type { SessionRegistry } from './session-registry.js';
import type { WorkerManager } from './worker-manager.js';
import type { GatewayConfig } from './config.js';

const MAX_HEALTH_RESTARTS = 5;

export class HealthMonitor {
  private healthInterval: NodeJS.Timeout | null = null;
  private healthRestartCount = new Map<string, number>();

  constructor(
    private app: App,
    private persistenceClient: RpcClient,
    private registry: SessionRegistry,
    private workerManager: WorkerManager,
    private logger: Logger,
    private config: GatewayConfig,
  ) {}

  start(): void {
    this.healthInterval = setInterval(() => this.checkHealth(), 30_000);
    this.logger.info('Health monitor started');
  }

  stop(): void {
    if (this.healthInterval) clearInterval(this.healthInterval);
    this.healthInterval = null;
    this.logger.info('Health monitor stopped');
  }

  private async checkHealth(): Promise<void> {
    try {
      // 1. Get queue health from persistence
      const health = await this.persistenceClient.call('health.ping') as PersistenceHealth;

      // 2. Single pass: ping every registered worker/lite worker
      for (const entry of this.registry.getAllEntries()) {
        if (entry.type === 'lite') {
          try {
            await entry.rpcClient?.call('lite.health.ping', {}, 10_000);
            entry.lastHeartbeat = Date.now();
          } catch {
            this.logger.error(`Lite worker ${entry.threadKey} unresponsive to health ping, killing`);
            this.workerManager.killLite(entry.threadKey);
          }
          continue;
        }

        // Main worker
        const threadMetrics = health.queues.inbound.by_thread[entry.threadKey];
        const unfinished = threadMetrics ? threadMetrics.pending + threadMetrics.delivered : 0;

        try {
          const workerHealth = await entry.rpcClient?.call('worker.health.ping', {}, 10_000) as WorkerHealth;
          entry.lastHeartbeat = Date.now();

          // Stuck: has unfinished messages, no SDK activity for 5+ min, and not awaiting user input.
          // Use a longer threshold (20 min) when a tool is actively executing (e.g. long bash builds).
          const stuckThreshold = workerHealth.active_tool ? 1200 : 300;
          if (
            unfinished > 0 &&
            workerHealth.last_activity_sec > stuckThreshold &&
            !workerHealth.awaiting_user_input
          ) {
            this.logger.warn(`Worker ${entry.threadKey} stuck: no activity for ${workerHealth.last_activity_sec}s with ${unfinished} unfinished messages (active_tool=${workerHealth.active_tool})`);
            await this.handleUnresponsiveWorker(entry.threadKey, `stuck for ${workerHealth.last_activity_sec}s with ${unfinished} unfinished messages`);
          } else {
            this.healthRestartCount.delete(entry.threadKey);
          }
        } catch {
          this.logger.error(`Worker ${entry.threadKey} unresponsive to health ping`);
          await this.handleUnresponsiveWorker(entry.threadKey);
        }
      }

      // 3. Log stale threads with no registered worker (orphaned queue entries)
      for (const [threadKey, metrics] of Object.entries(health.queues.inbound.by_thread)) {
        if (metrics.oldest_unfinished_age_sec > 300 && !this.registry.get(threadKey)) {
          this.logger.info('Health: stale thread has no registered worker', {
            threadKey, ageSec: metrics.oldest_unfinished_age_sec,
            pending: metrics.pending, delivered: metrics.delivered,
          });
        }
      }
    } catch (err) {
      this.logger.error('Health check failed', { error: String(err) });
    }
  }

  private async handleUnresponsiveWorker(threadKey: string, reason?: string): Promise<void> {
    const count = this.healthRestartCount.get(threadKey) ?? 0;
    await this.workerManager.kill(threadKey);
    const [channel, threadTs] = threadKey.split(':');

    // Reset delivered messages back to pending so the new worker can pick them up.
    // The kill above is "expected" (registry removed first), so the onWorkerExit
    // handler won't do this — we must do it here.
    try {
      await this.persistenceClient.call('queue.resetForThread', { threadKey, queue: 'inbound' });
    } catch (err) {
      this.logger.warn('Failed to reset delivered messages after health kill', { threadKey, error: String(err) });
    }

    if (count < MAX_HEALTH_RESTARTS) {
      this.healthRestartCount.set(threadKey, count + 1);
      const workerConfig: WorkerConfig = {
        model: this.config.defaultModel,
        permissionMode: this.config.defaultPermissionMode,
        mcpServers: this.config.mcpServers,
        anthropicApiKey: this.config.anthropicApiKey,
      };
      this.workerManager.spawn(threadKey, workerConfig);
      const detail = reason ? `Worker was killed: ${reason}.` : 'Worker became unresponsive.';
      this.app.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `${detail} Auto-restarting (attempt ${count + 1}/${MAX_HEALTH_RESTARTS})...`,
      }).catch(() => {});
    } else {
      this.healthRestartCount.delete(threadKey);
      const detail = reason ? `Worker was killed: ${reason}.` : 'Worker became unresponsive.';
      this.app.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `${detail} Max restart attempts (${MAX_HEALTH_RESTARTS}) reached. Send a new message to restart.`,
      }).catch(() => {});
    }
  }
}
