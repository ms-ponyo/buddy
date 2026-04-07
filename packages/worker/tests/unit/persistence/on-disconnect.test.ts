import { jest } from '@jest/globals';
import { openDatabase } from '@buddy/persistence/database';
import { QueueService } from '@buddy/persistence/queue-service';

describe('QueueService.resetForThread', () => {
  let db: ReturnType<typeof openDatabase>;
  let queue: QueueService;

  beforeEach(() => {
    db = openDatabase(':memory:');
    queue = new QueueService(db);
  });

  afterEach(() => {
    db.close();
  });

  it('resets delivered inbound-lite messages to pending when a lite worker disconnects', () => {
    // Simulate lite worker subscribed to inbound-lite
    const { id } = queue.enqueue('inbound-lite', 'C1:1.1', { prompt: '!help' });
    // Mark as delivered (simulates delivery loop delivering it)
    queue.markDelivered(id);

    // On disconnect, reset only inbound-lite for this thread
    queue.resetForThread('C1:1.1', 'inbound-lite');

    // The message should be back to pending (retry_count incremented to 1)
    const next = queue.nextPending('inbound-lite', 'C1:1.1');
    expect(next).not.toBeNull();
    expect(next!.id).toBe(id);
    expect(next!.status).toBe('pending');
    expect(next!.retryCount).toBe(1);
  });

  it('resets delivered inbound messages to pending when a worker disconnects (regression)', () => {
    // Simulate worker subscribed to inbound
    const { id } = queue.enqueue('inbound', 'C2:2.2', { prompt: 'hello' });
    queue.markDelivered(id);

    // On disconnect, reset only inbound for this thread
    queue.resetForThread('C2:2.2', 'inbound');

    const next = queue.nextPending('inbound', 'C2:2.2');
    expect(next).not.toBeNull();
    expect(next!.id).toBe(id);
    expect(next!.status).toBe('pending');
    expect(next!.retryCount).toBe(1);
  });

  it('only resets messages in the specified queue, leaving other queues untouched', () => {
    const threadKey = 'C3:3.3';

    // Enqueue to both inbound and inbound-lite
    const { id: inboundId } = queue.enqueue('inbound', threadKey, { prompt: 'worker msg' });
    const { id: liteId } = queue.enqueue('inbound-lite', threadKey, { prompt: 'lite msg' });

    // Mark both as delivered
    queue.markDelivered(inboundId);
    queue.markDelivered(liteId);

    // Reset only inbound-lite (as if lite worker disconnected)
    queue.resetForThread(threadKey, 'inbound-lite');

    // inbound-lite should be reset to pending
    const litePending = queue.nextPending('inbound-lite', threadKey);
    expect(litePending).not.toBeNull();
    expect(litePending!.id).toBe(liteId);
    expect(litePending!.status).toBe('pending');

    // inbound should remain delivered (not affected)
    const inboundPending = queue.nextPending('inbound', threadKey);
    expect(inboundPending).toBeNull();
  });

  it('resets all queues for a thread when no queue is specified (backward compat)', () => {
    const threadKey = 'C4:4.4';

    const { id: inboundId } = queue.enqueue('inbound', threadKey, { prompt: 'msg1' });
    const { id: liteId } = queue.enqueue('inbound-lite', threadKey, { prompt: 'msg2' });

    queue.markDelivered(inboundId);
    queue.markDelivered(liteId);

    // Reset all queues (no queue param — old behavior)
    queue.resetForThread(threadKey);

    const inboundPending = queue.nextPending('inbound', threadKey);
    expect(inboundPending).not.toBeNull();
    expect(inboundPending!.id).toBe(inboundId);

    const litePending = queue.nextPending('inbound-lite', threadKey);
    expect(litePending).not.toBeNull();
    expect(litePending!.id).toBe(liteId);
  });
});
