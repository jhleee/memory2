CREATE TABLE IF NOT EXISTS expansion_proposals (
 id TEXT PRIMARY KEY,
 game_id TEXT NOT NULL REFERENCES games(id),
 proposed_by TEXT NOT NULL REFERENCES users(id),
 base_revision INTEGER NOT NULL CHECK(base_revision>=0),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 validation_json TEXT NOT NULL CHECK(json_valid(validation_json)),
 status TEXT NOT NULL CHECK(status IN ('proposed','committed')),
 committed_event_id TEXT REFERENCES game_events(id),
 created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS expansion_proposals_by_game ON expansion_proposals(game_id,created_at);
