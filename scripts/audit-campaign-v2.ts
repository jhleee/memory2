import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Memory } from '../src/memory.js';
import { RpgCore } from '../src/rpg/core.js';
import { hash } from '../src/rpg/contracts.js';
const report = JSON.parse(readFileSync('docs/campaign-v2-results.json', 'utf8'));
if (report.mode !== 'live' || !report.finished_at)
    throw new Error('Completed live evaluation required');
const prior = JSON.parse(readFileSync('docs/longplay-results.json', 'utf8'));
const audit: any = { run_id: report.run_id, at: new Date().toISOString(), games: [], errors: [], model_requests: report.calls.length, model_errors: report.calls.filter((c: any) => c.http_status !== 200).length, reported_cost_usd: report.total_reported_cost, missing_usage: report.calls.filter((c: any) => !c.usage).length };
for (const condition of report.design.conditions) {
    const m = new Memory(resolve('evaluation/campaign-v2', report.run_id, `${condition}.db`));
    try {
        const core = new RpgCore(m);
        for (const c of prior.campaigns) {
            const gid = c.fixture.game_id;
            const initial = core.row('SELECT * FROM game_snapshots WHERE game_id=? AND seq=0', gid);
            let state = JSON.parse(initial.state_json), seq = 0;
            const errors: any[] = [];
            const snapshots = core.rows('SELECT * FROM game_snapshots WHERE game_id=?', gid);
            const bySeq = new Map(snapshots.map(s => [s.seq, s]));
            if (hash(state) !== initial.state_hash)
                errors.push('initial hash');
            for (const event of core.rows('SELECT * FROM game_events WHERE game_id=? ORDER BY seq', gid)) {
                const patch = JSON.parse(event.patch_json);
                if (event.seq !== ++seq || hash(state) !== event.before_hash || patch.length !== 1 || patch[0].path !== '' || hash(patch[0].before) !== hash(state))
                    errors.push({ seq: event.seq, phase: 'before' });
                state = patch[0].after;
                if (hash(state) !== event.after_hash)
                    errors.push({ seq, phase: 'after' });
                const snap = bySeq.get(seq);
                if (snap && (hash(JSON.parse(snap.state_json)) !== snap.state_hash || hash(state) !== snap.state_hash))
                    errors.push({ seq, phase: 'snapshot' });
            }
            const game = core.game(c.user, gid);
            if (hash(state) !== hash(JSON.parse(game.state_json)))
                errors.push('current mismatch');
            const links = core.rows('SELECT gm.event_id,m.space_id,e.metadata FROM game_event_memories gm JOIN memories m ON m.id=gm.memory_id JOIN evidence e ON m.source_id=e.id WHERE gm.game_id=?', gid);
            if (links.length !== seq || links.some(l => l.space_id !== `game:${gid}` || JSON.parse(l.metadata).event_id !== l.event_id))
                errors.push('provenance');
            const defs = state.campaign?.events ?? {};
            const histories = state.campaign?.history ?? [];
            const historyErrors = histories.filter((h: any) => !core.row('SELECT 1 FROM game_events WHERE id=? AND game_id=?', h.source_event_id, gid));
            if (historyErrors.length)
                errors.push('story source');
            const semanticSignatures = report.sessions.filter((s: any) => s.condition === condition && s.persona === c.persona).flatMap((s: any) => s.actions.map((a: any) => hash({ hero: a.after.hero_hp, potions: a.after.potions, enemy: a.after.enemy_hp, position: a.after.location_id, flags: a.after.flags })));
            const facts = state.campaign?.facts ?? [];
            audit.games.push({ condition, persona: c.persona, game_id: gid, release_id: game.release_id, same_release: game.release_id === c.fixture.release_id, all_events_replayed: seq, new_events: seq - 320, snapshots: snapshots.length, provenance_links: links.length, errors, overlay_entities: Object.keys(state.campaign?.entities ?? {}).length, story_definitions: Object.keys(defs).length, resolved_story_choices: histories.length, completed_threads: Object.values(state.campaign?.threads ?? {}).filter((t: any) => t.status === 'completed').length, active_fact_count: facts.filter((f: any) => f.valid_to === null).length, distinct_operational_state_signatures: new Set(semanticSignatures).size, action_count: semanticSignatures.length, unique_state_note: 'Operational HP, inventory, location, flags only; source IDs, overlay growth, uses and history excluded' });
            audit.errors.push(...errors.map(error => ({ condition, persona: c.persona, error })));
        }
    }
    finally {
        m.close();
    }
}
audit.valid_ratings = report.sessions.filter((s: any) => s.rating && ['boredom_1_to_5', 'play_interest_1_to_5', 'agency_1_to_5', 'causal_consistency_1_to_5'].every(k => typeof s.rating[k] === 'number' && s.rating[k] >= 1 && s.rating[k] <= 5)).length;
writeFileSync('docs/campaign-v2-audit.json', JSON.stringify(audit, null, 2) + '\n');
console.log(JSON.stringify(audit, null, 2));
