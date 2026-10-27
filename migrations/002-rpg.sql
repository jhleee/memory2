CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (issuer, subject)
) STRICT;

CREATE TABLE IF NOT EXISTS worlds (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  gm_policy_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(gm_policy_json)),
  start_config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(start_config_json)),
  visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'unlisted', 'public')),
  draft_revision INTEGER NOT NULL DEFAULT 0 CHECK (draft_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS world_members (
  world_id TEXT NOT NULL REFERENCES worlds(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  PRIMARY KEY (world_id, user_id)
) STRICT;

CREATE TABLE IF NOT EXISTS world_schemas (
  world_id TEXT NOT NULL REFERENCES worlds(id),
  type_name TEXT NOT NULL,
  schema_json TEXT NOT NULL CHECK (json_valid(schema_json)),
  schema_revision INTEGER NOT NULL CHECK (schema_revision > 0),
  PRIMARY KEY (world_id, type_name)
) STRICT;

CREATE TABLE IF NOT EXISTS world_entities (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,
  type_name TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  deleted_at TEXT,
  FOREIGN KEY (world_id, type_name)
    REFERENCES world_schemas(world_id, type_name)
) STRICT;
CREATE INDEX IF NOT EXISTS world_entity_type_idx
  ON world_entities(world_id, type_name, deleted_at);

CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id),
  version TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  content_hash TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (world_id, version),
  UNIQUE (id, world_id)
) STRICT;

CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id),
  release_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  turn_seq INTEGER NOT NULL DEFAULT 0 CHECK (turn_seq >= 0),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'ended')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (release_id, world_id) REFERENCES releases(id, world_id)
) STRICT;

CREATE TABLE IF NOT EXISTS game_members (
  game_id TEXT NOT NULL REFERENCES games(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'player', 'spectator')),
  character_id TEXT,
  PRIMARY KEY (game_id, user_id)
) STRICT;

CREATE TABLE IF NOT EXISTS game_events (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id),
  seq INTEGER NOT NULL CHECK (seq > 0),
  turn_seq INTEGER NOT NULL CHECK (turn_seq >= 0),
  origin TEXT NOT NULL CHECK (origin IN ('player', 'server')),
  actor_user_id TEXT REFERENCES users(id),
  action_json TEXT NOT NULL CHECK (json_valid(action_json)),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  patch_json TEXT NOT NULL CHECK (json_valid(patch_json)),
  before_hash TEXT NOT NULL,
  after_hash TEXT NOT NULL,
  happened_at TEXT NOT NULL,
  UNIQUE (game_id, seq),
  CHECK (origin != 'player' OR actor_user_id IS NOT NULL)
) STRICT;
CREATE INDEX IF NOT EXISTS game_events_by_turn_idx
  ON game_events(game_id, turn_seq, seq);

CREATE TABLE IF NOT EXISTS action_idempotency (
  game_id TEXT NOT NULL REFERENCES games(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  PRIMARY KEY (game_id, actor_user_id, key)
) STRICT;

CREATE TABLE IF NOT EXISTS operation_idempotency (
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  operation TEXT NOT NULL,
  key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  PRIMARY KEY (actor_user_id, operation, key)
) STRICT;

CREATE TABLE IF NOT EXISTS game_snapshots (
  game_id TEXT NOT NULL REFERENCES games(id),
  seq INTEGER NOT NULL CHECK (seq >= 0),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  state_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (game_id, seq)
) STRICT;

CREATE TABLE IF NOT EXISTS game_transcript (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id),
  turn_seq INTEGER NOT NULL CHECK (turn_seq >= 0),
  client_message_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('player', 'gm', 'system')),
  submitted_by_user_id TEXT REFERENCES users(id),
  source TEXT NOT NULL DEFAULT 'client_reported',
  body TEXT NOT NULL,
  confirmed_event_id TEXT REFERENCES game_events(id),
  created_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS transcript_external_id_idx
  ON game_transcript(game_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS game_event_memories (
  game_id TEXT NOT NULL REFERENCES games(id),
  event_id TEXT NOT NULL REFERENCES game_events(id),
  memory_id TEXT NOT NULL REFERENCES memories(id),
  PRIMARY KEY (game_id, event_id, memory_id)
) STRICT;

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  principal_id TEXT,
  world_id TEXT,
  game_id TEXT,
  request_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  result_code TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
