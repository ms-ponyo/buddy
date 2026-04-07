// src/orchestration/message-handler.ts — Routes inbound queue messages to the right handler.
// Thin routing layer: pulls from persistence, checks message type, delegates, acks/nacks.

import type { QueueMessage } from '@buddy/shared';
import type { Logger } from '../logger.js';
import type { BuddyConfig } from '../types.js';
import type { PersistenceAdapter } from '../adapters/persistence-adapter.js';
import type { SlackAdapter } from '../adapters/slack-adapter.js';

// ── WorkerLoop interface ──────────────────────────────────────────────
// The full WorkerLoop will be implemented separately; we depend on this minimal interface.

export interface WorkerLoop {
  handleMessage(msg: QueueMessage, onResponsePosted?: () => Promise<void>): Promise<void>;
  interrupt(): void;
}

// ── Constructor deps ──────────────────────────────────────────────────

export interface MessageHandlerDeps {
  workerLoop: WorkerLoop;
  persistence: PersistenceAdapter;
  slack: SlackAdapter;
  config: BuddyConfig;
  logger: Logger;
  threadKey: string;
}

// ── MessageHandler ────────────────────────────────────────────────────

/**
 * Routes inbound QueueMessages to the WorkerLoop.
 *
 * All routing of !commands and dispatch messages is now handled by the
 * separate Lite Worker process. The main worker only handles regular messages.
 *
 * Each message is ack'd on success or nack'd on failure.
 */
export class MessageHandler {
  private readonly workerLoop: WorkerLoop;
  private readonly persistence: PersistenceAdapter;
  private readonly slack: SlackAdapter;
  private readonly config: BuddyConfig;
  private readonly logger: Logger;
  private readonly threadKey: string;

  constructor(deps: MessageHandlerDeps) {
    this.workerLoop = deps.workerLoop;
    this.persistence = deps.persistence;
    this.slack = deps.slack;
    this.config = deps.config;
    this.logger = deps.logger;
    this.threadKey = deps.threadKey;
  }

  // ── handleInbound ────────────────────────────────────────────────

  /**
   * Process a batch of inbound queue messages.
   * Each message is routed, then ack'd (success) or nack'd (failure).
   * Processing continues even if individual messages fail.
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
      await this.persistence.ack('inbound', msg.id);
    };

    try {
      this.logger.debug('Routing to worker loop', { id: msg.id, threadKey: this.threadKey });
      await this.workerLoop.handleMessage(msg, ackOnce);
      // Ack here for cases where handleMessage returns without calling ackOnce
      // (e.g. if the worker loop bails early without posting a response).
      await ackOnce();
    } catch (err) {
      this.logger.error('Failed to process inbound message', {
        id: msg.id,
        threadKey: this.threadKey,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!acked) {
        await this.persistence.nack('inbound', msg.id);
      }
    }
  }
}
