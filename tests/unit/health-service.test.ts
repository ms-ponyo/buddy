import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../../packages/persistence/src/database.js';
import { QueueService } from '../../packages/persistence/src/queue-service.js';
import { HealthService } from '../../packages/persistence/src/health-service.js';

const tempDir = mkdtempSync(join(tmpdir(), 'health-test-'));
let db: ReturnType<typeof openDatabase>;
let queue: QueueService;
let health: HealthService;

beforeAll(() => {
  db = openDatabase(join(tempDir, 'test.db'));
  queue = new QueueService(db);
  health = new HealthService(db);
});

afterAll(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('HealthService', () => {
  afterEach(() => {
    db.exec('DELETE FROM queue_messages');
  });

  it('getHealth returns uptime, status, and per-thread queue metrics', () => {
    queue.enqueue('inbound', 'C1:T1', { text: 'msg1' });
    queue.enqueue('inbound', 'C1:T1', { text: 'msg2' });
    queue.enqueue('outbound', 'C1:T1', { text: 'out1' });

    const result = health.getHealth();
    expect(result.status).toBe('ok');
    expect(result.uptime).toBeGreaterThanOrEqual(0);

    expect(result.queues.inbound.total_pending).toBe(2);
    expect(result.queues.inbound.by_thread['C1:T1'].pending).toBe(2);
    expect(result.queues.outbound.total_pending).toBe(1);
  });

  it('per-thread metrics include oldest unfinished message age for pending', () => {
    queue.enqueue('inbound', 'C1:T1', { text: 'old' });
    // Backdate the message
    const oldDate = new Date(Date.now() - 60000).toISOString(); // 60 seconds ago
    db.prepare('UPDATE queue_messages SET updated_at = ? WHERE queue = ?').run(oldDate, 'inbound');

    const result = health.getHealth();
    expect(result.queues.inbound.by_thread['C1:T1'].oldest_unfinished_age_sec).toBeGreaterThanOrEqual(59);
  });

  it('per-thread metrics include oldest unfinished message age for delivered', () => {
    const { id } = queue.enqueue('inbound', 'C1:T1', { text: 'msg' });
    queue.markDelivered(id);
    // Backdate the delivered message
    const oldDate = new Date(Date.now() - 120000).toISOString(); // 120 seconds ago
    db.prepare('UPDATE queue_messages SET updated_at = ? WHERE id = ?').run(oldDate, id);

    const result = health.getHealth();
    expect(result.queues.inbound.by_thread['C1:T1'].oldest_unfinished_age_sec).toBeGreaterThanOrEqual(119);
  });

  it('returns empty metrics when no messages exist', () => {
    const result = health.getHealth();
    expect(result.queues.inbound.total_pending).toBe(0);
    expect(result.queues.inbound.total_delivered).toBe(0);
    expect(Object.keys(result.queues.inbound.by_thread)).toHaveLength(0);
    expect(result.queues.outbound.total_pending).toBe(0);
  });
});
