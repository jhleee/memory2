-- Private GM editorial memory, deliberately outside public GameState/Event/Memory.
CREATE TABLE IF NOT EXISTS gm_notebooks (
 game_id TEXT PRIMARY KEY REFERENCES games(id),
 revision INTEGER NOT NULL CHECK(revision>=0),
 state_json TEXT NOT NULL CHECK(json_valid(state_json))
) STRICT;
CREATE TABLE IF NOT EXISTS gm_note_events (
 id TEXT PRIMARY KEY,
 game_id TEXT NOT NULL REFERENCES games(id),
 seq INTEGER NOT NULL CHECK(seq>0),
 actor_user_id TEXT NOT NULL REFERENCES users(id),
 operation_json TEXT NOT NULL CHECK(json_valid(operation_json)),
 before_hash TEXT NOT NULL,
 after_hash TEXT NOT NULL,
 state_json TEXT NOT NULL CHECK(json_valid(state_json)),
 created_at TEXT NOT NULL,
 UNIQUE(game_id,seq)
) STRICT;
