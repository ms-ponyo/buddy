import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../../packages/persistence/src/database.js';
import { RegistryService } from '../../packages/persistence/src/registry-service.js';

const tempDir = mkdtempSync(join(tmpdir(), 'registry-test-'));
let db: ReturnType<typeof openDatabase>;
let registry: RegistryService;

beforeAll(() => {
  db = openDatabase(join(tempDir, 'test.db'));
  registry = new RegistryService(db);
});

afterAll(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('RegistryService', () => {
  afterEach(() => {
    db.exec('DELETE FROM process_registry');
  });

  it('register adds a process entry', () => {
    registry.register('gateway', undefined, process.pid, '/tmp/test.sock');
    const processes = registry.list('gateway');
    expect(processes).toHaveLength(1);
    expect(processes[0].pid).toBe(process.pid);
    expect(processes[0].socketPath).toBe('/tmp/test.sock');
  });

  it('register upserts on conflict (same type+threadKey)', () => {
    registry.register('worker', 'C1:T1', 1000, '/tmp/old.sock');
    registry.register('worker', 'C1:T1', 2000, '/tmp/new.sock');

    const processes = registry.list('worker');
    expect(processes).toHaveLength(1);
    expect(processes[0].pid).toBe(2000);
    expect(processes[0].socketPath).toBe('/tmp/new.sock');
  });

  it('deregister removes entry', () => {
    registry.register('worker', 'C1:T1', 1000, '/tmp/w.sock');
    registry.deregister('worker', 'C1:T1');
    const processes = registry.list('worker');
    expect(processes).toHaveLength(0);
  });

  it('list filters by type', () => {
    registry.register('gateway', undefined, process.pid, '/tmp/g.sock');
    registry.register('worker', 'C1:T1', 1000, '/tmp/w.sock');

    const gateways = registry.list('gateway');
    expect(gateways).toHaveLength(1);
    expect(gateways[0].type).toBe('gateway');

    const all = registry.list();
    expect(all).toHaveLength(2);
  });

  it('cleanupStale removes entries with dead PIDs', () => {
    // Register with a PID that definitely doesn't exist
    registry.register('worker', 'C1:T1', 99999, '/tmp/dead.sock');
    // Register with current (alive) PID
    registry.register('gateway', undefined, process.pid, '/tmp/alive.sock');

    const removed = registry.cleanupStale();
    expect(removed).toBe(1);

    const processes = registry.list();
    expect(processes).toHaveLength(1);
    expect(processes[0].type).toBe('gateway');
  });
});
