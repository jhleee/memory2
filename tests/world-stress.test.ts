import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Memory } from '../src/memory.js';
import { buildWorldStressFixture } from '../scripts/world-stress-fixture.js';
import { buildWorldContextProbe } from '../scripts/world-context-probes.js';
import { gameplayQueryInput, scoreGameplay, validateGoldenGraph } from '../scripts/gameplay-benchmark-lib.js';
import type { GameplayQuery } from '../scripts/gameplay-benchmark-lib.js';
import type { WorldStressFixture } from '../scripts/world-stress-fixture.js';

let fixture: WorldStressFixture;
let memory: Memory;
beforeAll(() => {
  fixture = buildWorldStressFixture({ size: 4096, seed: 73 });
  memory = new Memory(':memory:');
  seedSequentially(memory, fixture);
});
afterAll(() => memory?.close());
function goldenSignature(fixture: WorldStressFixture): unknown {
  return fixture.queries.map((query) => ({ id: query.id, category: query.category, support: query.expected_support_ids, paths: query.expected_paths ?? [] }));
}
function mainOriginalCount(fixture: WorldStressFixture): number {
  const sessionCount = fixture.sessions.flatMap((session) => session.records)
    .filter((input) => input.space_id === fixture.space_id)
    .reduce((total, input) => total + input.memories.length, 0);
  const operationRecords = (fixture.operations ?? []).flatMap((operation) => operation.type === 'record' ? [operation.input] : [])
    .filter((input) => input.space_id === fixture.space_id)
    .reduce((total, input) => total + input.memories.length, 0);
  return sessionCount + operationRecords;
}
function correctionCount(fixture: WorldStressFixture): number {
  return (fixture.operations ?? []).filter((operation) => operation.type === 'correct' && operation.input.space_id === fixture.space_id).length;
}
function seedSequentially(memory: Memory, fixture: WorldStressFixture): void {
  for (const session of fixture.sessions) for (const input of session.records) memory.record(input);
  for (const operation of fixture.operations ?? []) {
    switch (operation.type) {
      case 'record': memory.record(operation.input); break;
      case 'correct': memory.correct(operation.input); break;
      case 'forget': memory.forget(operation.input); break;
      case 'resolve': memory.resolveMention(operation.input); break;
    }
  }
}
function totalChanges(memory: Memory): number {
  return (memory.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
}
function normalizedTime(value: string): number {
  return Date.parse(value.length === 10 ? `${value}T00:00:00.000Z` : value);
}
function isCausalQuery(query: GameplayQuery): boolean { return query.category === 'causal'; }

describe('generated world stress fixture', () => {
  it('is deterministic across repeated generation and keeps the same authored gold across scales', () => {
    const smallA = buildWorldStressFixture({ size: 256, seed: 73 });
    const smallB = buildWorldStressFixture({ size: 256, seed: 73 });
    const medium = buildWorldStressFixture({ size: 1024, seed: 73 });
    const large = buildWorldStressFixture({ size: 4096, seed: 73 });
    expect(smallA).toEqual(smallB);
    expect(goldenSignature(medium)).toEqual(goldenSignature(smallA));
    expect(goldenSignature(large)).toEqual(goldenSignature(smallA));
    expect(mainOriginalCount(smallA)).toBe(256);
    expect(mainOriginalCount(medium)).toBe(1024);
    expect(mainOriginalCount(large)).toBe(4096);
    expect(large.generation.main_original_memories).toBe(4096);
    expect(large.generation.distractor_memories).toBe(4096 - large.generation.authored_story_memories - 1);
  });

  it('seeds 4096 original memories through the sequential public API and validates gold after operations', () => {
    validateGoldenGraph(memory, fixture);
    const mainCount = (memory.db.prepare('SELECT COUNT(*) n FROM memories WHERE space_id=?').get(fixture.space_id) as { n: number }).n;
    expect(mainCount).toBe(4096 + correctionCount(fixture));
    expect(mainOriginalCount(fixture)).toBe(4096);
    expect(fixture.generation.main_original_memories).toBe(4096);
    const distractors = memory.db.prepare("SELECT m.id,m.content,m.data,e.content AS source FROM memories m JOIN evidence e ON e.id=m.source_id WHERE m.space_id=? AND m.id LIKE 'world_distractor_memory_%' ORDER BY m.id").all(fixture.space_id) as { id: string; content: string; data: string; source: string }[];
    expect(distractors).toHaveLength(fixture.generation.distractor_memories);
    expect(distractors[0]?.id).toBe('world_distractor_memory_00000');
    expect(distractors[0]?.content).toMatch(/(관측소|운송대|회의록|수문 옆|기록원|순찰 보고서|주민|의 .*약속)/);
    expect(distractors[0]?.source).toContain(distractors[0]!.content);
    expect(JSON.parse(distractors[0]!.data)).toHaveProperty('distractor_index', 0);
    const entityIdsBySession = new Map<string, Set<string>>();
    for (const session of fixture.sessions) {
      const ids = new Set<string>();
      for (const prior of fixture.sessions.slice(0, fixture.sessions.indexOf(session) + 1)) {
        for (const record of prior.records) for (const entity of record.entities ?? []) if (entity.id) ids.add(entity.id);
      }
      entityIdsBySession.set(session.id, ids);
    }
    for (const decision of fixture.entity_decisions) {
      const available = entityIdsBySession.get(decision.as_of_session);
      expect(available, decision.id).toBeTruthy();
      for (const candidateId of decision.candidate_entity_ids) expect(available!.has(candidateId), `${decision.id}: ${candidateId} must exist at ${decision.as_of_session}`).toBe(true);
      if (decision.expected_entity_id) expect(available!.has(decision.expected_entity_id)).toBe(true);
    }
    for (const query of fixture.queries.filter(isCausalQuery)) {
      for (const path of query.expected_paths ?? []) {
        expect(path.nodes.length).toBeGreaterThanOrEqual(2);
        expect(path.relations).toHaveLength(path.nodes.length - 1);
        expect(path.relations.every((relation) => relation === 'causes' || relation === 'enables')).toBe(true);
      }
    }
    const chains = fixture.queries.filter(isCausalQuery).flatMap((query) => query.expected_paths ?? []).filter((path) => path.nodes.length > 8);
    const distinctChains = new Set(chains.map((path) => path.nodes.join('->')));
    expect(distinctChains.size).toBeGreaterThanOrEqual(4);
    expect(fixture.queries.some((query) => query.expected_support_ids.length > 20)).toBe(true);
  });

  it('uses scoped read-only Recall at 20 versus 120 result limits without future-phase leakage', () => {
    validateGoldenGraph(memory, fixture);
    const query = fixture.queries.find((candidate) => candidate.category === 'temporal' && candidate.to) ?? fixture.queries.find((candidate) => candidate.to) ?? fixture.queries[0]!;
    expect(query.to).toBeTruthy();
    const futureIds = (memory.db.prepare("SELECT id FROM memories WHERE space_id=? AND lifecycle='active' AND occurred_at>?").all(fixture.space_id, new Date(normalizedTime(query.to!)).toISOString()) as { id: string }[]).map((row) => row.id);
    expect(futureIds.length).toBeGreaterThan(0);
    const before = totalChanges(memory);
    const compact = memory.recall({ ...gameplayQueryInput(fixture, query, 'lexical'), limit: 20, max_chars: 12_000 });
    const roomy = memory.recall({ ...gameplayQueryInput(fixture, query, 'lexical'), limit: 120, max_chars: 72_000 });
    expect(roomy.items.length).toBeGreaterThan(0);
    expect(totalChanges(memory)).toBe(before);
    for (const result of [compact, roomy]) {
      expect(result.items.every((item) => item.space_id === fixture.space_id && item.lifecycle === 'active')).toBe(true);
      const returned = new Set(result.items.map((item) => item.id));
      expect(query.excluded_ids?.some((id) => returned.has(id)) ?? false).toBe(false);
      expect(futureIds.some((id) => returned.has(id))).toBe(false);
      if (query.to) for (const item of result.items) {
        const time = normalizedTime(item.occurred_at ?? item.created_at);
        expect(time).toBeLessThanOrEqual(normalizedTime(query.to));
      }
    }
    expect(compact.items.length).toBeLessThanOrEqual(20);
    expect(roomy.items.length).toBeLessThanOrEqual(120);
    const score = scoreGameplay(memory, query, roomy);
    expect(score.support_recall).toBeGreaterThanOrEqual(0);
    expect(score.support_recall).toBeLessThanOrEqual(1);
    // This benchmark measures retrieval, not a perfect-answer guarantee.
    expect(score.scoped_active).toBe(true);
  });

  it('rejects reversed and merely related edges as causal gold controls', () => {
    validateGoldenGraph(memory, fixture);
    const query = fixture.queries.find((candidate) => isCausalQuery(candidate) && candidate.expected_paths?.some((path) => path.nodes.length > 2));
    expect(query).toBeTruthy();

    const reversed: WorldStressFixture = structuredClone(fixture);
    const reversedQuery = reversed.queries.find((candidate) => candidate.id === query!.id)!;
    const reversedPath = reversedQuery.expected_paths!.find((path) => path.nodes.length > 2)!;
    reversedPath.nodes.reverse();
    reversedPath.relations.reverse();
    expect(() => validateGoldenGraph(memory, reversed)).toThrow(/directed|path|edge/i);

    const related: WorldStressFixture = structuredClone(fixture);
    const relatedQuery = related.queries.find((candidate) => candidate.id === query!.id)!;
    relatedQuery.expected_paths![0]!.relations[0] = 'related_to';
    expect(() => validateGoldenGraph(memory, related)).toThrow(/causal|causes|enables|path/i);
  });

  it('keeps world context backgrounds identical after removing the core at every size and position', () => {
    for (const characters of [32_000, 96_000] as const) {
      const probes = (['start', 'middle', 'end'] as const).map((position) => buildWorldContextProbe({ characters, position, seed: 731 }));
      const background = (probe: ReturnType<typeof buildWorldContextProbe>) => probe.state.slice(0, probe.metadata.core_offset)
        + probe.state.slice(probe.metadata.core_offset + probe.metadata.core_characters);
      const firstBackground = background(probes[0]!);
      for (const probe of probes) {
        expect(probe.state.length).toBe(characters);
        expect(probe.metadata.actual_characters).toBe(characters);
        expect(probe.metadata.core_hash).toBe(probes[0]!.metadata.core_hash);
        expect(probe.metadata.padding_hash).toBe(probes[0]!.metadata.padding_hash);
        expect(background(probe)).toBe(firstBackground);
        expect(probe.state.slice(probe.metadata.core_offset, probe.metadata.core_offset + probe.metadata.core_characters).length).toBe(probe.metadata.core_characters);
      }
      for (const confirmedIdentityFact of ['은박 안경을 쓰며 파란 유리 나침반을 수리했다', "원장 인물 '윤서린'", '은박안경 윤서']) {
        expect(firstBackground).not.toContain(confirmedIdentityFact);
      }
    }
  });

  it('keeps probe questions and answers position-invariant, hashes deterministic, and criteria label-free', () => {
    for (const characters of [32_000, 96_000] as const) {
      const byPosition = (['start', 'middle', 'end'] as const).map((position) => buildWorldContextProbe({ characters, position, seed: 1907 }));
      const repeated = buildWorldContextProbe({ characters, position: 'middle', seed: 1907 });
      const changedSeed = buildWorldContextProbe({ characters, position: 'middle', seed: 1908 });
      expect(repeated.state).toBe(byPosition[1]!.state);
      expect(repeated.id).toBe(byPosition[1]!.id);
      expect(repeated.metadata.core_hash).toBe(byPosition[1]!.metadata.core_hash);
      expect(changedSeed.metadata.core_hash).toBe(repeated.metadata.core_hash);
      expect(changedSeed.metadata.padding_hash).not.toBe(repeated.metadata.padding_hash);
      expect(changedSeed.id).not.toBe(repeated.id);
      for (const probe of byPosition) {
        expect(probe.questions).toEqual(byPosition[0]!.questions);
        expect(probe.expected_answers).toEqual(byPosition[0]!.expected_answers);
        expect(probe.metadata.core_hash).toBe(byPosition[0]!.metadata.core_hash);
        expect(probe.metadata.padding_hash).toBe(byPosition[0]!.metadata.padding_hash);
        expect(probe.state.length).toBe(characters);
      }
      const rootQuestion = byPosition[0]!.questions.find((question) => question.key === 'root_cause')!;
      expect(rootQuestion.type).toBe('choice');
      if (rootQuestion.type !== 'choice') throw new Error('Root cause probe must be a typed choice question');
      expect(rootQuestion.options).toEqual(['c0', 'c1', 'c2', 'c3']);
      expect(rootQuestion.criteria?.c3).toMatch(/특정할 수 없|확정할 수 없|unknown/i);
      const questionText = JSON.stringify(byPosition[0]!.questions);
      expect(questionText).not.toMatch(/gold answer|correct option|expected answer|정답은|정답:/i);
      expect(questionText).not.toContain(JSON.stringify(byPosition[0]!.expected_answers));
    }
    const small = buildWorldContextProbe({ characters: 32_000, position: 'middle', seed: 1907 });
    const large = buildWorldContextProbe({ characters: 96_000, position: 'middle', seed: 1907 });
    expect(large.metadata.core_hash).toBe(small.metadata.core_hash);
    expect(large.metadata.padding_hash).not.toBe(small.metadata.padding_hash);
  });

});
