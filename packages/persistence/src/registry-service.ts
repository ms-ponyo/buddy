// packages/persistence/src/registry-service.ts
import type Database from 'better-sqlite3';
import type { ProcessEntry, ProcessType } from '@buddy/shared';

export class RegistryService {
  private stmts: ReturnType<typeof this.prepareStatements>;

  constructor(private db: Database.Database) {
    this.stmts = this.prepareStatements();
  }

  register(type: ProcessType, threadKey: string | undefined, pid: number, socketPath: string, purpose = 'main'): void {
    const now = new Date().toISOString();
    const key = threadKey ?? '';
    // Upsert: replace if same type+threadKey+purpose already exists
    this.stmts.upsert.run(type, key, pid, socketPath, now, purpose);
  }

  deregister(type: ProcessType, threadKey?: string, purpose = 'main'): void {
    const key = threadKey ?? '';
    this.stmts.delete.run(type, key, purpose);
  }

  list(type?: ProcessType): ProcessEntry[] {
    const rows = type
      ? (this.stmts.selectByType.all(type) as DbRegistryRow[])
      : (this.stmts.selectAll.all() as DbRegistryRow[]);
    return rows.map(rowToEntry);
  }

  cleanupStale(): number {
    // Check each registered process to see if its PID is still alive
    const all = this.stmts.selectAll.all() as DbRegistryRow[];
    let removed = 0;

    for (const row of all) {
      if (!isPidAlive(row.pid)) {
        this.stmts.deleteById.run(row.id);
        removed++;
      }
    }

    return removed;
  }

  private prepareStatements() {
    return {
      upsert: this.db.prepare(
        `INSERT INTO process_registry (type, thread_key, pid, socket_path, registered_at, purpose)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (type, thread_key, purpose) DO UPDATE SET pid = excluded.pid, socket_path = excluded.socket_path, registered_at = excluded.registered_at`
      ),
      delete: this.db.prepare(`DELETE FROM process_registry WHERE type = ? AND thread_key = ? AND purpose = ?`),
      deleteById: this.db.prepare(`DELETE FROM process_registry WHERE id = ?`),
      selectByType: this.db.prepare(`SELECT * FROM process_registry WHERE type = ?`),
      selectAll: this.db.prepare(`SELECT * FROM process_registry`),
    };
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface DbRegistryRow {
  id: number;
  type: string;
  thread_key: string;
  pid: number;
  socket_path: string;
  registered_at: string;
  purpose?: string;
}

function rowToEntry(row: DbRegistryRow): ProcessEntry {
  return {
    type: row.type as ProcessType,
    threadKey: row.thread_key,
    pid: row.pid,
    socketPath: row.socket_path,
    registeredAt: row.registered_at,
    purpose: row.purpose || 'main',
  };
}
