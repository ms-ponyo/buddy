import type { SessionRegistry as SessionRegistryType, WorkerEntry, SessionType } from '../../src/session-registry.js';

let SessionRegistry: typeof import('../../src/session-registry.js').SessionRegistry;

beforeAll(async () => {
  const mod = await import('../../src/session-registry.js');
  SessionRegistry = mod.SessionRegistry;
});

function createRegistry(): InstanceType<typeof SessionRegistry> {
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any;
  return new SessionRegistry(logger);
}

describe('SessionRegistry', () => {
  describe('basic worker operations (backward compatible)', () => {
    it('register/get/has/remove with default type', () => {
      const reg = createRegistry();
      expect(reg.has('C1:1.1')).toBe(false);

      const entry = reg.register('C1:1.1', 100, '/tmp/worker.sock');
      expect(entry.threadKey).toBe('C1:1.1');
      expect(entry.type).toBe('worker');
      expect(entry.pid).toBe(100);

      expect(reg.has('C1:1.1')).toBe(true);
      expect(reg.get('C1:1.1')).toBe(entry);

      reg.remove('C1:1.1');
      expect(reg.has('C1:1.1')).toBe(false);
      expect(reg.get('C1:1.1')).toBeUndefined();
    });

    it('setRpcClient/getRpcClient defaults to worker', () => {
      const reg = createRegistry();
      reg.register('C1:1.1', 100, '/tmp/worker.sock');

      const mockClient = { call: () => {}, close: () => {} } as any;
      reg.setRpcClient('C1:1.1', mockClient);
      expect(reg.getRpcClient('C1:1.1')).toBe(mockClient);
    });

    it('setState defaults to worker', () => {
      const reg = createRegistry();
      reg.register('C1:1.1', 100, '/tmp/worker.sock');
      reg.setState('C1:1.1', 'busy');
      expect(reg.get('C1:1.1')!.state).toBe('busy');
    });

    it('updateHeartbeat defaults to worker', () => {
      const reg = createRegistry();
      const entry = reg.register('C1:1.1', 100, '/tmp/worker.sock');
      const initial = entry.lastHeartbeat;
      // Advance time slightly
      entry.lastHeartbeat = initial - 1000;
      reg.updateHeartbeat('C1:1.1');
      expect(reg.get('C1:1.1')!.lastHeartbeat).toBeGreaterThanOrEqual(initial);
    });
  });

  describe('type field — worker and lite entries per thread', () => {
    it('allows both worker and lite entries for the same threadKey', () => {
      const reg = createRegistry();
      const worker = reg.register('C1:1.1', 100, '/tmp/worker.sock', 'worker');
      const lite = reg.register('C1:1.1', 200, '/tmp/lite.sock', 'lite');

      expect(reg.has('C1:1.1', 'worker')).toBe(true);
      expect(reg.has('C1:1.1', 'lite')).toBe(true);
      expect(reg.get('C1:1.1', 'worker')!.pid).toBe(100);
      expect(reg.get('C1:1.1', 'lite')!.pid).toBe(200);
      expect(reg.size()).toBe(2);
    });

    it('get with explicit type returns the correct entry', () => {
      const reg = createRegistry();
      reg.register('C1:1.1', 100, '/tmp/worker.sock', 'worker');
      reg.register('C1:1.1', 200, '/tmp/lite.sock', 'lite');

      expect(reg.get('C1:1.1', 'worker')!.type).toBe('worker');
      expect(reg.get('C1:1.1', 'lite')!.type).toBe('lite');
    });

    it('remove only removes the specified type', () => {
      const reg = createRegistry();
      reg.register('C1:1.1', 100, '/tmp/worker.sock', 'worker');
      reg.register('C1:1.1', 200, '/tmp/lite.sock', 'lite');

      reg.remove('C1:1.1', 'lite');
      expect(reg.has('C1:1.1', 'worker')).toBe(true);
      expect(reg.has('C1:1.1', 'lite')).toBe(false);
      expect(reg.size()).toBe(1);
    });

    it('setRpcClient/getRpcClient with explicit type', () => {
      const reg = createRegistry();
      reg.register('C1:1.1', 100, '/tmp/worker.sock', 'worker');
      reg.register('C1:1.1', 200, '/tmp/lite.sock', 'lite');

      const workerClient = { call: () => {}, id: 'worker' } as any;
      const liteClient = { call: () => {}, id: 'lite' } as any;

      reg.setRpcClient('C1:1.1', workerClient, 'worker');
      reg.setRpcClient('C1:1.1', liteClient, 'lite');

      expect(reg.getRpcClient('C1:1.1', 'worker')).toBe(workerClient);
      expect(reg.getRpcClient('C1:1.1', 'lite')).toBe(liteClient);
    });

    it('setState with explicit type', () => {
      const reg = createRegistry();
      reg.register('C1:1.1', 100, '/tmp/worker.sock', 'worker');
      reg.register('C1:1.1', 200, '/tmp/lite.sock', 'lite');

      reg.setState('C1:1.1', 'busy', 'worker');
      reg.setState('C1:1.1', 'idle', 'lite');

      expect(reg.get('C1:1.1', 'worker')!.state).toBe('busy');
      expect(reg.get('C1:1.1', 'lite')!.state).toBe('idle');
    });
  });

  describe('getAll', () => {
    it('returns both worker and lite entries for a threadKey', () => {
      const reg = createRegistry();
      reg.register('C1:1.1', 100, '/tmp/worker.sock', 'worker');
      reg.register('C1:1.1', 200, '/tmp/lite.sock', 'lite');

      const all = reg.getAll('C1:1.1');
      expect(all).toHaveLength(2);
      expect(all.map(e => e.type).sort()).toEqual(['lite', 'worker']);
    });

    it('returns only existing entries', () => {
      const reg = createRegistry();
      reg.register('C1:1.1', 100, '/tmp/worker.sock', 'worker');

      const all = reg.getAll('C1:1.1');
      expect(all).toHaveLength(1);
      expect(all[0].type).toBe('worker');
    });

    it('returns empty array for unknown threadKey', () => {
      const reg = createRegistry();
      expect(reg.getAll('unknown:key')).toEqual([]);
    });
  });

  describe('getAllEntries', () => {
    it('returns all entries across threads and types', () => {
      const reg = createRegistry();
      reg.register('C1:1.1', 100, '/tmp/w1.sock', 'worker');
      reg.register('C1:1.1', 200, '/tmp/l1.sock', 'lite');
      reg.register('C2:2.2', 300, '/tmp/w2.sock', 'worker');

      const all = reg.getAllEntries();
      expect(all).toHaveLength(3);
    });
  });

  describe('callbacks', () => {
    it('callbacks are cleaned up only when removing worker, not lite', () => {
      const reg = createRegistry();
      reg.register('C1:1.1', 100, '/tmp/worker.sock', 'worker');
      reg.register('C1:1.1', 200, '/tmp/lite.sock', 'lite');

      reg.registerCallback('cb-1', 'C1:1.1');
      expect(reg.getThreadForCallback('cb-1')).toBe('C1:1.1');

      // Removing lite should NOT clean up callbacks
      reg.remove('C1:1.1', 'lite');
      expect(reg.getThreadForCallback('cb-1')).toBe('C1:1.1');

      // Removing worker SHOULD clean up callbacks
      reg.remove('C1:1.1', 'worker');
      expect(reg.getThreadForCallback('cb-1')).toBeUndefined();
    });
  });

  describe('register replaces existing entry of same type', () => {
    it('replaces worker entry on re-register', () => {
      const reg = createRegistry();
      reg.register('C1:1.1', 100, '/tmp/old.sock', 'worker');
      reg.register('C1:1.1', 200, '/tmp/new.sock', 'worker');

      expect(reg.get('C1:1.1', 'worker')!.pid).toBe(200);
      expect(reg.size()).toBe(1);
    });

    it('replaces lite entry on re-register without affecting worker', () => {
      const reg = createRegistry();
      reg.register('C1:1.1', 100, '/tmp/worker.sock', 'worker');
      reg.register('C1:1.1', 200, '/tmp/lite-old.sock', 'lite');
      reg.register('C1:1.1', 300, '/tmp/lite-new.sock', 'lite');

      expect(reg.get('C1:1.1', 'worker')!.pid).toBe(100);
      expect(reg.get('C1:1.1', 'lite')!.pid).toBe(300);
      expect(reg.size()).toBe(2);
    });
  });
});
