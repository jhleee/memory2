import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Memory } from '../src/memory.js';
import { gameplayQueryInput, loadGameplayFixture, scoreGameplay, seedGameplay, validateGoldenGraph } from '../scripts/gameplay-benchmark-lib.js';
import type { GameplayFixture, GameplayQuery } from '../scripts/gameplay-benchmark-lib.js';

const opened: Memory[] = [];
afterEach(() => { for (const memory of opened.splice(0)) memory.close(); });
function memory(path = ':memory:'): Memory {
  const instance = new Memory(path);
  opened.push(instance);
  return instance;
}
function entityCount(instance: Memory, space: string): number {
  return (instance.db.prepare('SELECT COUNT(*) n FROM entities WHERE space_id=?').get(space) as { n: number }).n;
}
function mentionInput(space_id: string, content = 'the person in a green coat') {
  return {
    space_id,
    evidence: { source_type: 'test', content },
    memories: [{ id: 'mention_green', kind: 'mention', content, data: { description: 'green coat' }, resolution: 'unresolved' as const }],
  };
}

describe('Entity lifecycle acceptance', () => {
  it('persists a generated Entity ID and does not infer an Entity from a Mention', () => {
    const m = memory();
    const entityResult = m.record({
      space_id: 'entities', evidence: { source_type: 'test', content: 'Create a person record.' },
      entities: [{ name: 'Ria' }], memories: [{ kind: 'note', content: 'Ria is a participant.' }],
    });
    expect(entityResult.entity_ids).toHaveLength(1);
    const entityId = entityResult.entity_ids[0]!;
    expect(entityId).toBeTruthy();
    expect(m.db.prepare('SELECT id,name FROM entities WHERE id=?').get(entityId)).toMatchObject({ id: entityId, name: 'Ria' });

    m.record(mentionInput('entities', 'Ria, the person in a green coat, entered the room.'));
    expect(entityCount(m, 'entities')).toBe(1);
    expect(m.db.prepare("SELECT kind,resolution FROM memories WHERE id='mention_green'").get()).toMatchObject({ kind: 'mention', resolution: 'unresolved' });
    expect(m.db.prepare("SELECT COUNT(*) n FROM links WHERE from_id='mention_green' AND to_type='entity'").get()).toMatchObject({ n: 0 });
  });

  it('keeps same-name Entity IDs separate and persists an unknown field without creating a phantom Entity', () => {
    const m = memory();
    const first = m.record({ space_id: 'names', evidence: { source_type: 'test', content: 'First Ria.' }, entities: [{ name: 'Ria' }], memories: [{ kind: 'note', content: 'First Ria record.' }] });
    const second = m.record({ space_id: 'names', evidence: { source_type: 'test', content: 'Second Ria.' }, entities: [{ name: 'Ria' }], memories: [{ kind: 'note', content: 'Second Ria record.' }] });
    expect(first.entity_ids[0]).not.toBe(second.entity_ids[0]);
    m.record({ space_id: 'names', evidence: { source_type: 'test', content: 'Unknown recipient.' }, memories: [{ kind: 'event', content: 'Someone passed a key to an unknown person.', data: { recipient: { state: 'unknown' } } }] });
    expect(entityCount(m, 'names')).toBe(2);
    expect(m.db.prepare("SELECT COUNT(*) n FROM entities WHERE name='unknown'").get()).toMatchObject({ n: 0 });
  });

  it('resolves a Mention explicitly while preserving its original content and data', () => {
    const m = memory();
    const entity = m.record({ space_id: 'resolve', evidence: { source_type: 'test', content: 'Entity evidence.' }, entities: [{ id: 'ria', name: 'Ria' }], memories: [{ kind: 'note', content: 'Entity record.' }] });
    const mention = m.record(mentionInput('resolve'));
    m.resolveMention({ space_id: 'resolve', mention_id: mention.memory_ids[0]!, entity_id: entity.entity_ids[0]! });
    expect(m.db.prepare("SELECT kind,content,data,resolution FROM memories WHERE id='mention_green'").get()).toMatchObject({ kind: 'mention', content: 'the person in a green coat', data: JSON.stringify({ description: 'green coat' }), resolution: 'resolved' });
    expect(m.db.prepare("SELECT relation,to_id FROM links WHERE from_id='mention_green' AND active=1").get()).toMatchObject({ relation: 'mentions', to_id: 'ria' });
  });

  it('rejects a cross-space Entity link and rolls back the attempted record', () => {
    const m = memory();
    m.record({ space_id: 'home', evidence: { source_type: 'test', content: 'Entity evidence.' }, entities: [{ id: 'private_entity', name: 'Private' }], memories: [{ kind: 'note', content: 'Private record.' }] });
    expect(() => m.record({
      space_id: 'other', evidence: { source_type: 'test', content: 'Attempted link.' },
      memories: [{ id: 'bad_link_memory', kind: 'note', content: 'Must roll back.' }],
      links: [{ from: { id: 'bad_link_memory', type: 'memory' }, relation: 'about', to: { id: 'private_entity', type: 'entity' } }],
    })).toThrow();
    expect(m.db.prepare("SELECT COUNT(*) n FROM spaces WHERE id='other'").get()).toMatchObject({ n: 0 });
    expect(m.db.prepare("SELECT COUNT(*) n FROM memories WHERE id='bad_link_memory'").get()).toMatchObject({ n: 0 });
  });

  it('rejects unknown Entity references without synthesizing them', () => {
    const m = memory();
    expect(() => m.record({
      space_id: 'invalid-ref', evidence: { source_type: 'test', content: 'Invalid reference.' },
      memories: [{ kind: 'note', content: 'Reference to absent ID.', entity_ids: ['not-created'] }],
    })).toThrow();
    expect(entityCount(m, 'invalid-ref')).toBe(0);
    expect(m.db.prepare('SELECT COUNT(*) n FROM evidence').get()).toMatchObject({ n: 0 });
  });

  it('does not create duplicate Entities when an idempotent record is replayed', () => {
    const m = memory();
    const payload = {
      space_id: 'idempotent-entity', idempotency_key: 'same-request',
      evidence: { source_type: 'test', content: 'Entity and memory.' },
      entities: [{ id: 'stable_entity', name: 'Ria' }], memories: [{ id: 'stable_memory', kind: 'note', content: 'Ria is here.' }],
    };
    const first = m.record(payload);
    const replay = m.record(payload);
    expect(replay.replayed).toBe(true);
    expect(replay.entity_ids).toEqual(first.entity_ids);
    expect(entityCount(m, 'idempotent-entity')).toBe(1);
  });

  it('preserves resolved Entity and Mention links across database restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'entity-restart-'));
    const path = join(directory, 'memory.db');
    let m = memory(path);
    m.record({ space_id: 'restart', evidence: { source_type: 'test', content: 'Entity record.' }, entities: [{ id: 'persisted_ria', name: 'Ria' }], memories: [{ kind: 'note', content: 'Ria is an Entity.' }] });
    m.record(mentionInput('restart'));
    m.resolveMention({ space_id: 'restart', mention_id: 'mention_green', entity_id: 'persisted_ria' });
    m.close();
    opened.splice(opened.indexOf(m), 1);
    m = memory(path);
    expect(m.db.prepare("SELECT name FROM entities WHERE id='persisted_ria'").get()).toMatchObject({ name: 'Ria' });
    expect(m.db.prepare("SELECT resolution,content FROM memories WHERE id='mention_green'").get()).toMatchObject({ resolution: 'resolved', content: 'the person in a green coat' });
    expect(m.db.prepare("SELECT COUNT(*) n FROM links WHERE from_id='mention_green' AND to_id='persisted_ria' AND active=1").get()).toMatchObject({ n: 1 });
    rmSync(directory, { recursive: true, force: true });
  });
});


describe('authored gameplay graph benchmark', () => {
  async function fixture(): Promise<GameplayFixture> {
    return loadGameplayFixture(resolve(process.cwd(), 'evaluation/gameplay-graph.fixture.json'));
  }

  it('loads and seeds a valid directed golden graph with long causal chains', async () => {
    const f = await fixture();
    const m = memory();
    const seeded = seedGameplay(m, f);
    expect(f.queries.length).toBeGreaterThanOrEqual(24);
    expect(seeded.memories).toBeGreaterThan(0);
    expect(() => validateGoldenGraph(m, f)).not.toThrow();
    const longCausalChains = f.queries
      .filter((query) => query.category === 'causal')
      .flatMap((query) => query.expected_paths ?? [])
      .filter((path) => path.nodes.length >= 4 && path.relations.length >= 3 && path.relations.every((relation) => relation === 'causes' || relation === 'enables'));
    expect(longCausalChains.length).toBeGreaterThanOrEqual(3);
    const links = m.db.prepare('SELECT space_id,from_type,from_id,to_type,to_id FROM links WHERE active=1').all() as { space_id: string; from_type: string; from_id: string; to_type: string; to_id: string }[];
    const tables: Record<string, string> = { memory: 'memories', entity: 'entities', evidence: 'evidence' };
    for (const link of links) {
      expect(['memory', 'entity', 'evidence']).toContain(link.from_type);
      expect(['memory', 'entity', 'evidence']).toContain(link.to_type);
      expect(m.db.prepare(`SELECT 1 FROM ${tables[link.from_type]} WHERE id=? AND space_id=?`).get(link.from_id, link.space_id)).toBeTruthy();
      expect(m.db.prepare(`SELECT 1 FROM ${tables[link.to_type]} WHERE id=? AND space_id=?`).get(link.to_id, link.space_id)).toBeTruthy();
    }
    const decoyCount = (m.db.prepare("SELECT COUNT(*) n FROM memories WHERE space_id<>'game-main'").get() as { n: number }).n;
    expect(decoyCount).toBeGreaterThan(0);
  });

  it('evaluates every query through baseline lexical recall and keeps scope and state safe', async () => {
    const f = await fixture();
    const m = memory();
    seedGameplay(m, f);
    const totalChanges = (m.db.prepare('SELECT total_changes() n').get() as { n: number }).n;
    for (const query of f.queries) {
      const input = gameplayQueryInput(f, query, 'lexical');
      const result = m.recall(input);
      expect(result.items.every((item) => item.space_id === f.space_id && item.lifecycle === 'active'), query.id).toBe(true);
      const score = scoreGameplay(m, query, result);
      expect(score).toMatchObject({ query_id: query.id, category: query.category, scoped_active: true });
      expect(score.support_recall).toBeGreaterThanOrEqual(0);
      expect(score.support_recall).toBeLessThanOrEqual(1);
    }
    expect((m.db.prepare('SELECT total_changes() n').get() as { n: number }).n).toBe(totalChanges);
  });

  it('scores a mocked result built from real core candidate IDs and marks a missing path middle node incomplete', async () => {
    const f = await fixture();
    const m = memory();
    seedGameplay(m, f);
    const query = f.queries.find((candidate) => candidate.expected_paths?.some((path) => path.nodes.length >= 3));
    expect(query).toBeTruthy();
    const path = query!.expected_paths!.find((candidate) => candidate.nodes.length >= 3)!;
    const missingMiddle = path.nodes[Math.floor(path.nodes.length / 2)]!;
    const selectedIds = new Set([...query!.expected_support_ids, ...path.nodes].filter((id) => id !== missingMiddle));
    const mockResult = m.recall({ space_id: f.space_id, candidate_ids: [...selectedIds], limit: 100 });
    const score = scoreGameplay(m, query!, mockResult);
    expect(score.directed_paths_total).toBeGreaterThan(0);
    expect(score.directed_paths_complete).toBe(0);
    expect(score.support_complete).toBe(query!.expected_support_ids.every((id) => id !== missingMiddle));
  });

  it('rejects a missing golden support ID and a reversed golden edge', async () => {
    const f = await fixture();
    const m = memory();
    seedGameplay(m, f);
    const query = f.queries.find((candidate) => candidate.expected_paths?.length);
    expect(query).toBeTruthy();
    const missingId = structuredClone(f);
    const missingQuery = missingId.queries.find((candidate) => candidate.id === query!.id)!;
    missingQuery.expected_support_ids.push('gold_id_does_not_exist');
    expect(() => validateGoldenGraph(m, missingId)).toThrow(/absent|missing/i);

    const reversed = structuredClone(f);
    const reversedQuery = reversed.queries.find((candidate) => candidate.id === query!.id)!;
    const path = reversedQuery.expected_paths![0]!;
    path.nodes.reverse();
    path.relations.reverse();
    expect(() => validateGoldenGraph(m, reversed)).toThrow(/missing directed/i);
  });

  it('rejects an unrelated relation in a causal golden path during fixture loading', async () => {
    const f = await fixture();
    const causalQuery = f.queries.find((query) => query.category === 'causal' && query.expected_paths?.length);
    expect(causalQuery).toBeTruthy();
    const invalid = structuredClone(f);
    const query = invalid.queries.find((candidate) => candidate.id === causalQuery!.id)!;
    query.expected_paths![0]!.relations[0] = 'related_to';
    const directory = mkdtempSync(join(tmpdir(), 'invalid-gameplay-fixture-'));
    const path = join(directory, 'invalid.json');
    try {
      writeFileSync(path, JSON.stringify(invalid));
      await expect(loadGameplayFixture(path)).rejects.toThrow(/causal|causes|enables/i);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
