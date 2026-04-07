import { jest } from '@jest/globals';
import { openDatabase } from '@buddy/persistence/database';
import { HealthService } from '@buddy/persistence/health-service';
import { QueueService } from '@buddy/persistence/queue-service';

describe('HealthService', () => {
  let db: ReturnType<typeof openDatabase>;
  let health: HealthService;
  let queue: QueueService;

  beforeEach(() => {
    db = openDatabase(':memory:');
    health = new HealthService(db);
    queue = new QueueService(db);
  });

  afterEach(() => {
    db.close();
  });

  it('includes inbound-lite in health response', () => {
    const result = health.getHealth();
    expect(result.queues['inbound-lite']).toBeDefined();
    expect(result.queues['inbound-lite'].total_pending).toBe(0);
  });

  it('reports inbound-lite metrics correctly', () => {
    queue.enqueue('inbound-lite', 'C1:1.1', { prompt: '!help' });
    queue.enqueue('inbound-lite', 'C1:1.1', { prompt: '!status' });
    const result = health.getHealth();
    expect(result.queues['inbound-lite'].total_pending).toBe(2);
  });
});
