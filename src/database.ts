import Database from 'better-sqlite3';

export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS spaces (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS evidence (
      id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id),
      source_type TEXT NOT NULL, content TEXT NOT NULL, metadata TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS evidence_space_idx ON evidence(space_id, created_at);
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id),
      name TEXT NOT NULL, metadata TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(space_id,id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id),
      kind TEXT NOT NULL, content TEXT NOT NULL, data TEXT NOT NULL,
      source_id TEXT NOT NULL REFERENCES evidence(id),
      occurred_at TEXT, valid_from TEXT, valid_to TEXT,
      lifecycle TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle IN ('pending','active','stale','deleted')),
      resolution TEXT NOT NULL DEFAULT 'resolved' CHECK(resolution IN ('unresolved','resolved')),
      support TEXT NOT NULL DEFAULT 'asserted' CHECK(support IN ('asserted','supported','disputed')),
      corrected_by TEXT REFERENCES memories(id),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(space_id,id), CHECK(valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS memories_space_status_idx ON memories(space_id,lifecycle,created_at);
    CREATE INDEX IF NOT EXISTS memories_space_time_idx ON memories(space_id,occurred_at,created_at);
    CREATE TABLE IF NOT EXISTS links (
      id INTEGER PRIMARY KEY,
      space_id TEXT NOT NULL REFERENCES spaces(id),
      from_type TEXT NOT NULL CHECK(from_type IN ('memory','entity','evidence')),
      from_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      to_type TEXT NOT NULL CHECK(to_type IN ('memory','entity','evidence')),
      to_id TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}', active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      UNIQUE(space_id,from_type,from_id,relation,to_type,to_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS links_from_idx ON links(space_id,from_type,from_id,active);
    CREATE INDEX IF NOT EXISTS links_to_idx ON links(space_id,to_type,to_id,active);
    CREATE TABLE IF NOT EXISTS idempotency (
      space_id TEXT NOT NULL REFERENCES spaces(id), key TEXT NOT NULL,
      payload_hash TEXT NOT NULL, result TEXT NOT NULL,
      PRIMARY KEY(space_id,key)
    ) STRICT;
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      memory_id UNINDEXED, space_id UNINDEXED, content, tokenize='unicode61 remove_diacritics 2'
    );
  `);
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1,?)').run(new Date().toISOString());
  return db;
}
