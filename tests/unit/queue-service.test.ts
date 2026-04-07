import { jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Set env before any imports that read CONFIG
const tempDir = mkdtempSync(join(tmpdir(), 'queue-test-'));
process.env.PERSISTENCE_DB_PATH = join(tempDir, 'test.db');

import { openDatabase } from '../../packages/persistence/src/database.js';
import { QueueService } from '../../packages/persistence/src/queue-service.js';

let db: ReturnType<typeof openDatabase>;
let queue: QueueService;

beforeAll(() => {
  db = openDatabase(join(tempDir, 'test.db'));
  queue = new QueueService(db);
});

afterAll(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('QueueService', () => {
  afterEach(() => {
    // Clean up between tests
    db.exec('DELETE FROM queue_messages');
  });

  it('enqueue creates a pending message with correct fields', () => {
    const { id } = queue.enqueue('inbound', 'C123:T456', { text: 'hello' });
    expect(id).toBeDefined();
    const msg = queue.nextPending('inbound', 'C123:T456');
    expect(msg).not.toBeNull();
    expect(msg!.payload).toEqual({ text: 'hello' });
    expect(msg!.queue).toBe('inbound');
    expect(msg!.threadKey).toBe('C123:T456');
  });

  it('nextPending returns pending messages and markDelivered transitions them', () => {
    queue.enqueue('inbound', 'C123:T456', { text: 'msg1' });
    queue.enqueue('inbound', 'C123:T456', { text: 'msg2' });

    const msg1 = queue.nextPending('inbound', 'C123:T456');
    expect(msg1).not.toBeNull();
    expect(msg1!.status).toBe('pending');
    queue.markDelivered(msg1!.id);

    // Verify DB status is now 'delivered'
    const row = db.prepare('SELECT status FROM queue_messages WHERE id = ?').get(msg1!.id) as any;
    expect(row.status).toBe('delivered');

    // nextPending returns the second message (first is delivered)
    const msg2 = queue.nextPending('inbound', 'C123:T456');
    expect(msg2).not.toBeNull();
    expect(msg2!.payload).toEqual({ text: 'msg2' });
    queue.markDelivered(msg2!.id);

    // No more pending
    const msg3 = queue.nextPending('inbound', 'C123:T456');
    expect(msg3).toBeNull();
  });

  it('nextPending respects queue name and threadKey filters', () => {
    queue.enqueue('inbound', 'C123:T456', { text: 'inbound' });
    queue.enqueue('outbound', 'C123:T456', { text: 'outbound' });
    queue.enqueue('inbound', 'C999:T999', { text: 'other-thread' });

    const msg = queue.nextPending('inbound', 'C123:T456');
    expect(msg).not.toBeNull();
    expect(msg!.payload).toEqual({ text: 'inbound' });
  });

  it('nextPendingAny returns messages across all threads', () => {
    queue.enqueue('outbound', 'C1:T1', { text: 'first' });
    queue.enqueue('outbound', 'C2:T2', { text: 'second' });

    const msg = queue.nextPendingAny('outbound');
    expect(msg).not.toBeNull();
    expect(msg!.payload).toEqual({ text: 'first' });
  });

  it('ack marks message completed', () => {
    const { id } = queue.enqueue('inbound', 'C123:T456', { text: 'hello' });
    queue.markDelivered(id); // delivered
    queue.ack('inbound', id);

    // Verify status via raw DB query
    const row = db.prepare('SELECT status FROM queue_messages WHERE id = ?').get(id) as any;
    expect(row.status).toBe('completed');
  });

  it('nack increments retryCount and resets to pending', () => {
    const { id } = queue.enqueue('inbound', 'C123:T456', { text: 'hello' });
    queue.markDelivered(id); // delivered
    queue.nack('inbound', id);

    const row = db.prepare('SELECT status, retry_count FROM queue_messages WHERE id = ?').get(id) as any;
    expect(row.status).toBe('pending');
    expect(row.retry_count).toBe(1);
  });

  it('nack deadletters after MAX_RETRIES (3)', () => {
    const { id } = queue.enqueue('inbound', 'C123:T456', { text: 'hello' });

    for (let i = 0; i < 3; i++) {
      queue.markDelivered(id);
      queue.nack('inbound', id);
    }

    const row = db.prepare('SELECT status, retry_count FROM queue_messages WHERE id = ?').get(id) as any;
    expect(row.status).toBe('deadlettered');
    expect(row.retry_count).toBe(3);
  });

  it('deadletter explicitly marks a message', () => {
    const { id } = queue.enqueue('inbound', 'C123:T456', { text: 'hello' });
    queue.deadletter('inbound', id, 'manual deadletter');

    const row = db.prepare('SELECT status, reason FROM queue_messages WHERE id = ?').get(id) as any;
    expect(row.status).toBe('deadlettered');
    expect(row.reason).toBe('manual deadletter');
  });

  it('resetForThread resets delivered to pending, deadletters if exceeds MAX_RETRIES', () => {
    const { id: id1 } = queue.enqueue('inbound', 'C123:T456', { text: 'msg1' });
    const { id: id2 } = queue.enqueue('inbound', 'C123:T456', { text: 'msg2' });
    queue.markDelivered(id1);
    queue.markDelivered(id2);

    // Nack id1 twice so it has retryCount=2 before reset
    queue.nack('inbound', id1);
    queue.markDelivered(id1);
    queue.nack('inbound', id1);
    queue.markDelivered(id1); // re-deliver
    // id1 retryCount=2, status=delivered; id2 retryCount=0, status=delivered

    queue.resetForThread('C123:T456');

    const row1 = db.prepare('SELECT status, retry_count FROM queue_messages WHERE id = ?').get(id1) as any;
    const row2 = db.prepare('SELECT status, retry_count FROM queue_messages WHERE id = ?').get(id2) as any;

    // id1: retryCount was 2, +1 = 3 >= MAX_RETRIES → deadlettered
    expect(row1.status).toBe('deadlettered');
    expect(row1.retry_count).toBe(3);

    // id2: retryCount was 0, +1 = 1 < MAX_RETRIES → pending
    expect(row2.status).toBe('pending');
    expect(row2.retry_count).toBe(1);
  });

  it('prune removes completed/deadlettered messages older than PRUNE_AGE', () => {
    const { id: id1 } = queue.enqueue('inbound', 'C123:T456', { text: 'old' });
    const { id: id2 } = queue.enqueue('inbound', 'C123:T456', { text: 'recent' });
    queue.ack('inbound', id1);
    queue.ack('inbound', id2);

    // Backdate id1 to be very old
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ago
    db.prepare('UPDATE queue_messages SET updated_at = ? WHERE id = ?').run(oldDate, id1);

    const pruned = queue.prune();
    expect(pruned).toBe(1); // Only the old one

    const remaining = db.prepare('SELECT id FROM queue_messages').all();
    expect(remaining).toHaveLength(1);
  });
});
