CREATE TABLE IF NOT EXISTS game_timebooks (
 game_id TEXT PRIMARY KEY REFERENCES games(id),
 revision INTEGER NOT NULL CHECK(revision>0),
 state_json TEXT NOT NULL CHECK(json_valid(state_json))
) STRICT;
CREATE TABLE IF NOT EXISTS game_time_events (
 id TEXT PRIMARY KEY,
 game_id TEXT NOT NULL REFERENCES games(id),
 seq INTEGER NOT NULL CHECK(seq>0),
 actor_user_id TEXT NOT NULL REFERENCES users(id),
 operation TEXT NOT NULL,
 before_hash TEXT NOT NULL,
 after_hash TEXT NOT NULL,
 state_json TEXT NOT NULL CHECK(json_valid(state_json)),
 cause_event_id TEXT,
 created_at TEXT NOT NULL,
 UNIQUE(game_id,seq)
) STRICT;
