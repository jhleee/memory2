import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory } from '../src/memory.js';
import { MemoryRuntime } from '../src/runtime.js';
import type { DecisionProvider, EmbeddingProvider, RecordInput, VectorIndex } from '../src/types.js';

const opened: Memory[] = [];
afterEach(() => {
  for (const memory of opened.splice(0)) memory.close();
});
function db(path = ':memory:'): Memory {
  const memory = new Memory(path);
  opened.push(memory);
  return memory;
}
function recordInput(space_id: string, content: string, extra: Partial<RecordInput> = {}): RecordInput {
  return { space_id, evidence: { source_type: 'test', content }, memories: [{ kind: 'note', content }], ...extra };
}
function add(memory: Memory, space_id: string, content: string, entity_ids?: string[]): string {
  return memory.record(recordInput(space_id, content, { memories: [{ kind: 'note', content, entity_ids }] })).memory_ids[0]!;
}
const embeddings: EmbeddingProvider = {
  model: 'fake-v1', dimensions: 2,
  async embed(texts) { return texts.map((text) => text.toLowerCase().includes('narwhal') ? [1, 0] : [0, 1]); },
};
class FakeIndex implements VectorIndex {
  constructor(memory: Memory) { memory.db.exec("CREATE TABLE IF NOT EXISTS embeddings (memory_id TEXT NOT NULL, model TEXT NOT NULL, hash TEXT NOT NULL DEFAULT '', dimensions INTEGER NOT NULL DEFAULT 2) STRICT;"); }
  added: string[] = [];
  removed: string[] = [];
  hits: { memory_id: string; score: number }[] = [];
  lastSearch?: { space_id: string; model: string; limit: number; filters?: unknown };
  add(memory_id: string): void { this.added.push(memory_id); }
  remove(memory_id: string): void { this.removed.push(memory_id); }
  search(_vector: number[], input: { space_id: string; model: string; limit: number; filters?: any }) {
    this.lastSearch = input;
    return this.hits.length ? this.hits : [];
  }
}
function embeddingProvider(onEmbed: (texts: string[]) => Promise<number[][]>, model = 'fake-v1'): EmbeddingProvider {
  return { model, dimensions: 2, embed: onEmbed };
}
function tableCounts(memory: Memory): Record<string, number> {
  const tables = memory.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return Object.fromEntries(tables.map(({ name }) => {
    const n = memory.db.prepare(`SELECT COUNT(*) n FROM "${name.replaceAll('"', '""')}"`).get() as { n: number };
    return [name, n.n];
  }));
}

describe('MemoryRuntime optional providers', () => {
  it('supports a replaceable vector index without requiring an embeddings SQL table', async () => {
    const memory=db();
    let target='';
    const custom:VectorIndex={add(){},remove(){},search(){return [{memory_id:target,score:.99}];}};
    const runtime=new MemoryRuntime(memory,{embedding:embeddings,index:custom});
    target=runtime.record(recordInput('custom','narwhal remembered')).memory_ids[0];
    expect(await runtime.index({space_id:'custom'})).toMatchObject({processed:1,failed:0});
    const result=await runtime.recall({space_id:'custom',query:'unmatched concept',mode:'hybrid'});
    expect(result.items.map(item=>item.id)).toEqual([target]);
    expect(result.retrieval).toMatchObject({used:'hybrid',warnings:[]});
    expect(memory.db.prepare("SELECT name FROM sqlite_master WHERE name='embeddings'").get()).toBeUndefined();
  });
  it('validates a Decision request limit before expanding its candidate pool', async () => {
    const runtime=new MemoryRuntime(db());
    for(const limit of [0,-1,201,1.5])await expect(runtime.recall({space_id:'invalid',mode:'decision',limit})).rejects.toThrow('limit');
  });
  it('enqueues only the affected space and memory IDs on record and correction', async () => {
    const memory = db();
    const index = new FakeIndex(memory);
    const runtime = new MemoryRuntime(memory, { embedding: embeddings, index });
    const a = runtime.record(recordInput('space-a', 'first item'));
    runtime.record(recordInput('space-b', 'other space'));
    const oldId = a.memory_ids[0]!;
    runtime.correct({ space_id: 'space-a', memory_id: oldId, evidence: { source_type: 'test', content: 'corrected' }, replacement: { kind: 'note', content: 'replacement item' } });
    const jobs = memory.db.prepare(`SELECT j.memory_id,m.space_id,j.state FROM jobs j JOIN memories m ON m.id=j.memory_id ORDER BY j.id`).all();
    expect(jobs).toHaveLength(3);
    const jobRows = jobs as { memory_id: string; space_id: string; state: string }[];
    expect(jobRows.some((row) => row.memory_id === oldId && row.space_id === 'space-a' && row.state === 'done')).toBe(true);
    expect(jobRows.some((row) => row.space_id === 'space-b' && row.state === 'pending')).toBe(true);
    expect(jobRows.some((row) => row.memory_id !== oldId && row.space_id === 'space-a' && row.state === 'pending')).toBe(true);
    expect(index.removed).toContain(oldId);
  });

  it('indexes only the requested space and batches provider input', async () => {
    const memory = db();
    const batches: string[][] = [];
    const embedding = embeddingProvider(async (texts) => { batches.push([...texts]); return texts.map(() => [1, 0]); });
    const runtime = new MemoryRuntime(memory, { embedding });
    const a1 = runtime.record(recordInput('a', 'a first'));
    const a2 = runtime.record(recordInput('a', 'a second'));
    const b = runtime.record(recordInput('b', 'b remains queued'));
    const result = await runtime.index({ space_id: 'a' });
    expect(result).toMatchObject({ processed: 2, failed: 0 });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual(['a first', 'a second']);
    expect(memory.db.prepare("SELECT COUNT(*) n FROM jobs j JOIN memories m ON m.id=j.memory_id WHERE m.space_id='b' AND j.state='pending'").get()).toMatchObject({ n: 1 });
    expect(memory.db.prepare('SELECT COUNT(*) n FROM embeddings e JOIN memories m ON m.id=e.memory_id WHERE m.space_id=\'a\'').get()).toMatchObject({ n: 2 });
    expect([a1.memory_ids[0], a2.memory_ids[0], b.memory_ids[0]]).toHaveLength(3);
  });

  it('resumes queued work after reopening the SQLite database', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'memory-runtime-'));
    const path = join(directory, 'resume.db');
    const first = db(path);
    new MemoryRuntime(first, { embedding: embeddings }).record(recordInput('persisted', 'queued after restart'));
    first.close();
    opened.splice(opened.indexOf(first), 1);
    const reopened = db(path);
    const runtime = new MemoryRuntime(reopened, { embedding: embeddings });
    expect(await runtime.index({ space_id: 'persisted' })).toMatchObject({ processed: 1, failed: 0 });
    expect(reopened.db.prepare('SELECT state FROM jobs').get()).toEqual({ state: 'done' });
    rmSync(directory, { recursive: true, force: true });
  });

  it('reapplies space and entity eligibility after more than 200 unrelated vector hits', async () => {
    const memory = db();
    memory.record(recordInput('target-space', 'entity setup', {
      entities: [{ id: 'wanted', name: 'Wanted' }, { id: 'other', name: 'Other' }],
      memories: [{ kind: 'note', content: 'entity setup' }],
    }));
    const unrelated: string[] = [];
    for (let i = 0; i < 205; i++) unrelated.push(add(memory, 'target-space', `noise ${i}`, ['other']));
    const wanted = add(memory, 'target-space', 'semantically close narwhal fact', ['wanted']);
    const foreign = add(memory, 'foreign-space', 'narwhal from another space');
    const index = new FakeIndex(memory);
    index.hits = [...unrelated, foreign, wanted].map((memory_id, i) => ({ memory_id, score: 1 - i / 1000 }));
    const runtime = new MemoryRuntime(memory, { embedding: embeddings, index });
    const result = await runtime.recall({ space_id: 'target-space', query: 'concept with no lexical match', entity_id: 'wanted', mode: 'hybrid', limit: 20 });
    expect(index.lastSearch?.limit).toBe(200);
    expect(index.lastSearch?.filters).toMatchObject({ space_id: 'target-space', entity_id: 'wanted' });
    expect(result.items.map((item) => item.id)).toEqual([wanted]);
    expect(result.items.map((item) => item.id)).not.toContain(foreign);
  });

  it('falls back to lexical recall with safe diagnostics and never stores provider error text', async () => {
    const memory = db();
    const id = add(memory, 'failure', 'searchable fallback fact');
    const secret = 'sk-test-never-persist-this';
    const failing = embeddingProvider(async () => { throw new Error(`provider failed with ${secret}`); });
    const runtime = new MemoryRuntime(memory, { embedding: failing, index: new FakeIndex(memory) });
    const result = await runtime.recall({ space_id: 'failure', query: 'fallback', mode: 'hybrid' });
    expect(result.items.map((item) => item.id)).toContain(id);
    expect(result.retrieval).toMatchObject({ requested: 'hybrid', used: 'lexical' });
    expect(result.retrieval?.warnings).toContain('Embedding request failed; lexical recall used.');
    const allRows = memory.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    const serialized = allRows.map(({ name }) => JSON.stringify(memory.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all())).join('\n');
    expect(serialized).not.toContain(secret);
  });

  it('reports a lexical fallback when a requested mode has no provider', async () => {
    const memory = db();
    const id = add(memory, 'offline', 'ordinary lexical result');
    const result = await new MemoryRuntime(memory).recall({ space_id: 'offline', query: 'ordinary', mode: 'hybrid' });
    expect(result.items.map((item) => item.id)).toContain(id);
    expect(result.retrieval).toMatchObject({ requested: 'hybrid', used: 'lexical', warnings: ['Embedding provider is disabled; lexical recall used.'] });
  });

  it('lets Decision reorder returned candidates without permanently changing memory state', async () => {
    const memory = db();
    const low = add(memory, 'decision', 'query token low relevance');
    const high = add(memory, 'decision', 'query token high relevance');
    const before = tableCounts(memory);
    const decision: DecisionProvider & { model: string } = { model: 'fake-decision', async suggest(_question, candidates) {
      return candidates.map((candidate) => ({ id: candidate.id, score: candidate.id === high ? 0.99 : 0.1, reason: 'fake ranking only' }));
    } };
    const result = await new MemoryRuntime(memory, { decision }).recall({ space_id: 'decision', query: 'query token', mode: 'decision' });
    expect(result.items.slice(0, 2).map((item) => item.id)).toEqual([high, low]);
    expect(result.retrieval).toMatchObject({ requested: 'decision', used: 'decision', decision_model: 'fake-decision' });
    expect(result.traces.find((trace) => trace.memory_id === high)?.matched_by).toContain('decision');
    expect(tableCounts(memory)).toEqual(before);
  });

  it('drops a candidate deleted while awaiting Decision before returning results', async () => {
    const memory = db();
    const first = add(memory, 'decision-race', 'shared query content first');
    add(memory, 'decision-race', 'shared query content second');
    const decision: DecisionProvider = { async suggest(_question, candidates) {
      memory.forget({ space_id: 'decision-race', memory_id: first });
      return candidates.map((candidate, index) => ({ id: candidate.id, score: 1 - index * 0.1, reason: 'ranked' }));
    } };
    const result = await new MemoryRuntime(memory, { decision }).recall({ space_id: 'decision-race', query: 'shared query', mode: 'decision' });
    expect(result.items.map((item) => item.id)).not.toContain(first);
    expect(result.traces.map((trace) => trace.memory_id)).not.toContain(first);
  });

  it('does not call Decision for missing or cross-space mention candidates', async () => {
    const memory = db();
    const mention = add(memory, 'mention-a', 'person with a striped coat');
    memory.db.prepare("UPDATE memories SET kind='mention',resolution='unresolved' WHERE id=?").run(mention);
    memory.record(recordInput('mention-b', 'entity setup', { entities: [{ id: 'only-b', name: 'Other-space person' }], memories: [{ kind: 'note', content: 'setup' }] }));
    let calls = 0;
    const decision: DecisionProvider = { async suggest() { calls++; return []; } };
    const runtime = new MemoryRuntime(memory, { decision });
    await expect(runtime.suggestMention({ space_id: 'mention-a', memory_id: mention, entity_ids: ['only-b'] })).rejects.toThrow();
    await expect(runtime.suggestMention({ space_id: 'mention-a', memory_id: 'missing', entity_ids: ['only-b'] })).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it('returns mention suggestions as proposals and keeps the mention unresolved', async () => {
    const memory = db();
    const result = memory.record(recordInput('suggest', 'mention evidence', {
      entities: [{ id: 'ria', name: 'Ria', metadata: { hair: 'black' } }, { id: 'sol', name: 'Sol' }],
      memories: [{ id: 'mention', kind: 'mention', content: 'the person with black hair', data: { clothing: 'blue' }, resolution: 'unresolved' }],
    }));
    const before = tableCounts(memory);
    const decision: DecisionProvider = { async suggest() { return [{ id: 'ria', score: 0.8, reason: 'matching attribute' }]; } };
    const proposals = await new MemoryRuntime(memory, { decision }).suggestMention({ space_id: 'suggest', memory_id: result.memory_ids[0]!, entity_ids: ['ria', 'sol'] });
    expect(proposals).toMatchObject({ memory_id: 'mention', unresolved: true, suggestions: [{ id: 'ria', score: 0.8 }] });
    expect(memory.db.prepare("SELECT kind,content,resolution,data FROM memories WHERE id='mention'").get()).toMatchObject({ kind: 'mention', content: 'the person with black hair', resolution: 'unresolved', data: JSON.stringify({ clothing: 'blue' }) });
    expect(tableCounts(memory)).toEqual(before);
  });

  it('retries failed indexing jobs and stores only a sanitized failure', async () => {
    const memory = db();
    const id = add(memory, 'retry', 'eventually indexed');
    let fail = true;
    const secret = 'provider-private-token';
    const embedding = embeddingProvider(async (texts) => {
      if (fail) throw new Error(secret);
      return texts.map(() => [1, 0]);
    }, 'retry-model');
    const runtime = new MemoryRuntime(memory, { embedding });
    const first = await runtime.index({ space_id: 'retry' });
    expect(first).toMatchObject({ processed: 1, failed: 1 });
    expect(memory.db.prepare('SELECT state,error,attempts FROM jobs').get()).toEqual({ state: 'failed', error: 'Embedding provider request failed', attempts: 1 });
    fail = false;
    const second = await runtime.index({ space_id: 'retry', retry: true });
    expect(second).toMatchObject({ processed: 1, failed: 0 });
    expect(memory.db.prepare('SELECT state,error,attempts FROM jobs').get()).toEqual({ state: 'done', error: null, attempts: 2 });
    expect(memory.db.prepare('SELECT memory_id FROM embeddings').get()).toEqual({ memory_id: id });
    expect(JSON.stringify(memory.db.prepare('SELECT * FROM jobs').all())).not.toContain(secret);
  });

  it('rolls back a record when enqueue fails inside the transaction', () => {
    const memory = db();
    const runtime = new MemoryRuntime(memory, { embedding: embeddings, index: new FakeIndex(memory) });
    runtime.worker!.enqueue = () => { throw new Error('queue unavailable'); };
    expect(() => runtime.record(recordInput('rollback', 'must not persist'))).toThrow('queue unavailable');
    expect(memory.db.prepare("SELECT COUNT(*) n FROM spaces WHERE id='rollback'").get()).toMatchObject({ n: 0 });
    expect(memory.db.prepare('SELECT COUNT(*) n FROM evidence').get()).toMatchObject({ n: 0 });
    expect(memory.db.prepare('SELECT COUNT(*) n FROM memories').get()).toMatchObject({ n: 0 });
  });
});
