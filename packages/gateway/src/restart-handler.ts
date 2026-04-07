import type { App } from '@slack/bolt';
import type { Logger } from './logger.js';
import type { WorkerManager } from './worker-manager.js';

export class RestartHandler {
  constructor(
    private app: App,
    private workerManager: WorkerManager,
    private logger: Logger,
    private onRestart?: (threadKey: string) => void,
  ) {}

  private async postMessage(channel: string, threadTs: string, text: string): Promise<void> {
    await this.app.client.chat.postMessage({ channel, thread_ts: threadTs, text });
  }

  /** !update — update repo, rebuild worker, restart current worker */
  async restartThread(threadKey: string, channel: string, threadTs: string): Promise<void> {
    this.logger.info('!update: updating repo and restarting worker', { threadKey });
    await this.postMessage(channel, threadTs, 'Updating repository...');

    const update = await this.workerManager.updateRepo();
    if (!update.success) {
      await this.postMessage(channel, threadTs, `Repository update failed:\n\`\`\`\n${update.output.slice(0, 2000)}\n\`\`\``);
      return;
    }

    this.workerManager.kill(threadKey);
    this.onRestart?.(threadKey);

    const build = await this.workerManager.rebuild();
    if (build.success) {
      await this.postMessage(channel, threadTs, 'Updated and restarted — send a new message to continue.');
    } else {
      await this.postMessage(channel, threadTs, `Build failed:\n\`\`\`\n${build.output.slice(0, 2000)}\n\`\`\``);
    }
  }

  /** !restart — kill current worker (no rebuild) */
  async restart(threadKey: string, channel: string, threadTs: string): Promise<void> {
    this.logger.info('!restart: killing worker', { threadKey });
    this.workerManager.kill(threadKey);
    this.onRestart?.(threadKey);
    await this.postMessage(channel, threadTs, 'Worker restarted — send a new message to continue.');
  }

  /** !restart persistence — kill persistence (no rebuild, gateway auto-respawns it) */
  async restartPersistenceOnly(channel: string, threadTs: string): Promise<void> {
    this.logger.info('!restart persistence: killing persistence');
    await this.workerManager.killPersistence();
    await this.postMessage(channel, threadTs, 'Persistence restarted.');
  }

  /** !update all — update repo, rebuild everything, restart gateway + persistence + workers */
  async restartAll(channel: string, threadTs: string): Promise<void> {
    this.logger.info('!update all: updating repo and restarting everything');
    await this.postMessage(channel, threadTs, 'Updating repository...');

    const update = await this.workerManager.updateRepo();
    if (!update.success) {
      await this.postMessage(channel, threadTs, `Repository update failed:\n\`\`\`\n${update.output.slice(0, 2000)}\n\`\`\``);
      return;
    }

    const build = await this.workerManager.rebuildEverything();
    if (!build.success) {
      await this.postMessage(channel, threadTs, `Build failed:\n\`\`\`\n${build.output.slice(0, 2000)}\n\`\`\``);
      return;
    }

    await this.postMessage(channel, threadTs, 'Updated — restarting gateway...');

    this.workerManager.killAll();
    await this.workerManager.killPersistence();

    // Exit the gateway process — supervisor will restart it with updated code
    setTimeout(() => process.exit(0), 1000);
  }

  /** !update workers — update repo, rebuild worker, restart all workers */
  async restartWorkers(channel: string, threadTs: string): Promise<void> {
    this.logger.info('!update workers: updating repo and restarting all workers');
    await this.postMessage(channel, threadTs, 'Updating repository...');

    const update = await this.workerManager.updateRepo();
    if (!update.success) {
      await this.postMessage(channel, threadTs, `Repository update failed:\n\`\`\`\n${update.output.slice(0, 2000)}\n\`\`\``);
      return;
    }

    const affectedThreads = this.workerManager.killAll();

    const build = await this.workerManager.rebuild();
    if (build.success) {
      await this.postMessage(channel, threadTs, `Updated and restarted ${affectedThreads.length} workers — send a new message in any thread to continue.`);

      for (const tk of affectedThreads) {
        const [ch, ts] = tk.split(':');
        if (ch === channel && ts === threadTs) continue;
        try {
          await this.postMessage(ch, ts, 'Session restarted — send a new message to continue.');
        } catch {
          // Thread may be archived or inaccessible
        }
      }
    } else {
      await this.postMessage(channel, threadTs, `Build failed:\n\`\`\`\n${build.output.slice(0, 2000)}\n\`\`\``);
    }
  }

  /** !update persistence — update repo, rebuild persistence, restart persistence */
  async restartPersistence(channel: string, threadTs: string): Promise<void> {
    this.logger.info('!update persistence: updating repo and restarting persistence');
    await this.postMessage(channel, threadTs, 'Updating repository...');

    const update = await this.workerManager.updateRepo();
    if (!update.success) {
      await this.postMessage(channel, threadTs, `Repository update failed:\n\`\`\`\n${update.output.slice(0, 2000)}\n\`\`\``);
      return;
    }

    await this.workerManager.killPersistence();

    const build = await this.workerManager.rebuildPersistence();
    if (build.success) {
      await this.postMessage(channel, threadTs, 'Persistence updated and restarted.');
    } else {
      await this.postMessage(channel, threadTs, `Build failed:\n\`\`\`\n${build.output.slice(0, 2000)}\n\`\`\``);
    }
  }
}
