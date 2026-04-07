import { jest } from '@jest/globals';
import { openDatabase } from '@buddy/persistence/database';
import { RegistryService } from '@buddy/persistence/registry-service';

describe('RegistryService with purpose', () => {
  let db: ReturnType<typeof openDatabase>;
  let registry: RegistryService;

  beforeEach(() => {
    db = openDatabase(':memory:');
    registry = new RegistryService(db);
  });

  afterEach(() => {
    db.close();
  });

  it('registers a worker with default purpose', () => {
    registry.register('worker', 'C1:1.1', 1234, '/tmp/worker.sock');
    const entries = registry.list('worker');
    expect(entries).toHaveLength(1);
    expect(entries[0].purpose).toBe('main');
  });

  it('registers a lite worker with dispatch purpose', () => {
    registry.register('lite', 'C1:1.1', 5678, '/tmp/lite.sock', 'dispatch');
    const entries = registry.list('lite');
    expect(entries).toHaveLength(1);
    expect(entries[0].purpose).toBe('dispatch');
  });

  it('allows worker and lite for same threadKey', () => {
    registry.register('worker', 'C1:1.1', 1234, '/tmp/worker.sock');
    registry.register('lite', 'C1:1.1', 5678, '/tmp/lite.sock', 'dispatch');
    const all = registry.list();
    const forThread = all.filter(e => e.threadKey === 'C1:1.1');
    expect(forThread).toHaveLength(2);
  });

  it('allows multiple lite workers with different purposes for same threadKey', () => {
    registry.register('lite', 'C1:1.1', 5678, '/tmp/lite-dispatch.sock', 'dispatch');
    registry.register('lite', 'C1:1.1', 9012, '/tmp/lite-search.sock', 'search');
    const lites = registry.list('lite');
    expect(lites).toHaveLength(2);
  });

  it('upserts on same (type, threadKey, purpose)', () => {
    registry.register('lite', 'C1:1.1', 5678, '/tmp/old.sock', 'dispatch');
    registry.register('lite', 'C1:1.1', 9999, '/tmp/new.sock', 'dispatch');
    const lites = registry.list('lite');
    expect(lites).toHaveLength(1);
    expect(lites[0].pid).toBe(9999);
  });

  it('deregisters by type, threadKey, and purpose', () => {
    registry.register('lite', 'C1:1.1', 5678, '/tmp/dispatch.sock', 'dispatch');
    registry.register('lite', 'C1:1.1', 9012, '/tmp/search.sock', 'search');
    registry.deregister('lite', 'C1:1.1', 'dispatch');
    const lites = registry.list('lite');
    expect(lites).toHaveLength(1);
    expect(lites[0].purpose).toBe('search');
  });
});
