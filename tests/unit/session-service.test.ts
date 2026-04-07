import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../../packages/persistence/src/database.js';
import { SessionService } from '../../packages/persistence/src/session-service.js';

const tempDir = mkdtempSync(join(tmpdir(), 'session-test-'));
let db: ReturnType<typeof openDatabase>;
let sessions: SessionService;

beforeAll(() => {
  db = openDatabase(join(tempDir, 'test.db'));
  sessions = new SessionService(db);
});

afterAll(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('SessionService', () => {
  afterEach(() => {
    db.exec('DELETE FROM sessions');
  });

  it('upsert creates new session', () => {
    sessions.upsert('C123:T456', { sessionId: 'sess-1', cost: 0.05 });
    const { session } = sessions.get('C123:T456');
    expect(session).not.toBeNull();
    expect(session!.sessionId).toBe('sess-1');
    expect(session!.cost).toBe(0.05);
    expect(session!.createdAt).toBeDefined();
  });

  it('upsert updates existing session (merges fields)', () => {
    sessions.upsert('C123:T456', { sessionId: 'sess-1', cost: 0.05 });
    sessions.upsert('C123:T456', { cost: 0.10 });

    const { session } = sessions.get('C123:T456');
    expect(session!.sessionId).toBe('sess-1'); // preserved
    expect(session!.cost).toBe(0.10); // updated
  });

  it('get returns null for missing session', () => {
    const { session } = sessions.get('nonexistent');
    expect(session).toBeNull();
  });

  it('delete removes session', () => {
    sessions.upsert('C123:T456', { sessionId: 'sess-1' });
    sessions.delete('C123:T456');
    const { session } = sessions.get('C123:T456');
    expect(session).toBeNull();
  });

  it('list returns all sessions', () => {
    sessions.upsert('C1:T1', { sessionId: 'a' });
    sessions.upsert('C2:T2', { sessionId: 'b' });
    const { sessions: all } = sessions.list();
    expect(all).toHaveLength(2);
  });
});
