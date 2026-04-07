// packages/persistence/src/health-service.ts
import type Database from 'better-sqlite3';
import type { PersistenceHealth, QueueHealthMetrics, QueueName } from '@buddy/shared';

export class HealthService {
  private startTime = Date.now();

  constructor(private db: Database.Database) {}

  getHealth(): PersistenceHealth {
    return {
      status: 'ok',
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      queues: {
        inbound: this.getQueueMetrics('inbound'),
        outbound: this.getQueueMetrics('outbound'),
        'inbound-lite': this.getQueueMetrics('inbound-lite'),
      },
    };
  }

  private getQueueMetrics(queue: QueueName): QueueHealthMetrics {
    const rows = this.db.prepare(
      `SELECT thread_key, status, COUNT(*) as cnt, MIN(updated_at) as oldest
       FROM queue_messages
       WHERE queue = ? AND status IN ('pending', 'delivered')
       GROUP BY thread_key, status`
    ).all(queue) as Array<{ thread_key: string; status: string; cnt: number; oldest: string }>;

    const byThread: QueueHealthMetrics['by_thread'] = {};
    let totalPending = 0, totalDelivered = 0;

    for (const row of rows) {
      if (!byThread[row.thread_key]) {
        byThread[row.thread_key] = { pending: 0, delivered: 0, oldest_unfinished_age_sec: 0 };
      }
      const t = byThread[row.thread_key];
      const ageSec = Math.floor((Date.now() - new Date(row.oldest).getTime()) / 1000);
      switch (row.status) {
        case 'pending':
          t.pending = row.cnt;
          totalPending += row.cnt;
          break;
        case 'delivered':
          t.delivered = row.cnt;
          totalDelivered += row.cnt;
          break;
      }
      if (ageSec > t.oldest_unfinished_age_sec) {
        t.oldest_unfinished_age_sec = ageSec;
      }
    }

    return {
      total_pending: totalPending,
      total_delivered: totalDelivered,
      by_thread: byThread,
    };
  }
}
