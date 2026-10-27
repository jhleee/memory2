#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { Memory } from './memory.js';
import { runMcp } from './mcp.js';
import { runHttp } from './http.js';
import { createRuntimeFromEnv, type RuntimeEnvOptions } from './runtime.js';
import type { RetrievalMode } from './types.js';

interface CliArgs {
  command: string;
  dbPath: string;
  provider: NonNullable<RuntimeEnvOptions['provider']>;
  model?: string;
  decisionModel?: string;
  dimensions?: number;
  retry: boolean;
  port: number;
  space?: string;
  query?: string;
  mode: RetrievalMode;
  memoryId?: string;
  entityIds?: string[];
}

function args(argv: string[]): CliArgs {
  const [command = 'help', ...rest] = argv;
  let dbPath: string | undefined;
  let provider: NonNullable<RuntimeEnvOptions['provider']> = command === 'embed' || command === 'index' ? 'ollama' : 'none';
  let model: string | undefined;
  let decisionModel: string | undefined;
  let dimensions: number | undefined;
  let port = 8787;
  let retry = false;
  let space: string | undefined;
  let query: string | undefined;
  let mode: RetrievalMode = 'lexical';
  let memoryId: string | undefined;
  let entityIds: string[] | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--retry') { retry = true; continue; }
    const options = ['--db', '--provider', '--model', '--decision-model', '--dimensions', '--port', '--space', '--query', '--mode', '--memory-id', '--entity-ids'];
    if (options.includes(arg!)) {
      const value = rest[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      switch (arg) {
        case '--db': dbPath = value; break;
        case '--provider':
          if (!['none', 'ollama', 'openrouter'].includes(value)) throw new Error('--provider must be none, ollama, or openrouter');
          provider = value as NonNullable<RuntimeEnvOptions['provider']>; break;
        case '--model': model = value; break;
        case '--decision-model': decisionModel = value; break;
        case '--dimensions': dimensions = Number(value); break;
        case '--port': port = Number(value); break;
        case '--space': space = value; break;
        case '--query': query = value; break;
        case '--mode':
          if (!['lexical', 'hybrid', 'decision'].includes(value)) throw new Error('--mode must be lexical, hybrid, or decision');
          mode = value as RetrievalMode; break;
        case '--memory-id': memoryId = value; break;
        case '--entity-ids': entityIds = value.split(',').filter(Boolean); break;
      }
      continue;
    }
    if (arg?.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    if (dbPath) throw new Error(`Unexpected argument: ${arg}`);
    dbPath = arg;
  }
  if (dimensions !== undefined && (!Number.isInteger(dimensions) || dimensions < 1)) throw new Error('--dimensions must be a positive integer');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be between 0 and 65535');
  return { command, dbPath: dbPath ?? './memory.db', provider, model, decisionModel, dimensions, retry, port, space, query, mode, memoryId, entityIds };
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function runtimeOptions(options: CliArgs): RuntimeEnvOptions {
  return {
    provider: options.provider,
    embeddingModel: options.model,
    decisionModel: options.decisionModel,
    dimensions: options.dimensions,
  };
}

async function main(): Promise<void> {
  const options = args(process.argv.slice(2));
  const { command, dbPath, provider, retry, port } = options;
  if (command === 'mcp') {
    await runMcp(dbPath, runtimeOptions(options));
    return;
  }
  if (command === 'init') {
    const memory = new Memory(dbPath);
    memory.close();
    process.stdout.write(`Initialized ${dbPath}\n`);
    return;
  }
  if (command === 'serve') {
    const memory = new Memory(dbPath);
    try {
      const runtime = provider === 'none' ? undefined : createRuntimeFromEnv(memory, runtimeOptions(options));
      const { server, url, token } = await runHttp(memory, port, runtime);
      process.stdout.write(`Dashboard: ${url}\nToken: ${token}\n`);
      await new Promise<void>((resolve, reject) => {
        const stop = () => server.close(error => error ? reject(error) : resolve());
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        server.once('error', reject);
      });
    } finally {
      memory.close();
    }
    return;
  }
  if (command === 'demo') {
    const memory = new Memory(dbPath);
    try {
      const now = new Date().toISOString();
      const runId = randomUUID();
      const ids = { original: `demo-transfer-${runId}`, corrected: `demo-transfer-corrected-${runId}`, lia: `entity-lia-${runId}`, key: `entity-key-${runId}`, mina: `entity-mina-${runId}` };
      const recorded = memory.record({
        space_id: 'demo-project', evidence: { source_type: 'demo', content: 'Lia handed the key to someone.' },
        memories: [{ id: ids.original, kind: 'event', content: 'Lia handed the key to someone.', data: { type: 'transfer', giver: ids.lia, receiver: { state: 'unknown' }, object: ids.key }, occurred_at: now, resolution: 'unresolved', entity_ids: [ids.lia, ids.key] }],
        entities: [{ id: ids.lia, name: 'Lia' }, { id: ids.key, name: 'Key' }, { id: ids.mina, name: 'Mina' }],
      });
      print({ step: 'record with unknown receiver', ...recorded });
      const correction = memory.correct({
        space_id: 'demo-project', memory_id: ids.original,
        evidence: { source_type: 'demo-correction', content: 'Lia handed the key to Mina.' },
        replacement: { id: ids.corrected, kind: 'event', content: 'Lia handed the key to Mina.', data: { type: 'transfer', giver: ids.lia, receiver: ids.mina, object: ids.key }, occurred_at: now, resolution: 'resolved', entity_ids: [ids.lia, ids.key, ids.mina] },
      });
      print({ step: 'correction', ...correction });
      memory.record({ space_id: 'another-space', evidence: { source_type: 'demo', content: 'Private memory in another space.' }, memories: [{ kind: 'note', content: 'Private memory in another space.' }] });
      print({ step: 'space-safe recall', result: memory.recall({ space_id: 'demo-project' }) });
      print({ step: 'forget corrected memory', result: memory.forget({ space_id: 'demo-project', memory_id: ids.corrected }) });
      print({ step: 'recall after forget', result: memory.recall({ space_id: 'demo-project' }) });
    } finally { memory.close(); }
    return;
  }
  if (command === 'index' || command === 'embed') {
    if (provider === 'none') throw new Error(`${command} requires --provider ollama or --provider openrouter`);
    const memory = new Memory(dbPath);
    try {
      const runtime = createRuntimeFromEnv(memory, runtimeOptions(options));
      const result = await runtime.index({ space_id: options.space, retry });
      print(result);
      if (result.failed > 0) process.exitCode = 1;
    } finally { memory.close(); }
    return;
  }
  if (command === 'recall') {
    if (!options.space) throw new Error('recall requires --space <space_id>');
    const memory = new Memory(dbPath);
    try {
      const runtime = provider === 'none' ? undefined : createRuntimeFromEnv(memory, runtimeOptions(options));
      if (options.mode !== 'lexical' && !runtime) throw new Error(`recall mode ${options.mode} requires --provider ollama or --provider openrouter`);
      const result = runtime ? await runtime.recall({ space_id: options.space, query: options.query, mode: options.mode }) : memory.recall({ space_id: options.space, query: options.query });
      print({ result, diagnostics: runtime?.status(options.space) ?? { provider: 'none', retrieval: 'lexical' } });
    } finally { memory.close(); }
    return;
  }
  if (command === 'suggest') {
    if (!options.space || !options.memoryId) throw new Error('suggest requires --space <space_id> --memory-id <id>');
    if (provider === 'none') throw new Error('suggest requires --provider ollama or --provider openrouter');
    const memory = new Memory(dbPath);
    try {
      const runtime = createRuntimeFromEnv(memory, runtimeOptions(options));
      print(await runtime.suggestMention({ space_id: options.space, memory_id: options.memoryId, entity_ids: options.entityIds }));
    } finally { memory.close(); }
    return;
  }
  process.stdout.write('Usage: context-memory <init|demo|mcp|serve|index|recall|suggest> [--db <path>] [--provider none|ollama|openrouter] [--model <name>] [--decision-model <name>] [--dimensions <n>] [--space <id>] [--query <text>] [--mode lexical|hybrid|decision] [--memory-id <id>] [--entity-ids id1,id2] [--retry]\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
