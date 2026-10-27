import { it, expect, vi } from 'vitest';
import { Memory } from '../src/memory.js';
import { RpgCore } from '../src/rpg/core.js';
import { seedSample } from '../src/rpg/sample.js';
import { campaignChapter } from '../src/rpg/campaign-sample.js';
async function setup() { const memory = new Memory(':memory:'); const core = new RpgCore(memory); const user = core.user('test', 'owner'); const f = await seedSample(core, user); return { memory, core, user, f }; }
async function propose(c: any, p: any, key = 'p') { return c.core.call('rpg_game_propose_expansion', c.user, { game_id: c.f.game_id, expected_revision: c.core.game(c.user, c.f.game_id).revision, idempotency_key: key, proposal: p }); }
async function commit(c: any, p: any, key = 'commit') { return c.core.call('rpg_game_commit_expansion', c.user, { game_id: c.f.game_id, proposal_id: p.proposal_id, expected_revision: c.core.game(c.user, c.f.game_id).revision, idempotency_key: key, acknowledge_semantic_limits: true }); }
async function act(c: any, action: any, key: string) { return c.core.call('rpg_game_act', c.user, { game_id: c.f.game_id, expected_revision: c.core.game(c.user, c.f.game_id).revision, idempotency_key: key, action: { actor_id: c.f.hero, ...action } }); }
it('same Game overlay grows without changing Release or spending a player turn; candidate canon and memory survive', async () => { const c = await setup(); try {
    const release = c.core.row('SELECT * FROM releases WHERE id=?', c.f.release_id);
    const p = await propose(c, campaignChapter(c.f, 1));
    expect(p.validation.valid).toBe(true);
    expect(c.core.game(c.user, c.f.game_id).revision).toBe(0);
    const r = await commit(c, p);
    expect(r).toMatchObject({ revision: 1, turn_seq: 0 });
    expect(c.core.game(c.user, c.f.game_id).release_id).toBe(c.f.release_id);
    expect(c.core.row('SELECT * FROM releases WHERE id=?', c.f.release_id)).toEqual(release);
    await act(c, { type: 'move', target_id: 'chapter1-city' }, 'move');
    const entities = await c.core.call('rpg_game_entities', c.user, { game_id: c.f.game_id, query: '안내인' });
    expect(entities.entities[0]).toMatchObject({ id: 'chapter1-guide', kind: 'npc' });
    const recall = await c.core.call('rpg_game_recall', c.user, { game_id: c.f.game_id, query: '변경 도시 1' });
    expect(recall.facts.length).toBeGreaterThan(0);
    expect(c.core.verify(c.user, c.f.game_id).verified).toBe(true);
}
finally {
    c.memory.close();
} });
it('different approved choices change trust and unlock different follow-up events', async () => { const pair = await Promise.all([setup(), setup()]); try {
    const results = [];
    for (const [i, c] of pair.entries()) {
        await commit(c, await propose(c, campaignChapter(c.f, 1)));
        await act(c, { type: 'move', target_id: 'chapter1-city' }, 'move');
        await act(c, { type: 'choose', params: { event_id: 'chapter1-decision', choice_id: i ? 'faith' : 'guild' } }, 'choice');
        results.push(await c.core.call('rpg_game_get_events', c.user, { game_id: c.f.game_id }));
    }
    expect(results[0].events.map((e: any) => e.id)).toEqual(['chapter1-guild']);
    expect(results[1].events.map((e: any) => e.id)).toEqual(['chapter1-faith']);
    expect(pair.map(c => JSON.parse(c.core.game(c.user, c.f.game_id).state_json).flags['chapter1.route'])).toEqual(['guild', 'faith']);
}
finally {
    pair.forEach(c => c.memory.close());
} });
it('consumed choices cannot be farmed with fresh keys; costs and canonical causal Evidence are atomic', async () => { const c = await setup(); try {
    await commit(c, await propose(c, campaignChapter(c.f, 1)));
    await act(c, { type: 'move', target_id: 'chapter1-city' }, 'move');
    const first = await act(c, { type: 'choose', params: { event_id: 'chapter1-decision', choice_id: 'guild' } }, 'one');
    await expect(act(c, { type: 'choose', params: { event_id: 'chapter1-decision', choice_id: 'faith' } }, 'fresh')).rejects.toMatchObject({ code: 'RULE_VIOLATION' });
    await act(c, { type: 'choose', params: { event_id: 'chapter1-guild', choice_id: 'supplies' } }, 'reward');
    await expect(act(c, { type: 'choose', params: { event_id: 'chapter1-guild', choice_id: 'supplies' } }, 'reward2')).rejects.toMatchObject({ code: 'RULE_VIOLATION' });
    const replay = await c.core.call('rpg_game_act', c.user, { game_id: c.f.game_id, expected_revision: 2, idempotency_key: 'one', action: { actor_id: c.f.hero, type: 'choose', params: { event_id: 'chapter1-decision', choice_id: 'guild' } } });
    expect(replay.event_id).toBe(first.event_id);
    const graph = await c.core.call('rpg_game_recall', c.user, { game_id: c.f.game_id, query: 'choose', strategy: 'causal' });
    expect(graph.retrieval.used).toBe('lexical+causal');expect(graph.retrieval.warnings.some((w:string)=>w.includes('PROVIDER_NOT_CONFIGURED'))).toBe(false);
        expect(graph.paths.some((p: any) => p.complete && p.relation_types.includes('causes'))).toBe(true);
    const edges = c.core.rows("SELECT metadata FROM links WHERE relation='causes'");
    expect(edges).toHaveLength(2);
    expect(edges.every(e => JSON.parse(e.metadata).evidence_ids.length === 1)).toBe(true);
    expect(c.core.verify(c.user, c.f.game_id).verified).toBe(true);
}
finally {
    c.memory.close();
} });
it('stale proposals, strangers and non-owner commits fail without publishing entities', async () => { const c = await setup(); try {
    const p = await propose(c, campaignChapter(c.f, 1));
    await act(c, { type: 'inspect', target_id: c.f.location_a }, 'inspect');
    await expect(commit(c, p)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    const other = c.core.user('test', 'other');
    await expect(c.core.call('rpg_game_review_expansion', other, { game_id: c.f.game_id, proposal_id: p.proposal_id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    c.core.db.prepare('INSERT INTO game_members VALUES(?,?,?,?)').run(c.f.game_id, other, 'player', null);
    const q = await propose(c, campaignChapter(c.f, 2), 'p2');
    await expect(c.core.call('rpg_game_commit_expansion', other, { game_id: c.f.game_id, proposal_id: q.proposal_id, expected_revision: 1, idempotency_key: 'hack', acknowledge_semantic_limits: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(JSON.parse(c.core.game(c.user, c.f.game_id).state_json).campaign).toBeUndefined();
}
finally {
    c.memory.close();
} });
it('rejects duplicate identity, dead-ID overwrite, wrong references, parent cycles and identical choice effects', async () => { const c = await setup(); try {
    const base = campaignChapter(c.f, 1);
    const bad: any[] = [];
    let p = structuredClone(base);
    p.entities[0].id = c.f.enemy;
    bad.push(p);
    p = structuredClone(base);
    p.entities.find(e => e.kind === 'npc')!.position_id = 'missing';
    bad.push(p);
    p = structuredClone(base);
    p.entities[0].parent_id = 'chapter1-dungeon';
    bad.push(p);
    p = structuredClone(base);
    p.events[0].choices[1].effects = structuredClone(p.events[0].choices[0].effects);
    bad.push(p);
    p = structuredClone(base);
    p.entities[3].name = p.entities[5].name;
    p.entities[3].kind = 'monster';
    bad.push(p);
    for (let i = 0; i < bad.length; i++) {
        const result = await propose(c, bad[i], `bad-${i}`);
        expect(result.validation.valid).toBe(false);
        await expect(commit(c, result, `commit-${i}`)).rejects.toMatchObject({ code: 'CANON_CONFLICT' });
    }
    expect(c.core.game(c.user, c.f.game_id).revision).toBe(0);
}
finally {
    c.memory.close();
} });
it('confirmed contradictions fail, unknown slots and different viewpoints may coexist', async () => { const c = await setup(); try {
    const p = { title: '기록', rationale: '기존 정보의 확실성을 기록한다.', facts: [{ subject_id: c.f.location_a, predicate: 'founder', value: null, status: 'unknown' }, { subject_id: c.f.location_a, predicate: 'founder', value: '첫 개척자', status: 'confirmed' }, { subject_id: c.f.location_a, predicate: 'founder', value: '다른 인물', status: 'belief', perspective_id: c.f.hero }] };
    expect((await commit(c, await propose(c, p))).revision).toBe(1);
    const conflict = await propose(c, { title: '충돌', rationale: '검증 테스트', facts: [{ subject_id: c.f.location_a, predicate: 'founder', value: '위조 인물', status: 'confirmed' }] }, 'conflict');
    expect(conflict.validation.valid).toBe(false);
    const field = await propose(c, { title: '부활 주장', rationale: '문장으로 상태를 바꾸려는 시도', facts: [{ subject_id: c.f.enemy, predicate: 'alive', value: true, status: 'confirmed' }] }, 'field');
    expect(field.validation.valid).toBe(false);
}
finally {
    c.memory.close();
} });
it('record failure rolls back expansion state, provenance and proposal status', async () => { const c = await setup(); try {
    const p = await propose(c, campaignChapter(c.f, 1));
    const original = c.memory.record.bind(c.memory);
    vi.spyOn(c.memory, 'record').mockImplementation(x => { original(x); throw new Error('injected'); });
    await expect(commit(c, p)).rejects.toThrow('injected');
    expect(c.core.game(c.user, c.f.game_id).revision).toBe(0);
    expect(c.core.row('SELECT status FROM expansion_proposals WHERE id=?', p.proposal_id).status).toBe('proposed');
    expect(c.core.row('SELECT count(*) n FROM game_events').n).toBe(0);
    expect(c.core.row('SELECT count(*) n FROM memories').n).toBe(0);
}
finally {
    vi.restoreAllMocks();
    c.memory.close();
} });
it('constitution forbids a city in a declared settlement-free region; rumors do not overrule canon', async () => { const c = await setup(); try {
    await commit(c, await propose(c, { title: '정착 규칙', rationale: '이 지역의 확정된 제한', facts: [{ subject_id: c.f.location_a, predicate: 'settlements', status: 'confirmed', value: 'forbidden' }] }));
    const p = campaignChapter(c.f, 1);
    p.entities[0].parent_id = c.f.location_a;
    expect((await propose(c, p, 'forbidden')).validation.valid).toBe(false);
    const rumor = await propose(c, { title: '소문', rationale: '주민에게서 들은 미확인 진술', facts: [{ subject_id: c.f.location_a, predicate: 'settlements', status: 'rumor', value: 'allowed', perspective_id: c.f.hero }] }, 'rumor');
    expect(rumor.validation.valid).toBe(true);
}
finally {
    c.memory.close();
} });
it('canonical public identities cannot be overwritten by changing npc to person', async () => { const c = await setup(); try {
    await commit(c, await propose(c, campaignChapter(c.f, 1)));
    const next = campaignChapter(c.f, 2);
    const npc = next.entities.find(e => e.kind === 'npc')!;
    npc.kind = 'person';
    npc.name = '안내인 1';
    expect((await propose(c, next, 'same-person')).validation.valid).toBe(false);
}
finally {
    c.memory.close();
} });
it('isolated new regions, event prerequisite deadlocks and prototype-shaped flag keys are rejected', async () => { const c = await setup(); try {
    const isolated = campaignChapter(c.f, 1);
    isolated.entities[0].connections = ['chapter1-dungeon'];
    isolated.entities.find(e => e.kind === 'dungeon')!.parent_id = 'chapter1-city';
    expect((await propose(c, isolated, 'isolated')).validation.valid).toBe(false);
    const cycle = campaignChapter(c.f, 1);
    cycle.events[0].conditions.push({ type: 'event_resolved', event_id: 'chapter1-guild' });
    expect((await propose(c, cycle, 'cycle')).validation.valid).toBe(false);
    const key = campaignChapter(c.f, 1);
    key.events[0].choices[0].effects = [{ type: 'flag', key: '__proto__', value: 'pollute' }];
    await expect(propose(c, key, 'prototype')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
}
finally {
    c.memory.close();
} });
