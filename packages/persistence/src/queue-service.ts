// packages/persistence/src/queue-service.ts
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { QueueMessage, QueueName, QueueStatus } from '@buddy/shared';
import { CONFIG } from './config.js';

export class QueueService {
  private stmts: ReturnType<typeof this.prepareStatements>;

  constructor(private db: Database.Database) {
    this.stmts = this.prepareStatements();
  }

  enqueue(queue: QueueName, threadKey: string, payload: Record<string, unknown>): { id: string } {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.stmts.insert.run(id, queue, threadKey, 'pending', JSON.stringify(payload), 0, null, now, now);
    return { id };
  }

  nextPending(queue: QueueName, threadKey: string): QueueMessage | null {
    const row = this.stmts.selectPendingOne.get(queue, threadKey) as DbRow | undefined;
    return row ? rowToQueueMessage(row) : null;
  }

  nextPendingAny(queue: QueueName): QueueMessage | null {
    const row = this.stmts.selectPendingAny.get(queue) as DbRow | undefined;
    return row ? rowToQueueMessage(row) : null;
  }

  markDelivered(id: string): void {
    const now = new Date().toISOString();
    this.stmts.updateStatus.run('delivered', now, id);
  }

  ack(queue: QueueName, id: string): void {
    const now = new Date().toISOString();
    this.stmts.updateStatus.run('completed', now, id);
  }

  nack(queue: QueueName, id: string): string | null {
    const now = new Date().toISOString();
    const row = this.stmts.selectById.get(id) as DbRow | undefined;
    if (!row) return null;

    const newRetryCount = row.retry_count + 1;
    if (newRetryCount >= CONFIG.MAX_RETRIES) {
      this.stmts.deadletter.run('deadlettered', `Exceeded max retries (${CONFIG.MAX_RETRIES})`, newRetryCount, now, id);
      return null; // deadlettered, no retry
    } else {
      this.stmts.retry.run('pending', newRetryCount, now, id);
      return row.thread_key; // retryable, notify worker
    }
  }

  deadletter(queue: QueueName, id: string, reason: string): void {
    const now = new Date().toISOString();
    this.stmts.deadletterDirect.run('deadlettered', reason, now, id);
  }

  resetForThread(threadKey: string, queue?: QueueName): void {
    // Called on subscriber crash: reset delivered → pending
    // If queue is specified, only reset messages in that queue (for targeted recovery)
    // If not specified, reset all queues (backward compat)
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const rows = (queue
        ? this.stmts.selectActiveForThreadAndQueue.all(threadKey, queue)
        : this.stmts.selectActiveForThread.all(threadKey)) as DbRow[];
      for (const row of rows) {
        const newRetryCount = row.retry_count + 1;
        if (newRetryCount >= CONFIG.MAX_RETRIES) {
          this.stmts.deadletter.run('deadlettered', 'Worker crashed, exceeded max retries', newRetryCount, now, row.id);
        } else {
          this.stmts.retry.run('pending', newRetryCount, now, row.id);
        }
      }
    })();
  }

  resetForQueue(queue: QueueName): void {
    // Called when a wildcard subscriber (e.g. gateway on outbound) disconnects:
    // reset ALL delivered messages for the queue back to pending.
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const rows = this.stmts.selectActiveForQueue.all(queue) as DbRow[];
      for (const row of rows) {
        const newRetryCount = row.retry_count + 1;
        if (newRetryCount >= CONFIG.MAX_RETRIES) {
          this.stmts.deadletter.run('deadlettered', 'Subscriber disconnected, exceeded max retries', newRetryCount, now, row.id);
        } else {
          this.stmts.retry.run('pending', newRetryCount, now, row.id);
        }
      }
    })();
  }

  prune(): number {
    const cutoff = new Date(Date.now() - CONFIG.PRUNE_AGE_MS).toISOString();
    const result = this.stmts.prune.run(cutoff);
    return result.changes;
  }

  private prepareStatements() {
    return {
      insert: this.db.prepare(
        `INSERT INTO queue_messages (id, queue, thread_key, status, payload, retry_count, reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ),
      selectPendingOne: this.db.prepare(
        `SELECT * FROM queue_messages WHERE queue = ? AND thread_key = ? AND status = 'pending'
         ORDER BY created_at ASC LIMIT 1`
      ),
      selectPendingAny: this.db.prepare(
        `SELECT * FROM queue_messages WHERE queue = ? AND status = 'pending'
         ORDER BY created_at ASC LIMIT 1`
      ),
      selectById: this.db.prepare(
        `SELECT * FROM queue_messages WHERE id = ?`
      ),
      selectActiveForThread: this.db.prepare(
        `SELECT * FROM queue_messages WHERE thread_key = ? AND status = 'delivered'`
      ),
      selectActiveForThreadAndQueue: this.db.prepare(
        `SELECT * FROM queue_messages WHERE thread_key = ? AND queue = ? AND status = 'delivered'`
      ),
      selectActiveForQueue: this.db.prepare(
        `SELECT * FROM queue_messages WHERE queue = ? AND status = 'delivered'`
      ),
      updateStatus: this.db.prepare(
        `UPDATE queue_messages SET status = ?, updated_at = ? WHERE id = ?`
      ),
      deadletter: this.db.prepare(
        `UPDATE queue_messages SET status = ?, reason = ?, retry_count = ?, updated_at = ? WHERE id = ?`
      ),
      deadletterDirect: this.db.prepare(
        `UPDATE queue_messages SET status = ?, reason = ?, updated_at = ? WHERE id = ?`
      ),
      retry: this.db.prepare(
        `UPDATE queue_messages SET status = ?, retry_count = ?, updated_at = ? WHERE id = ?`
      ),
      prune: this.db.prepare(
        `DELETE FROM queue_messages WHERE status IN ('completed', 'deadlettered') AND updated_at < ?`
      ),
    };
  }
}

interface DbRow {
  id: string;
  queue: string;
  thread_key: string;
  status: string;
  payload: string;
  retry_count: number;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

function rowToQueueMessage(row: DbRow): QueueMessage {
  return {
    id: row.id,
    queue: row.queue as QueueName,
    threadKey: row.thread_key,
    status: row.status as QueueStatus,
    payload: JSON.parse(row.payload),
    retryCount: row.retry_count,
    reason: row.reason ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
