import { it, expect } from 'vitest';
import { Memory } from '../src/memory.js';
it('T-MEM-02 preserves eight-hop direction, types, evidence, cycle and space isolation', () => { const m = new Memory(':memory:'); try {
    const r = m.record({ space_id: 's', evidence: { source_type: 'test', content: 'source' }, memories: Array.from({ length: 9 }, (_, i) => ({ id: `m${i}`, kind: 'event', content: `event ${i}` })) });
    for (let i = 0; i < 8; i++)
        m.db.prepare('INSERT INTO links(space_id,from_type,from_id,relation,to_type,to_id,metadata) VALUES(?,?,?,?,?,?,?)').run('s', 'memory', `m${i}`, 'causes', 'memory', `m${i + 1}`, JSON.stringify({ evidence_ids: [r.evidence_id] }));
    m.db.prepare("INSERT INTO links(space_id,from_type,from_id,relation,to_type,to_id) VALUES('s','memory','m8','causes','memory','m0')").run();
    const x = { space_id: 's', start: { id: 'm0', type: 'memory' as const }, direction: 'outbound' as const, relations: ['causes'], max_depth: 8, max_paths: 30 };
    const path = m.findPath({ ...x, end: { id: 'm8', type: 'memory' } });
    expect(path.paths[0].edges).toHaveLength(8);
    expect(path.paths[0].edges[0].evidence_ids).toEqual([r.evidence_id]);
    expect(m.traverse({ ...x, relations: ['related_to'] }).paths).toEqual([]);
    expect(m.traverse({ ...x, space_id: 'other' }).paths).toEqual([]);
    m.forget({ space_id: 's', memory_id: 'm4' });
    expect(m.findPath({ ...x, end: { id: 'm8', type: 'memory' } }).paths).toEqual([]);
}
finally {
    m.close();
} });
it('T-MEM-03 finds normalized aliases and never merges unknown NPCs', () => { const m = new Memory(':memory:'); try {
    m.record({ space_id: 's', evidence: { source_type: 'test', content: 'source' }, entities: [{ id: 'e', name: 'Captain', metadata: { aliases: ['ＡＬＩＣＥ'], type: 'npc' } }], memories: [{ kind: 'mention', content: 'unknown' }] });
    expect(m.searchEntityCandidates({ space_id: 's', mention: 'alice' }).candidates[0].entity_id).toBe('e');
    expect(m.searchEntityCandidates({ space_id: 's', mention: 'new NPC' }).candidates).toEqual([]);
    expect(m.searchEntityCandidates({ space_id: 'x', mention: 'alice' }).candidates).toEqual([]);
}
finally {
    m.close();
} });
