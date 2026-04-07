// packages/persistence/src/session-service.ts
import type Database from 'better-sqlite3';
import type { SessionRecord } from '@buddy/shared';

export class SessionService {
  private stmts: ReturnType<typeof this.prepareStatements>;

  constructor(private db: Database.Database) {
    this.stmts = this.prepareStatements();
  }

  get(threadKey: string): { session: SessionRecord | null } {
    const row = this.stmts.selectByKey.get(threadKey) as DbSessionRow | undefined;
    return { session: row ? rowToSession(row) : null };
  }

  upsert(threadKey: string, data: Partial<Omit<SessionRecord, 'threadKey' | 'createdAt' | 'updatedAt'>>): void {
    const now = new Date().toISOString();
    const existing = this.stmts.selectByKey.get(threadKey) as DbSessionRow | undefined;

    if (existing) {
      this.stmts.update.run(
        data.sessionId ?? existing.session_id,
        data.cost ?? existing.cost,
        data.planPath ?? existing.plan_path,
        data.metadata !== undefined ? JSON.stringify(data.metadata) : existing.metadata,
        now,
        threadKey,
      );
    } else {
      this.stmts.insert.run(
        threadKey,
        data.sessionId ?? null,
        data.cost ?? 0,
        data.planPath ?? null,
        data.metadata ? JSON.stringify(data.metadata) : null,
        now,
        now,
      );
    }
  }

  delete(threadKey: string): void {
    this.stmts.deleteByKey.run(threadKey);
  }

  list(): { sessions: SessionRecord[] } {
    const rows = this.stmts.selectAll.all() as DbSessionRow[];
    return { sessions: rows.map(rowToSession) };
  }

  private prepareStatements() {
    return {
      selectByKey: this.db.prepare(`SELECT * FROM sessions WHERE thread_key = ?`),
      selectAll: this.db.prepare(`SELECT * FROM sessions ORDER BY updated_at DESC`),
      insert: this.db.prepare(
        `INSERT INTO sessions (thread_key, session_id, cost, plan_path, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ),
      update: this.db.prepare(
        `UPDATE sessions SET session_id = ?, cost = ?, plan_path = ?, metadata = ?, updated_at = ? WHERE thread_key = ?`
      ),
      deleteByKey: this.db.prepare(`DELETE FROM sessions WHERE thread_key = ?`),
      count: this.db.prepare(`SELECT COUNT(*) as cnt FROM sessions`),
    };
  }
}

interface DbSessionRow {
  thread_key: string;
  session_id: string | null;
  cost: number;
  plan_path: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

function rowToSession(row: DbSessionRow): SessionRecord {
  return {
    threadKey: row.thread_key,
    sessionId: row.session_id ?? undefined,
    cost: row.cost,
    planPath: row.plan_path ?? undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
