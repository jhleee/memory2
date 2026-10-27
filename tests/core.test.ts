import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory } from '../src/index.js';
import type { RecordInput } from '../src/types.js';

let dir: string;
let path: string;
let memory: Memory;

function input(space_id: string, overrides: Partial<RecordInput> = {}): RecordInput {
  return {
    space_id,
    evidence: { source_type: 'test', content: 'source text' },
    memories: [{ kind: 'note', content: 'A remembered fact' }],
    ...overrides,
  };
}

function counts(db: Memory['db']): Record<string, number> {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return Object.fromEntries(tables.map(({ name }) => {
    const quoted = `"${name.replaceAll('"', '""')}"`;
    const row = db.prepare(`SELECT count(*) AS n FROM ${quoted}`).get() as { n: number };
    return [name, row.n];
  }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'context-memory-'));
  path = join(dir, 'memory.db');
  memory = new Memory(path);
});

afterEach(() => {
  memory?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('SQLite memory core acceptance', () => {
  it('persists records across close and reopen', () => {
    const saved = memory.record(input('persist', { memories: [{ id: 'm_persist', kind: 'note', content: 'Survives restart' }] }));
    memory.close();
    memory = new Memory(path);
    const recalled = memory.recall({ space_id: 'persist', query: 'Survives restart' });
    expect(recalled.items.map((item) => item.id)).toContain(saved.memory_ids[0]);
    expect(recalled.items[0]?.content).toBe('Survives restart');
  });

  it('preserves unknown separately from false and does not infer omitted facts', () => {
    memory.record(input('facts', { memories: [
      { kind: 'event', content: 'Lia handed over a key', data: { receiver: { state: 'unknown' }, confirmed: false } },
      { kind: 'event', content: 'An incomplete transfer', data: { giver: 'lia', object: 'key' } },
    ] }));
    const items = memory.recall({ space_id: 'facts' }).items;
    const explicit = items.find((item) => item.content === 'Lia handed over a key');
    const incomplete = items.find((item) => item.content === 'An incomplete transfer');
    expect(explicit?.data).toMatchObject({ receiver: { state: 'unknown' }, confirmed: false });
    expect(incomplete?.data).toEqual({ giver: 'lia', object: 'key' });
    expect(incomplete?.data).not.toHaveProperty('receiver');
  });

  it('isolates spaces, including when a link attempts a cross-space reference', () => {
    memory.record(input('alpha', { memories: [{ id: 'alpha_m', kind: 'note', content: 'alpha secret' }] }));
    memory.record(input('beta', { memories: [{ id: 'beta_m', kind: 'note', content: 'beta secret' }] }));
    expect(memory.recall({ space_id: 'alpha', query: 'secret' }).items.map((x) => x.id)).toEqual(['alpha_m']);
    expect(() => memory.record(input('beta', {
      memories: [{ id: 'beta_2', kind: 'note', content: 'cross link' }],
      links: [{ from: { id: 'beta_2', type: 'memory' }, relation: 'related_to', to: { id: 'alpha_m', type: 'memory' } }],
    }))).toThrow();
    const betaResults = memory.recall({ space_id: 'beta', query: 'alpha' }).items;
    expect(betaResults.map((item) => item.id)).not.toContain('alpha_m');
    expect(betaResults.map((item) => item.id)).not.toContain('beta_2');
  });

  it('rolls back all writes when a record contains an invalid link', () => {
    const before = counts(memory.db);
    expect(() => memory.record(input('atomic', {
      memories: [{ id: 'must_rollback', kind: 'note', content: 'rollback marker' }],
      links: [{ from: { id: 'must_rollback', type: 'memory' }, relation: 'related_to', to: { id: 'missing', type: 'entity' } }],
    }))).toThrow();
    expect(memory.db.prepare("SELECT count(*) AS n FROM spaces WHERE id='atomic'").get()).toMatchObject({ n: 0 });
    expect(memory.db.prepare("SELECT count(*) AS n FROM memories WHERE id='must_rollback'").get()).toMatchObject({ n: 0 });
    expect(counts(memory.db)).toEqual(before);
  });

  it('replays identical idempotency keys and rejects conflicting payloads', () => {
    const payload = input('idem', { idempotency_key: 'request-1', memories: [{ id: 'idem_m', kind: 'note', content: 'once only' }] });
    const first = memory.record(payload);
    const replay = memory.record(payload);
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.evidence_id).toBe(first.evidence_id);
    expect(replay.memory_ids).toEqual(first.memory_ids);
    expect(memory.db.prepare("SELECT count(*) AS n FROM memories WHERE space_id='idem'").get()).toMatchObject({ n: 1 });
    expect(() => memory.record(input('idem', { idempotency_key: 'request-1', memories: [{ kind: 'note', content: 'different payload' }] }))).toThrow();
  });

  it('keeps correction history and removes stale text from ordinary FTS recall', () => {
    const original = memory.record(input('correction', { memories: [{ id: 'old_m', kind: 'claim', content: 'The launch date is Tuesday' }] }));
    const replacement = memory.correct({
      space_id: 'correction', memory_id: original.memory_ids[0]!,
      replacement: { id: 'new_m', kind: 'claim', content: 'The launch date is Thursday' },
      evidence: { source_type: 'correction', content: 'The date was corrected to Thursday' },
    });
    expect(memory.db.prepare('SELECT lifecycle, corrected_by FROM memories WHERE id=?').get('old_m')).toMatchObject({ lifecycle: 'stale', corrected_by: 'new_m' });
    expect(replacement.memory_ids).toContain('new_m');
    expect(memory.recall({ space_id: 'correction', query: 'Tuesday' }).items.map((x) => x.id)).not.toContain('old_m');
    expect(memory.recall({ space_id: 'correction', query: 'Thursday' }).items.map((x) => x.id)).toContain('new_m');
    expect(memory.db.prepare("SELECT count(*) AS n FROM memories WHERE id='old_m'").get()).toMatchObject({ n: 1 });
  });

  it('excludes deleted memories from FTS and deactivates their links', () => {
    memory.record(input('forget', {
      entities: [{ id: 'person', name: 'Ria' }],
      memories: [{ id: 'forgotten', kind: 'note', content: 'secret orchid phrase' }],
      links: [{ from: { id: 'forgotten', type: 'memory' }, relation: 'about', to: { id: 'person', type: 'entity' } }],
    }));
    expect(memory.forget({ space_id: 'forget', memory_id: 'forgotten' })).toMatchObject({ deleted: true });
    expect(memory.recall({ space_id: 'forget', query: 'orchid' }).items).toHaveLength(0);
    expect(memory.db.prepare("SELECT count(*) AS n FROM memory_fts WHERE memory_id='forgotten'").get()).toMatchObject({ n: 0 });
    expect(memory.db.prepare("SELECT count(*) AS n FROM links WHERE from_id='forgotten' AND active=1").get()).toMatchObject({ n: 0 });
    expect(memory.timeline({ space_id: 'forget', include_stale: true }).items.map((item) => item.id)).not.toContain('forgotten');
  });

  it('does not write persistent data during recall', () => {
    memory.record(input('readonly', { memories: [{ kind: 'note', content: 'read only probe' }] }));
    const before = counts(memory.db);
    const schemaBefore = memory.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    memory.recall({ space_id: 'readonly', query: 'probe' });
    const changesBefore = (memory.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    memory.recall({ space_id: 'readonly', query: 'probe' });
    expect((memory.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n).toBe(changesBefore);
    expect(counts(memory.db)).toEqual(before);
    expect(memory.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()).toEqual(schemaBefore);
  });

  it('applies time and entity filters to recall results', () => {
    memory.record(input('filters', {
      entities: [{ id: 'ria', name: 'Ria' }, { id: 'sol', name: 'Sol' }],
      memories: [
        { id: 'm_old', kind: 'event', content: 'shared meeting', occurred_at: '2024-01-01T12:00:00Z', entity_ids: ['ria'] },
        { id: 'm_new', kind: 'event', content: 'shared meeting', occurred_at: '2024-03-01T12:00:00Z', entity_ids: ['sol'] },
      ],
    }));
    expect(memory.recall({ space_id: 'filters', query: 'meeting', from: '2024-02-01T00:00:00Z' }).items.map((x) => x.id)).toEqual(['m_new']);
    expect(memory.recall({ space_id: 'filters', query: 'meeting', entity_id: 'ria' }).items.map((x) => x.id)).toEqual(['m_old']);
  });

  it('treats equivalent timezone instants equally and rejects invalid calendar dates', () => {
    memory.record(input('date-zones', { memories: [
      { id: 'zone_date', kind: 'event', content: 'zone equivalence marker', occurred_at: '2024-02-29T12:00:00+02:00' },
    ] }));
    expect(memory.recall({ space_id: 'date-zones', at: '2024-02-29T10:00:00Z' }).items.map((item) => item.id)).toContain('zone_date');
    expect(() => memory.record(input('bad-date', { memories: [
      { kind: 'event', content: 'invalid date', occurred_at: '2024-02-30T10:00:00Z' },
    ] }))).toThrow();
  });

  it('keeps the entity filter hard when lexical and linked candidates differ', () => {
    memory.record(input('hard-entity', {
      entities: [{ id: 'ria', name: 'Ria' }, { id: 'sol', name: 'Sol' }],
      memories: [
        { id: 'ria_link', kind: 'note', content: 'ordinary note', entity_ids: ['ria'] },
        { id: 'sol_lexical', kind: 'note', content: 'rarely matched phrase', entity_ids: ['sol'] },
      ],
    }));
    const result = memory.recall({ space_id: 'hard-entity', query: 'rarely matched phrase', entity_id: 'ria' });
    expect(result.items.map((item) => item.id)).not.toContain('sol_lexical');
  });

  it('preserves a mention after resolving it to an entity', () => {
    memory.record(input('mentions', {
      entities: [{ id: 'ria', name: 'Ria' }],
      memories: [{ id: 'mention_m', kind: 'mention', content: 'the woman in a black cloak', resolution: 'unresolved', data: { mention: 'black-cloaked woman' } }],
    }));
    memory.resolveMention({ space_id: 'mentions', mention_id: 'mention_m', entity_id: 'ria' });
    expect(memory.db.prepare("SELECT kind,content,data,resolution FROM memories WHERE id='mention_m'").get()).toMatchObject({ kind: 'mention', content: 'the woman in a black cloak', resolution: 'resolved' });
    expect(memory.db.prepare("SELECT count(*) AS n FROM links WHERE from_id='mention_m' AND to_id='ria'").get()).toMatchObject({ n: 1 });
  });

  it('rejects resolving a deleted mention', () => {
    memory.record(input('deleted-mention', {
      entities: [{ id: 'ria', name: 'Ria' }],
      memories: [{ id: 'gone_mention', kind: 'mention', content: 'unresolved person reference', resolution: 'unresolved' }],
    }));
    memory.forget({ space_id: 'deleted-mention', memory_id: 'gone_mention' });
    expect(() => memory.resolveMention({ space_id: 'deleted-mention', mention_id: 'gone_mention', entity_id: 'ria' })).toThrow();
  });

  it('preserves entity references when correcting a memory', () => {
    memory.record(input('correct-refs', {
      entities: [{ id: 'ria', name: 'Ria' }],
      memories: [{ id: 'ref_old', kind: 'claim', content: 'Ria uses the west entrance', entity_ids: ['ria'] }],
    }));
    memory.correct({
      space_id: 'correct-refs', memory_id: 'ref_old',
      replacement: { id: 'ref_new', kind: 'claim', content: 'Ria uses the north entrance' },
      evidence: { source_type: 'correction', content: 'Entrance correction' },
    });
    expect(memory.db.prepare("SELECT count(*) AS n FROM links WHERE from_id='ref_new' AND to_id='ria' AND active=1").get()).toMatchObject({ n: 1 });
  });

  it('bounds assembled context by character budget', () => {
    memory.record(input('budget', { memories: [
      { id: 'long1', kind: 'note', content: 'alpha '.repeat(80) },
      { id: 'long2', kind: 'note', content: 'beta '.repeat(80) },
      { id: 'short', kind: 'note', content: 'small exact fact' },
    ] }));
    const result = memory.recall({ space_id: 'budget', query: 'small exact fact', limit: 20, max_chars: 80 });
    expect(result.items.map((item) => item.id)).toContain('short');
    expect(result.items.find((item) => item.id === 'short')?.content).toBe('small exact fact');
    const tooSmall = memory.recall({ space_id: 'budget', query: 'alpha', limit: 20, max_chars: 80 });
    expect(tooSmall.items).toHaveLength(0);
    expect(tooSmall.truncated).toBe(true);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.reduce((n, item) => n + item.content.length, 0)).toBeLessThanOrEqual(80);
  });

  it('pages timeline in deterministic time order and reports its time basis', () => {
    memory.record(input('timeline', { memories: [
      { id: 't1', kind: 'event', content: 'first', occurred_at: '2024-01-01T00:00:00Z' },
      { id: 't2', kind: 'event', content: 'second', occurred_at: '2024-01-02T00:00:00Z' },
      { id: 't3', kind: 'note', content: 'created-time fallback' },
    ] }));
    const first = memory.timeline({ space_id: 'timeline', limit: 2, offset: 0 });
    expect(first.items.map((x) => x.id)).toEqual(['t1', 't2']);
    expect(first.items.map((x) => x.time_basis)).toEqual(['occurred_at', 'occurred_at']);
    expect(first.next_offset).toBe(2);
    const second = memory.timeline({ space_id: 'timeline', limit: 2, offset: first.next_offset! });
    expect(second.items.map((x) => x.id)).toEqual(['t3']);
    expect(second.items[0]?.time_basis).toBe('created_at');
    expect(second.next_offset).toBeNull();
  });

  it('explains why a recalled item matched', () => {
    memory.record(input('explain', { memories: [{ id: 'explained', kind: 'note', content: 'A precise searchable comet fact' }] }));
    const result = memory.recall({ space_id: 'explain', query: 'comet' });
    const trace = memory.explain(result, 'explained');
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({ memory_id: 'explained', source_id: expect.any(String) });
    expect(trace[0]!.matched_by.length).toBeGreaterThan(0);
  });
});
