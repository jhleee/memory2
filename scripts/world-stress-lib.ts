import { createHash } from 'node:crypto';
import type { Memory } from '../src/memory.js';
import type { GameplayCategory, GameplayFixture, GameplayPath, GameplayQuery, GameplayScore } from './gameplay-benchmark-lib.js';

const categories: GameplayCategory[] = ['causal', 'relationship', 'identity', 'temporal', 'negative'];

export interface CategoryGameplaySummary {
  cases: number;
  positive_cases: number;
  empty_gold_excluded: number;
  support_recall: number | null;
  support_recall_at_5: number | null;
  mrr: number | null;
  top1: number | null;
  complete_count: number;
  path_covered: number;
  path_total: number;
  exclusion_violations: number;
  scoped_active: boolean;
}

export interface GameplaySummary {
  overall: CategoryGameplaySummary;
  by_category: Record<GameplayCategory, CategoryGameplaySummary>;
}

export interface BudgetCeilingCase {
  query_id: string;
  category: GameplayCategory;
  support_count: number;
  limit: number;
  ceiling: number | null;
}

export interface BudgetCeilingSummary {
  overall: { cases: number; positive_cases: number; empty_gold_excluded: number; mean_ceiling: number | null };
  by_category: Record<GameplayCategory, { cases: number; positive_cases: number; empty_gold_excluded: number; mean_ceiling: number | null }>;
  cases: BudgetCeilingCase[];
}

export interface CorpusTextMeasure {
  bytes_utf8: number;
  /** Unicode code points, not UTF-16 code units or grapheme clusters. */
  characters: number;
}

export interface WorldCorpusStats {
  space_id: string;
  counts: {
    memories_active: number;
    memories_all: number;
    entities: number;
    links_active: number;
    links_all: number;
    evidence: number;
  };
  /** Sum of active Memory content, Evidence content, and Entity names. */
  corpus: CorpusTextMeasure;
  components: {
    active_memory_content: CorpusTextMeasure;
    evidence_content: CorpusTextMeasure;
    entity_names: CorpusTextMeasure;
  };
}

export interface CausalEdgeCheck {
  from_id: string;
  relation: string;
  to_id: string;
  stored_directed_active_edge: boolean;
}

export interface CausalPathRetrievalDiagnostic {
  query_id: string;
  path_index: number;
  declared_nodes: string[];
  declared_relations: string[];
  /** Zero-based offsets in the exact returnedIds order; null means absent. */
  returned_node_positions: Array<number | null>;
  missing_returned_nodes: string[];
  all_nodes_returned: boolean;
  retrieved_in_declared_order: boolean;
  edge_checks: CausalEdgeCheck[];
  evidence_path_supported: boolean;
  /** RecallResult does not contain structured paths and this diagnostic infers no answer. */
  structured_path_returned: false;
  causal_answer_inferred: false;
}

export interface GoldenManifest {
  version: 1;
  space_id: string;
  queries: Array<{
    id: string;
    category: GameplayCategory;
    expected_support_ids: string[];
    excluded_ids: string[];
    expected_paths: GameplayPath[];
  }>;
  entity_decisions: NonNullable<GameplayFixture['entity_decisions']>;
}

export interface FrozenGameplayFixture {
  fixture_sha256: string;
  golden_manifest_sha256: string;
  golden_manifest: GoldenManifest;
}

export interface WorldStressSplit {
  name: string;
  session_ids: string[];
  query_ids: string[];
  entity_decision_ids: string[];
}

export interface WorldStressProvenance extends FrozenGameplayFixture {
  /** Seed used by deterministic fixture generation; runtime seeding remains fixed. */
  trial: { seed: string | number; index: number };
  seed_scope: 'fixture-generation seed; fixture hash commits generated data';
  ordering: { session_ids: string[]; operation_types: string[] };
  split: WorldStressSplit;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('Cannot hash a value that is not JSON serializable');
  return encoded;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

/** Hash the loaded fixture without its loader-derived per-query space_id fields. */
export function freezeGameplayFixture(fixture: GameplayFixture): FrozenGameplayFixture {
  const fixtureForHash = {
    ...fixture,
    queries: fixture.queries.map(({ space_id: _derivedSpace, ...query }) => query),
  };
  const golden_manifest: GoldenManifest = {
    version: 1,
    space_id: fixture.space_id,
    queries: fixture.queries.map(query => ({
      id: query.id,
      category: query.category,
      expected_support_ids: [...query.expected_support_ids],
      excluded_ids: [...(query.excluded_ids ?? [])],
      expected_paths: (query.expected_paths ?? []).map(path => ({ nodes: [...path.nodes], relations: [...path.relations] })),
    })),
    entity_decisions: (fixture.entity_decisions ?? []).map(decision => ({
      id: decision.id,
      mention: decision.mention,
      as_of_session: decision.as_of_session,
      candidate_entity_ids: [...decision.candidate_entity_ids],
      expected_entity_id: decision.expected_entity_id,
      ...(decision.attributes === undefined ? {} : { attributes: JSON.parse(JSON.stringify(decision.attributes)) as Record<string, unknown> }),
    })),
  };
  return {
    fixture_sha256: sha256(fixtureForHash),
    golden_manifest_sha256: sha256(golden_manifest),
    golden_manifest,
  };
}

/** Freeze seed/order/split provenance for one repeatable report trial. */
export function worldStressProvenance(
  fixture: GameplayFixture,
  options: {
    seed: string | number;
    trialIndex: number;
    split?: Partial<WorldStressSplit> & { name?: string };
  },
): WorldStressProvenance {
  if ((typeof options.seed !== 'string' && typeof options.seed !== 'number') || (typeof options.seed === 'string' && !options.seed.trim()) || (typeof options.seed === 'number' && !Number.isFinite(options.seed))) {
    throw new TypeError('seed must be a non-empty string or finite number');
  }
  if (!Number.isInteger(options.trialIndex) || options.trialIndex < 0) throw new TypeError('trialIndex must be a non-negative integer');
  const split = options.split ?? {};
  const allSessions = fixture.sessions.map(session => session.id);
  const allQueries = fixture.queries.map(query => query.id);
  const allEntityDecisions = (fixture.entity_decisions ?? []).map(test => test.id);
  const selected: WorldStressSplit = {
    name: split.name ?? 'all',
    session_ids: [...(split.session_ids ?? allSessions)],
    query_ids: [...(split.query_ids ?? allQueries)],
    entity_decision_ids: [...(split.entity_decision_ids ?? allEntityDecisions)],
  };
  if (!selected.name.trim()) throw new TypeError('split name must be non-empty');
  for (const [label, ids, valid] of [
    ['session_ids', selected.session_ids, new Set(allSessions)],
    ['query_ids', selected.query_ids, new Set(allQueries)],
    ['entity_decision_ids', selected.entity_decision_ids, new Set(allEntityDecisions)],
  ] as const) {
    if (new Set(ids).size !== ids.length || ids.some(id => !valid.has(id))) throw new TypeError(`split ${label} contains duplicates or unknown IDs`);
  }
  return {
    ...freezeGameplayFixture(fixture),
    trial: { seed: options.seed, index: options.trialIndex },
    seed_scope: 'fixture-generation seed; fixture hash commits generated data',
    ordering: {
      session_ids: allSessions,
      operation_types: (fixture.operations ?? []).map(operation => operation.type),
    },
    split: selected,
  };
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function summarizeScoreGroup(scores: GameplayScore[]): CategoryGameplaySummary {
  const positive = scores.filter(score => score.reciprocal_rank !== null);
  return {
    cases: scores.length,
    positive_cases: positive.length,
    empty_gold_excluded: scores.length - positive.length,
    support_recall: mean(positive.map(score => score.support_recall)),
    support_recall_at_5: mean(positive.flatMap(score => score.support_recall_at_5 === null ? [] : [score.support_recall_at_5])),
    mrr: mean(positive.flatMap(score => score.reciprocal_rank === null ? [] : [score.reciprocal_rank])),
    top1: mean(positive.flatMap(score => score.top1_support === null ? [] : [Number(score.top1_support)])),
    complete_count: positive.filter(score => score.support_complete).length,
    path_covered: scores.reduce((sum, score) => sum + score.directed_paths_complete, 0),
    path_total: scores.reduce((sum, score) => sum + score.directed_paths_total, 0),
    exclusion_violations: scores.reduce((sum, score) => sum + score.excluded_returned_ids.length, 0),
    scoped_active: scores.every(score => score.scoped_active),
  };
}

/** Aggregate frozen retrieval scores overall and by the fixture's five query categories. */
export function summarizeGameplayScores(scores: GameplayScore[]): GameplaySummary {
  return {
    overall: summarizeScoreGroup(scores),
    by_category: Object.fromEntries(categories.map(category => [category, summarizeScoreGroup(scores.filter(score => score.category === category))])) as Record<GameplayCategory, CategoryGameplaySummary>,
  };
}

/** The maximum possible recall at a fixed result limit, before retrieval quality is considered. */
export function supportBudgetCeiling(query: GameplayQuery, limit = query.limit ?? 20): number | null {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer');
  const gold = query.expected_support_ids.length;
  return gold === 0 ? null : Math.min(gold, limit) / gold;
}

/** Aggregate fixed-limit recall ceilings, excluding negative cases from the mean. */
export function summarizeBudgetCeilings(fixture: GameplayFixture, limit = 20): BudgetCeilingSummary {
  const cases = fixture.queries.map(query => ({
    query_id: query.id,
    category: query.category,
    support_count: query.expected_support_ids.length,
    limit,
    ceiling: supportBudgetCeiling(query, limit),
  }));
  const summarize = (items: BudgetCeilingCase[]) => {
    const positive = items.flatMap(item => item.ceiling === null ? [] : [item.ceiling]);
    return { cases: items.length, positive_cases: positive.length, empty_gold_excluded: items.length - positive.length, mean_ceiling: mean(positive) };
  };
  return {
    overall: summarize(cases),
    by_category: Object.fromEntries(categories.map(category => [category, summarize(cases.filter(item => item.category === category))])) as BudgetCeilingSummary['by_category'],
    cases,
  };
}

function textMeasure(values: string[]): CorpusTextMeasure {
  const text = values.join('');
  return { bytes_utf8: Buffer.byteLength(text, 'utf8'), characters: Array.from(text).length };
}

/** Read-only size and active-count snapshot for the benchmark's main Space. */
export function collectWorldCorpusStats(memory: Memory, spaceId: string): WorldCorpusStats {
  if (typeof spaceId !== 'string' || !spaceId.trim()) throw new TypeError('spaceId must be non-empty');
  const db = memory.db;
  const activeMemories = db.prepare("SELECT content FROM memories WHERE space_id=? AND lifecycle='active' ORDER BY id").all(spaceId) as { content: string }[];
  const allMemoryCount = db.prepare('SELECT COUNT(*) AS count FROM memories WHERE space_id=?').get(spaceId) as { count: number };
  const entities = db.prepare('SELECT name FROM entities WHERE space_id=? ORDER BY id').all(spaceId) as { name: string }[];
  const evidence = db.prepare('SELECT content FROM evidence WHERE space_id=? ORDER BY id').all(spaceId) as { content: string }[];
  const linkCounts = db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN active=1 THEN 1 ELSE 0 END) AS active FROM links WHERE space_id=?').get(spaceId) as { total: number; active: number | null };
  const counts = {
    memories_active: activeMemories.length,
    memories_all: allMemoryCount.count,
    entities: entities.length,
    links_active: linkCounts.active ?? 0,
    links_all: linkCounts.total,
    evidence: evidence.length,
  };
  const activeMemoryText = textMeasure(activeMemories.map(row => row.content));
  const evidenceText = textMeasure(evidence.map(row => row.content));
  const entityText = textMeasure(entities.map(row => row.name));
  return {
    space_id: spaceId,
    counts,
    components: { active_memory_content: activeMemoryText, evidence_content: evidenceText, entity_names: entityText },
    corpus: {
      bytes_utf8: activeMemoryText.bytes_utf8 + evidenceText.bytes_utf8 + entityText.bytes_utf8,
      characters: activeMemoryText.characters + evidenceText.characters + entityText.characters,
    },
  };
}

/** Inspect expected causal paths against the actual returned ID ordering and stored directed links. */
export function causalPathDiagnostics(memory: Memory, query: GameplayQuery, returnedIds: string[]): CausalPathRetrievalDiagnostic[] {
  if (query.category !== 'causal') return [];
  const positions = new Map<string, number>();
  returnedIds.forEach((id, index) => { if (!positions.has(id)) positions.set(id, index); });
  return (query.expected_paths ?? []).map((path, pathIndex) => {
    const returnedPositions = path.nodes.map(id => positions.get(id) ?? null);
    const missing = path.nodes.filter((_, index) => returnedPositions[index] === null);
    const allReturned = missing.length === 0;
    const ordered = allReturned && returnedPositions.every((position, index) => index === 0 || (returnedPositions[index - 1] as number) < (position as number));
    const edgeChecks = path.relations.map((relation, index): CausalEdgeCheck => ({
      from_id: path.nodes[index]!, relation, to_id: path.nodes[index + 1]!,
      stored_directed_active_edge: !!memory.db.prepare(`SELECT 1 FROM links WHERE space_id=? AND active=1 AND from_type='memory' AND from_id=? AND to_type='memory' AND to_id=? AND relation=?`)
        .get(query.space_id, path.nodes[index], path.nodes[index + 1], relation),
    }));
    return {
      query_id: query.id,
      path_index: pathIndex,
      declared_nodes: [...path.nodes],
      declared_relations: [...path.relations],
      returned_node_positions: returnedPositions,
      missing_returned_nodes: missing,
      all_nodes_returned: allReturned,
      retrieved_in_declared_order: ordered,
      edge_checks: edgeChecks,
      evidence_path_supported: allReturned && edgeChecks.every(edge => edge.stored_directed_active_edge),
      structured_path_returned: false,
      causal_answer_inferred: false,
    };
  });
}
