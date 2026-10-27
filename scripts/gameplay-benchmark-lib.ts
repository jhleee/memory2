import { readFile } from 'node:fs/promises';
import type { Memory } from '../src/memory.js';
import type { CorrectInput, ForgetInput, RecordInput, RetrievalMode, RuntimeQueryInput } from '../src/types.js';

export type GameplayCategory = 'causal' | 'relationship' | 'identity' | 'temporal' | 'negative';

export interface GameplayPath {
  nodes: string[];
  relations: string[];
}

export interface GameplayQuery {
  id: string;
  /** Filled from fixture.space_id by loadGameplayFixture; omitted in fixture JSON. */
  space_id: string;
  category: GameplayCategory;
  query: string;
  entity_id?: string;
  from?: string;
  to?: string;
  kind?: string;
  at?: string;
  expected_support_ids: string[];
  excluded_ids?: string[];
  expected_paths?: GameplayPath[];
  limit?: number;
}

export type GameplayOperation =
  | { type: 'record'; input: RecordInput }
  | { type: 'correct'; input: CorrectInput }
  | { type: 'forget'; input: ForgetInput }
  | { type: 'resolve'; input: { space_id: string; mention_id: string; entity_id: string } };

export interface GameplaySession {
  id: string;
  label: string;
  records: RecordInput[];
}

export interface GameplayEntityDecision {
  id: string;
  mention: string;
  as_of_session: string;
  candidate_entity_ids: string[];
  expected_entity_id: string | null;
  attributes?: Record<string, unknown>;
}

export interface GameplayFixture {
  version: 1;
  title: string;
  description: string;
  space_id: string;
  sessions: GameplaySession[];
  operations?: GameplayOperation[];
  entity_decisions?: GameplayEntityDecision[];
  queries: GameplayQuery[];
}

export interface GameplayScore {
  query_id: string;
  category: GameplayCategory;
  /** Empty gold set gets recall 1; this prevents penalizing an empty negative case. */
  support_recall: number;
  /** Null for negative cases with no gold support IDs. */
  support_precision: number | null;
  /** 1-based rank of the first returned gold support; null for no gold or no hit. */
  first_support_rank: number | null;
  /** Reciprocal first-support rank; null for negative cases, zero for a positive no-hit. */
  reciprocal_rank: number | null;
  /** Fraction of gold supports in the first five returned items; null for negative cases. */
  support_recall_at_5: number | null;
  /** Whether the first returned item is gold support; null for negative cases. */
  top1_support: boolean | null;
  support_complete: boolean;
  excluded_returned_ids: string[];
  directed_paths_total: number;
  /** Gold path-node coverage with the frozen directed DB links present; not a returned causal answer. */
  directed_paths_complete: number;
  /** Current RecallResult contains memory rows and traces, not structured paths. */
  structured_paths_returned: false;
  scoped_active: boolean;
}

export interface SeedGameplayResult {
  /** Evidence source records written, including evidence created by corrections. */
  records: number;
  memories: number;
  entities: number;
  links: number;
  spaces: number;
}

const categories = new Set<GameplayCategory>(['causal', 'relationship', 'identity', 'temporal', 'negative']);
const causalRelations = new Set(['causes', 'enables']);
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new TypeError(`Invalid gameplay fixture: ${message}`);
}

function validatePath(path: unknown, queryId: string, causal: boolean): asserts path is GameplayPath {
  assert(isObject(path), `query ${queryId} path must be an object`);
  assert(Array.isArray(path.nodes) && path.nodes.length >= 2 && path.nodes.every(nonEmpty), `query ${queryId} path needs at least two memory IDs`);
  assert(Array.isArray(path.relations) && path.relations.length === path.nodes.length - 1 && path.relations.every(nonEmpty), `query ${queryId} path relations must connect adjacent nodes`);
  if (causal) assert(path.relations.every(relation => causalRelations.has(relation)), `causal query ${queryId} paths must use causes or enables relations`);
}

function validateRecordInput(value: unknown, label: string): asserts value is RecordInput {
  assert(isObject(value), `${label} must be an object`);
  assert(nonEmpty(value.space_id), `${label}.space_id must be a non-empty string`);
  assert(isObject(value.evidence) && nonEmpty(value.evidence.source_type) && typeof value.evidence.content === 'string', `${label}.evidence is invalid`);
  assert(Array.isArray(value.memories) && value.memories.length > 0, `${label}.memories must not be empty`);
  for (const [index, memory] of value.memories.entries()) {
    assert(isObject(memory) && nonEmpty(memory.kind) && typeof memory.content === 'string', `${label}.memories[${index}] is invalid`);
  }
  if (value.links !== undefined) {
    assert(Array.isArray(value.links), `${label}.links must be an array`);
    for (const [index, link] of value.links.entries()) {
      assert(isObject(link) && nonEmpty(link.relation) && isObject(link.from) && nonEmpty(link.from.id) && ['memory', 'entity', 'evidence'].includes(String(link.from.type)) && isObject(link.to) && nonEmpty(link.to.id) && ['memory', 'entity', 'evidence'].includes(String(link.to.type)), `${label}.links[${index}] is invalid`);
    }
  }
}

/** Load and validate the version 1 hand-authored gameplay fixture. */
export async function loadGameplayFixture(path: string): Promise<GameplayFixture> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, 'utf8')) as unknown; }
  catch (error) { throw new Error(`Could not load gameplay fixture ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  assert(isObject(parsed), 'root must be an object');
  assert(parsed.version === 1, 'version must be 1');
  assert(nonEmpty(parsed.title) && nonEmpty(parsed.description) && nonEmpty(parsed.space_id), 'title, description, and space_id are required');
  assert(Array.isArray(parsed.sessions) && parsed.sessions.length > 0, 'sessions must not be empty');
  const sessionIds = new Set<string>();
  let memoryCount = 0;
  for (const [sessionIndex, session] of parsed.sessions.entries()) {
    assert(isObject(session) && nonEmpty(session.id) && nonEmpty(session.label), `sessions[${sessionIndex}] needs unique id and label`);
    assert(!sessionIds.has(session.id), `duplicate session id ${session.id}`);
    sessionIds.add(session.id);
    assert(Array.isArray(session.records), `session ${session.id} records must be an array`);
    for (const [recordIndex, record] of session.records.entries()) {
      validateRecordInput(record, `session ${session.id} record ${recordIndex}`);
      memoryCount += record.memories.length;
    }
  }
  assert(memoryCount > 0, 'fixture must contain at least one memory');

  if (parsed.operations !== undefined) {
    assert(Array.isArray(parsed.operations), 'operations must be an array');
    for (const [index, operation] of parsed.operations.entries()) {
      assert(isObject(operation) && isObject(operation.input), `operations[${index}] is invalid`);
      switch (operation.type) {
        case 'record': validateRecordInput(operation.input, `operations[${index}].input`); break;
        case 'correct': {
          const input = operation.input;
          assert(nonEmpty(input.space_id) && nonEmpty(input.memory_id) && isObject(input.replacement) && nonEmpty(input.replacement.kind) && typeof input.replacement.content === 'string', `operations[${index}] correct input is invalid`);
          assert(isObject(input.evidence) && nonEmpty(input.evidence.source_type) && typeof input.evidence.content === 'string', `operations[${index}] correction evidence is invalid`);
          break;
        }
        case 'forget': assert(nonEmpty(operation.input.space_id) && nonEmpty(operation.input.memory_id), `operations[${index}] forget input is invalid`); break;
        case 'resolve': assert(nonEmpty(operation.input.space_id) && nonEmpty(operation.input.mention_id) && nonEmpty(operation.input.entity_id), `operations[${index}] resolve input is invalid`); break;
        default: throw new TypeError(`Invalid gameplay fixture: operations[${index}] has an unsupported type`);
      }
    }
  }

  if (parsed.entity_decisions !== undefined) {
    assert(Array.isArray(parsed.entity_decisions), 'entity_decisions must be an array');
    const decisionIds = new Set<string>();
    for (const [index, decision] of parsed.entity_decisions.entries()) {
      assert(isObject(decision) && nonEmpty(decision.id) && !decisionIds.has(decision.id), `entity_decisions[${index}] needs a unique id`);
      decisionIds.add(decision.id);
      assert(nonEmpty(decision.mention), `entity decision ${decision.id} mention must be non-empty`);
      assert(nonEmpty(decision.as_of_session) && sessionIds.has(decision.as_of_session), `entity decision ${decision.id} references an unknown session`);
      assert(Array.isArray(decision.candidate_entity_ids) && decision.candidate_entity_ids.length > 0 && decision.candidate_entity_ids.every(nonEmpty), `entity decision ${decision.id} needs candidate Entity IDs`);
      assert(new Set(decision.candidate_entity_ids).size === decision.candidate_entity_ids.length, `entity decision ${decision.id} has duplicate candidates`);
      assert(decision.expected_entity_id === null || (nonEmpty(decision.expected_entity_id) && decision.candidate_entity_ids.includes(decision.expected_entity_id)), `entity decision ${decision.id} expected_entity_id must be null or one of its candidates`);
      if (decision.attributes !== undefined) assert(isObject(decision.attributes), `entity decision ${decision.id} attributes must be an object`);
    }
  }

  assert(Array.isArray(parsed.queries) && parsed.queries.length >= 24, 'queries must contain at least 24 cases');
  const queryIds = new Set<string>();
  for (const [index, query] of parsed.queries.entries()) {
    assert(isObject(query) && nonEmpty(query.id) && !queryIds.has(query.id), `queries[${index}] needs a unique id`);
    queryIds.add(query.id);
    assert(typeof query.category === 'string' && categories.has(query.category as GameplayCategory), `query ${query.id} has an invalid category`);
    assert(typeof query.query === 'string', `query ${query.id} query must be a string`);
    for (const key of ['entity_id', 'from', 'to', 'kind', 'at'] as const) if (query[key] !== undefined) assert(typeof query[key] === 'string', `query ${query.id} ${key} must be a string`);
    assert(Array.isArray(query.expected_support_ids) && query.expected_support_ids.every(nonEmpty), `query ${query.id} expected_support_ids must be strings`);
    const supports = query.expected_support_ids as string[];
    assert(new Set(supports).size === supports.length, `query ${query.id} has duplicate support IDs`);
    if (query.excluded_ids !== undefined) {
      assert(Array.isArray(query.excluded_ids) && query.excluded_ids.every(nonEmpty), `query ${query.id} excluded_ids must be strings`);
      const excluded = query.excluded_ids as string[];
      assert(new Set(excluded).size === excluded.length, `query ${query.id} has duplicate excluded IDs`);
      assert(excluded.every(id => !supports.includes(id)), `query ${query.id} cannot exclude a support ID`);
    }
    if (query.limit !== undefined) assert(Number.isInteger(query.limit) && (query.limit as number) > 0, `query ${query.id} limit must be a positive integer`);
    if (query.expected_paths !== undefined) {
      assert(Array.isArray(query.expected_paths), `query ${query.id} expected_paths must be an array`);
      query.expected_paths.forEach(path => validatePath(path, query.id as string, query.category === 'causal'));
    }
  }
  const fixture = parsed as unknown as GameplayFixture;
  fixture.queries = fixture.queries.map(query => ({ ...query, space_id: fixture.space_id }));
  return fixture;
}

function tableCount(memory: Memory, table: 'evidence' | 'memories' | 'entities' | 'links' | 'spaces'): number {
  const row = memory.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

/** Seed sessions in order, then apply the fixture's explicit mutation operations. */
export function seedGameplay(memory: Memory, fixture: GameplayFixture): SeedGameplayResult {
  const before = {
    records: tableCount(memory, 'evidence'), memories: tableCount(memory, 'memories'), entities: tableCount(memory, 'entities'),
    links: tableCount(memory, 'links'), spaces: tableCount(memory, 'spaces'),
  };
  for (const session of fixture.sessions) for (const record of session.records) memory.record(record);
  for (const operation of fixture.operations ?? []) {
    switch (operation.type) {
      case 'record': memory.record(operation.input); break;
      case 'correct': memory.correct(operation.input); break;
      case 'forget': memory.forget(operation.input); break;
      case 'resolve': memory.resolveMention(operation.input); break;
    }
  }
  return {
    records: tableCount(memory, 'evidence') - before.records,
    memories: tableCount(memory, 'memories') - before.memories,
    entities: tableCount(memory, 'entities') - before.entities,
    links: tableCount(memory, 'links') - before.links,
    spaces: tableCount(memory, 'spaces') - before.spaces,
  };
}

function timeValue(value: string): number {
  const timestamp = Date.parse(value.length === 10 ? `${value}T00:00:00.000Z` : value);
  if (!Number.isFinite(timestamp)) throw new TypeError(`Invalid gameplay date: ${value}`);
  return timestamp;
}

function eligible(memory: Memory, id: string, query: GameplayQuery, spaceId: string): boolean {
  const row = memory.db.prepare('SELECT m.* FROM memories m WHERE m.id=?').get(id) as Record<string, unknown> | undefined;
  if (!row || row.space_id !== spaceId || row.lifecycle !== 'active') return false;
  if (query.kind && row.kind !== query.kind) return false;
  if (query.entity_id) {
    const relation = memory.db.prepare(`SELECT 1 FROM links WHERE space_id=? AND active=1 AND (
      (from_type='memory' AND from_id=? AND to_type='entity' AND to_id=?) OR
      (from_type='entity' AND from_id=? AND to_type='memory' AND to_id=?)) LIMIT 1`).get(row.space_id, id, query.entity_id, query.entity_id, id);
    if (!relation) return false;
  }
  const eventTime = timeValue(String(row.occurred_at ?? row.created_at));
  if (query.from && eventTime < timeValue(query.from)) return false;
  if (query.to && eventTime > timeValue(query.to)) return false;
  if (query.at) {
    const at = timeValue(query.at);
    if (row.valid_from !== null && timeValue(String(row.valid_from)) > at) return false;
    if (row.valid_to !== null && timeValue(String(row.valid_to)) < at) return false;
  }
  return true;
}

/** Assert golden support/path facts exist and meet the query's hard eligibility filters. */
export function validateGoldenGraph(memory: Memory, fixture: GameplayFixture): void {
  for (const query of fixture.queries) {
    if (query.category === 'causal') {
      for (const path of query.expected_paths ?? []) {
        assert(Array.isArray(path.relations) && path.relations.every(relation => causalRelations.has(relation)), `causal query ${query.id} paths must use causes or enables relations`);
      }
    }
    for (const id of query.expected_support_ids) {
      const row = memory.db.prepare('SELECT space_id FROM memories WHERE id=?').get(id) as { space_id: string } | undefined;
      assert(row?.space_id === fixture.space_id, `support ${id} for ${query.id} is absent or belongs to another space`);
      assert(eligible(memory, id, query, fixture.space_id), `support ${id} for ${query.id} is inactive or violates its query filters`);
    }
    for (const id of query.excluded_ids ?? []) {
      assert(!!memory.db.prepare('SELECT 1 FROM memories WHERE id=?').get(id), `excluded memory ${id} for ${query.id} does not exist`);
    }
    for (const path of query.expected_paths ?? []) {
      for (const id of path.nodes) {
        const row = memory.db.prepare('SELECT space_id FROM memories WHERE id=?').get(id) as { space_id: string } | undefined;
        assert(row?.space_id === fixture.space_id && eligible(memory, id, query, fixture.space_id), `path node ${id} for ${query.id} is absent, out of scope, or ineligible`);
      }
      for (let i = 0; i < path.relations.length; i++) {
        const exists = memory.db.prepare(`SELECT 1 FROM links WHERE space_id=? AND active=1 AND from_type='memory' AND from_id=? AND to_type='memory' AND to_id=? AND relation=?`)
          .get(fixture.space_id, path.nodes[i], path.nodes[i + 1], path.relations[i]);
        assert(!!exists, `path ${query.id} is missing directed ${path.relations[i]} edge ${path.nodes[i]} -> ${path.nodes[i + 1]}`);
      }
    }
  }
}

/** Score returned memory IDs against explicit support, exclusion, and directed-path labels. */
export function scoreGameplay(memory: Memory, query: GameplayQuery, result: { items: Array<{ id: string; space_id: string; lifecycle: string }> }): GameplayScore {
  const returnedIds = new Set(result.items.map(item => item.id));
  const support = new Set(query.expected_support_ids);
  const hitCount = [...support].filter(id => returnedIds.has(id)).length;
  const retrievedEligible = [...returnedIds].filter(id => support.has(id));
  const firstSupportIndex = result.items.findIndex(item => support.has(item.id));
  const firstSupportRank = support.size === 0 || firstSupportIndex < 0 ? null : firstSupportIndex + 1;
  const topFiveSupportCount = new Set(result.items.slice(0, 5).map(item => item.id).filter(id => support.has(id))).size;
  const excluded = new Set(query.excluded_ids ?? []);
  let completePaths = 0;
  for (const path of query.expected_paths ?? []) {
    const returned = path.nodes.every(id => returnedIds.has(id));
    const edges = path.relations.every((relation, i) => !!memory.db.prepare(`SELECT 1 FROM links WHERE space_id=? AND active=1 AND from_type='memory' AND from_id=? AND to_type='memory' AND to_id=? AND relation=?`)
      .get(query.space_id, path.nodes[i], path.nodes[i + 1], relation));
    if (returned && edges) completePaths++;
  }
  return {
    query_id: query.id,
    category: query.category,
    support_recall: support.size === 0 ? 1 : hitCount / support.size,
    support_precision: support.size === 0 ? null : retrievedEligible.length / Math.max(returnedIds.size, 1),
    first_support_rank: firstSupportRank,
    reciprocal_rank: support.size === 0 ? null : firstSupportRank === null ? 0 : 1 / firstSupportRank,
    support_recall_at_5: support.size === 0 ? null : topFiveSupportCount / support.size,
    top1_support: support.size === 0 ? null : !!result.items[0] && support.has(result.items[0].id),
    support_complete: hitCount === support.size,
    excluded_returned_ids: [...returnedIds].filter(id => excluded.has(id)).sort(),
    directed_paths_total: query.expected_paths?.length ?? 0,
    directed_paths_complete: completePaths,
    structured_paths_returned: false,
    scoped_active: result.items.every(item => item.space_id === query.space_id && item.lifecycle === 'active'),
  };
}

/** Convert one case to a retrieval input. Golden IDs and path labels are never forwarded. */
export function gameplayQueryInput(fixture: GameplayFixture, query: GameplayQuery, mode: RetrievalMode): RuntimeQueryInput {
  return {
    space_id: fixture.space_id,
    query: query.query,
    mode,
    ...(query.entity_id === undefined ? {} : { entity_id: query.entity_id }),
    ...(query.from === undefined ? {} : { from: query.from }),
    ...(query.to === undefined ? {} : { to: query.to }),
    ...(query.kind === undefined ? {} : { kind: query.kind }),
    ...(query.at === undefined ? {} : { at: query.at }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
  };
}
