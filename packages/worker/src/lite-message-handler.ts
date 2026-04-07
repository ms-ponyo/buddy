// src/lite-message-handler.ts — Routes inbound messages from the inbound-lite queue.
// The lite worker equivalent of MessageHandler, but simpler:
//   1. haiku_done action → call onShutdown callback
//   2. Parse as !command → execute via BotCommandRouter
//      → success (handled) → post result to thread → done
//      → failure or dispatch → feed command + error to DispatchHandler
//   3. If dispatch input box text → feed to DispatchHandler
//   4. Anything else → feed to DispatchHandler

import type { QueueMessage } from '@buddy/shared';
import type { Logger } from './logger.js';
import type { BuddyConfig } from './types.js';
import type { PersistenceAdapter } from './adapters/persistence-adapter.js';
import type { SlackAdapter } from './adapters/slack-adapter.js';
import type { BotCommandRouter } from './services/bot-command-router.js';
import type { DispatchHandler } from './handlers/dispatch-handler.js';
// ── Constructor deps ────────────────────────────────────────────────

export interface LiteMessageHandlerDeps {
  botCommandRouter: BotCommandRouter;
  dispatchHandler: DispatchHandler;
  persistence: PersistenceAdapter;
  slack: SlackAdapter;
  config: BuddyConfig;
  logger: Logger;
  channel: string;
  threadTs: string;
  onShutdown: () => void;
}

// ── LiteMessageHandler ──────────────────────────────────────────────

export class LiteMessageHandler {
  private readonly botCommandRouter: BotCommandRouter;
  private readonly dispatchHandler: DispatchHandler;
  private readonly persistence: PersistenceAdapter;
  private readonly slack: SlackAdapter;
  private readonly config: BuddyConfig;
  private readonly logger: Logger;
  private readonly channel: string;
  private readonly threadTs: string;
  private readonly onShutdown: () => void;

  constructor(deps: LiteMessageHandlerDeps) {
    this.botCommandRouter = deps.botCommandRouter;
    this.dispatchHandler = deps.dispatchHandler;
    this.persistence = deps.persistence;
    this.slack = deps.slack;
    this.config = deps.config;
    this.logger = deps.logger;
    this.channel = deps.channel;
    this.threadTs = deps.threadTs;
    this.onShutdown = deps.onShutdown;
  }

  // ── handleInbound ────────────────────────────────────────────────

  /**
   * Process a batch of inbound-lite queue messages.
   * Each message is routed, then ack'd (success) or nack'd (failure).
   */
  async handleInbound(messages: QueueMessage[]): Promise<void> {
    for (const msg of messages) {
      await this.processOne(msg);
    }
  }

  // ── processOne ───────────────────────────────────────────────────

  private async processOne(msg: QueueMessage): Promise<void> {
    let acked = false;
    const ackOnce = async () => {
      if (acked) return;
      acked = true;
      await this.persistence.ack('inbound-lite', msg.id);
    };

    try {
      await this.route(msg);
      await ackOnce();
    } catch (err) {
      this.logger.error('LiteMessageHandler: failed to process message', {
        id: msg.id,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!acked) {
        await this.persistence.nack('inbound-lite', msg.id);
      }
    }
  }

  // ── route ────────────────────────────────────────────────────────

  private async route(msg: QueueMessage): Promise<void> {
    const payload = msg.payload;
    const action = typeof payload.action === 'string' ? payload.action : undefined;
    const prompt = typeof payload.prompt === 'string' ? payload.prompt : undefined;
    const text = typeof payload.text === 'string' ? payload.text : undefined;

    // 1. haiku_done action → shut down the lite worker
    if (action === 'haiku_done') {
      this.logger.info('LiteMessageHandler: haiku_done received, shutting down');
      this.onShutdown();
      return;
    }

    // 2. Dispatch input box text → feed to DispatchHandler
    if (text) {
      this.logger.debug('LiteMessageHandler: dispatch input box text', { text });
      await this.dispatchHandler.feed(text);
      return;
    }

    // 3. Parse as !command
    if (prompt) {
      const parsed = this.botCommandRouter.parse(prompt);
      if (parsed) {
        // SDK slash commands → forward to main worker as /command
        if (this.botCommandRouter.isSDKSlashCommand(parsed.command)) {
          const slashCommand = this.botCommandRouter.rewriteSlashCommand(prompt);
          this.logger.info('LiteMessageHandler: forwarding SDK slash command to main worker', {
            command: parsed.command,
            rewritten: slashCommand,
          });
          const threadKey = `${this.channel}:${this.threadTs}`;
          await this.persistence.enqueue('inbound', threadKey, { prompt: slashCommand });
          return;
        }

        // Registered bot command → execute locally
        if (this.botCommandRouter.hasCommand(parsed.command)) {
          this.logger.debug('LiteMessageHandler: bot command', { command: parsed.command });
          try {
            const result = await this.botCommandRouter.execute(parsed);

            if (result.type === 'handled') {
              if (result.reply) {
                await this.slack.postMessage(
                  this.channel,
                  this.threadTs,
                  result.reply,
                  [{ type: 'markdown', text: result.reply }],
                ).catch((err) => {
                  this.logger.warn('LiteMessageHandler: failed to post command reply', { error: String(err) });
                });
              }
              return;
            }

            // type === 'forward' → enqueue as user prompt to main worker
            if (result.type === 'forward') {
              const threadKey = `${this.channel}:${this.threadTs}`;
              this.logger.info('LiteMessageHandler: forwarding command to main worker', {
                command: parsed.command,
              });
              await this.persistence.enqueue('inbound', threadKey, { prompt: result.reply ?? prompt });
              return;
            }

            // type === 'dispatch' → feed to DispatchHandler
            await this.dispatchHandler.feed(result.reply ?? prompt);
            return;
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.logger.warn('LiteMessageHandler: bot command failed, dispatching', {
              command: parsed.command,
              error: errMsg,
            });
            await this.dispatchHandler.feed(
              `!${parsed.command} ${parsed.args}\n\nCommand failed: ${errMsg}. Please help the user.`,
            );
            return;
          }
        }

        // Unknown command → let Haiku provide a helpful response
        this.logger.debug('LiteMessageHandler: unknown command, dispatching to Haiku', {
          command: parsed.command,
        });
        await this.dispatchHandler.feed(prompt);
        return;
      }

      // Not a command → feed prompt to DispatchHandler
      await this.dispatchHandler.feed(prompt);
      return;
    }

    // Fallback: nothing meaningful in the payload
    this.logger.debug('LiteMessageHandler: ignoring message with no actionable payload', {
      id: msg.id,
    });
  }
}
