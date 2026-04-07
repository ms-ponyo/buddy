// packages/persistence/src/database.ts
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CONFIG } from './config.js';

export function openDatabase(dbPath: string = CONFIG.DB_PATH): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);

  // Enable WAL mode for concurrent reads
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  runMigrations(db);

  return db;
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS queue_messages (
      id TEXT PRIMARY KEY,
      queue TEXT NOT NULL,
      thread_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      payload TEXT NOT NULL,
      retry_count INTEGER DEFAULT 0,
      reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_queue_thread_status
      ON queue_messages(queue, thread_key, status);

    CREATE INDEX IF NOT EXISTS idx_queue_updated_at
      ON queue_messages(updated_at);

    CREATE TABLE IF NOT EXISTS sessions (
      thread_key TEXT PRIMARY KEY,
      session_id TEXT,
      cost REAL DEFAULT 0,
      plan_path TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS process_registry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      thread_key TEXT NOT NULL DEFAULT '',
      pid INTEGER NOT NULL,
      socket_path TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'main',
      UNIQUE (type, thread_key, purpose)
    );
  `);

  // Incremental migrations for existing databases
  const columns = db.prepare(`PRAGMA table_info(process_registry)`).all() as { name: string }[];
  const colNames = columns.map(c => c.name);
  if (!colNames.includes('purpose')) {
    db.exec(`ALTER TABLE process_registry ADD COLUMN purpose TEXT NOT NULL DEFAULT 'main'`);
    // Recreate the unique index to include purpose
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_process_registry ON process_registry(type, thread_key, purpose)`);
  }
}
