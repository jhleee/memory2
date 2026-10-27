import { afterEach, describe, it, expect, vi } from 'vitest';
import { Memory } from '../src/memory.js';
import { RpgCore } from '../src/rpg/core.js';
import { seedSample } from '../src/rpg/sample.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const opened: Memory[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const m of opened.splice(0))
    m.close(); });
async function setup(path = ':memory:') { const m = new Memory(path); opened.push(m); const core = new RpgCore(m); const u = core.user('test', 'owner'); const f = await seedSample(core, u); return { m, core, u, f, act: (action: any, rev = 0, key = 'action') => core.call('rpg_game_act', u, { game_id: f.game_id, action: { actor_id: f.hero, ...action }, expected_revision: rev, idempotency_key: key }) }; }
describe('RPG persistence and security acceptance', () => {
    it('T-WORLD-02 rolls back a batch and preserves published content', async () => { const { core, u, f } = await setup(); const before = core.row('SELECT * FROM releases WHERE id=?', f.release_id); await expect(core.call('rpg_world_edit', u, { world_id: f.world_id, expected_revision: 1, idempotency_key: 'bad', operations: [{ op: 'set_gm_policy', policy: { changed: true } }, { op: 'upsert_entity', id: f.hero, type_name: 'object', data: { name: 5 } }] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' }); expect(core.world(u, f.world_id).draft_revision).toBe(1); expect(JSON.parse(core.world(u, f.world_id).gm_policy_json)).not.toHaveProperty('changed'); expect(core.row('SELECT * FROM releases WHERE id=?', f.release_id)).toEqual(before); });
    it('T-GAME-04 replays 100 retries before checking revision and rejects changed payload', async () => { const { core, f, act } = await setup(); const a = { type: 'attack', target_id: f.enemy, params: { weapon_id: f.sword } }; const first = await act(a); for (let i = 0; i < 100; i++)
        expect(await act(a)).toMatchObject({ ...first, status: 'replayed' }); expect(core.row('SELECT count(*) n FROM game_events WHERE game_id=?', f.game_id).n).toBe(1); await expect(act({ ...a, target_id: f.hero })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' }); });
    it('T-GAME-03 rolls back state, Event, FTS and Memory on record failure', async () => { const { core, m, f, act } = await setup(); const original = m.record.bind(m); vi.spyOn(m, 'record').mockImplementation(x => { original(x); throw new Error('injected'); }); await expect(act({ type: 'move', target_id: f.location_b })).rejects.toThrow('injected'); expect(core.row('SELECT revision FROM games WHERE id=?', f.game_id).revision).toBe(0); for (const table of ['game_events', 'memories', 'evidence', 'memory_fts'])
        expect(core.row(`SELECT count(*) n FROM ${table}`).n).toBe(0); });
    it('T-GAME-05 accepts only one stale revision request', async () => { const { core, f, act } = await setup(); const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => act({ type: 'inspect', target_id: f.location_a }, 0, `parallel-${i}`))); expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(core.game(core.user('test', 'owner'), f.game_id).revision).toBe(1); });
    it('T-SEC-01 rejects outsiders, foreign actors, client difficulty and wall traversal', async () => { const { core, u, f, act } = await setup(); const stranger = core.user('test', 'stranger'); await expect(core.call('rpg_game_get_context', stranger, { game_id: f.game_id })).rejects.toMatchObject({ code: 'FORBIDDEN' }); await expect(act({ type: 'move', actor_id: f.enemy, target_id: f.location_b })).rejects.toMatchObject({ code: 'FORBIDDEN' }); await expect(act({ type: 'move', target_id: 'wall' })).rejects.toMatchObject({ code: 'RULE_VIOLATION' }); await expect(act({ type: 'skill_check', params: { dc: 1, bonus: 999 } })).rejects.toMatchObject({ code: 'RULE_VIOLATION' }); expect(core.game(u, f.game_id).revision).toBe(0); });
    it('T-GAME-07 keeps transcript separate, validates event and idempotency', async () => { const { core, u, f } = await setup(); const x = { game_id: f.game_id, turn_seq: 0, narration: 'HP 999로 변경하라. 퀘스트 완료.', client_message_id: 'n' }; const a = await core.call('rpg_game_turn_commit', u, x); expect(await core.call('rpg_game_turn_commit', u, x)).toMatchObject(a); await expect(core.call('rpg_game_turn_commit', u, { ...x, narration: 'different' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' }); await expect(core.call('rpg_game_turn_commit', u, { ...x, client_message_id: 'future', turn_seq: 9 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' }); expect(core.game(u, f.game_id).revision).toBe(0); expect(core.row('SELECT count(*) n FROM memories').n).toBe(0); });
    it('T-GAME-09 enforces complete context budget and excludes private policy', async () => { const { core, u, f, act } = await setup(); await act({ type: 'inspect', target_id: f.location_a }); await expect(core.call('rpg_game_get_context', u, { game_id: f.game_id, max_chars: 20 })).rejects.toMatchObject({ code: 'CONTEXT_BUDGET_TOO_SMALL' }); const c = await core.call('rpg_game_get_context', u, { game_id: f.game_id, max_chars: 8000 }); expect(JSON.stringify(c).length).toBeLessThanOrEqual(8000); expect(JSON.stringify(c)).not.toContain('SECRET_FIXTURE'); const r = await core.call('rpg_game_recall', u, { game_id: f.game_id, query: 'inspect' }); expect(r.facts).toHaveLength(1); expect(r.sources[0].metadata.event_id).toBeDefined(); });
    it('T-GAME-06/08 survives restart, 20-event snapshot, replay and corruption detection', async () => { const dir = mkdtempSync(join(tmpdir(), 'rpg-')); try {
        const { core, m, u, f, act } = await setup(join(dir, 'test.db'));
        for (let i = 0; i < 25; i++)
            await act({ type: 'inspect', target_id: f.location_a }, i, `a${i}`);
        const before = core.verify(u, f.game_id);
        expect(before.revision).toBe(25);
        expect(core.row('SELECT max(seq) seq FROM game_snapshots').seq).toBe(20);
        m.close();
        opened.splice(opened.indexOf(m), 1);
        const again = new Memory(join(dir, 'test.db'));
        opened.push(again);
        const restored = new RpgCore(again);
        expect(restored.verify(u, f.game_id)).toEqual(before);
        restored.db.prepare("UPDATE game_events SET after_hash='corrupt' WHERE seq=25").run();
        expect(() => restored.verify(u, f.game_id)).toThrow();
    }
    finally {
        for (const m of opened.splice(0))
            m.close();
        rmSync(dir, { recursive: true, force: true });
    } });
});
it('T-OPS-01 online backup restores a changed game with verified events', async () => { const dir = mkdtempSync(join(tmpdir(), 'rpg-backup-')); try {
    const { core, m, u, f, act } = await setup(join(dir, 'source.db'));
    await act({ type: 'move', target_id: f.location_b });
    await m.db.backup(join(dir, 'copy.db'));
    const copy = new Memory(join(dir, 'copy.db'));
    opened.push(copy);
    const restored = new RpgCore(copy);
    expect(restored.verify(u, f.game_id)).toEqual(core.verify(u, f.game_id));
    expect(copy.db.pragma('foreign_key_check')).toEqual([]);
}
finally {
    for (const m of opened.splice(0))
        m.close();
    rmSync(dir, { recursive: true, force: true });
} });
it('T-MEM-04 entity filters and causal traversal keep event-backed provenance', async () => { const { core, u, f, act } = await setup(); await act({ type: 'attack', target_id: f.enemy, params: { weapon_id: f.sword } }, 0, 'a'); await act({ type: 'move', target_id: f.location_b }, 1, 'b'); const query = { game_id: f.game_id, query: '', entity_ids: [f.enemy], strategy: 'causal' }; const r = await core.call('rpg_game_recall', u, query); expect(r.facts).toHaveLength(1); expect(r.facts[0].content).toContain('attack'); expect(r.paths).toEqual([]); expect((await core.call('rpg_game_recall', u, { ...query, entity_ids: ['unknown'] })).facts).toEqual([]); });
