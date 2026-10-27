import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Memory } from '../src/memory.js';
import { createMcpServer } from '../src/mcp.js';
import { MemoryRuntime } from '../src/runtime.js';

const memories: Memory[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const memory of memories.splice(0)) memory.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function inMemoryPair() {
  const memory = new Memory(':memory:');
  memories.push(memory);
  const server = createMcpServer(memory);
  const client = new Client({ name: 'context-memory-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  return { memory, server, client, clientTransport, serverTransport };
}

function text(result: unknown): string {
  if (!result || typeof result !== 'object' || !('content' in result) || !Array.isArray(result.content)) {
    throw new Error('MCP tool returned no content');
  }
  const block = result.content.find((item: { type?: string; text?: string }) => item.type === 'text');
  if (!block?.text) throw new Error('MCP tool returned no text content');
  return block.text;
}

describe('MCP adapter', () => {
  it('registers all six tools and records, recalls, explains, and scopes results', async () => {
    const { memory, server, client, clientTransport, serverTransport } = inMemoryPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        'memory_correct', 'memory_explain', 'memory_forget', 'memory_recall', 'memory_record', 'memory_timeline',
      ]);

      const recorded = await client.callTool({ name: 'memory_record', arguments: {
        space_id: 'alpha', evidence: { source_type: 'test', content: 'Original evidence text' },
        memories: [{ id: 'alpha-note', kind: 'note', content: 'The MCP adapter remembers a comet.' }],
      } });
      expect(recorded.isError).not.toBe(true);
      expect(JSON.parse(text(recorded))).toMatchObject({ accepted: true, memory_ids: ['alpha-note'] });

      memory.record({ space_id: 'beta', evidence: { source_type: 'test', content: 'Other evidence' }, memories: [{ id: 'beta-note', kind: 'note', content: 'A secret in another space.' }] });
      const recalled = await client.callTool({ name: 'memory_recall', arguments: { space_id: 'alpha', query: 'comet' } });
      const recallValue = JSON.parse(text(recalled)) as { items: { id: string }[] };
      expect(recallValue.items.map((item) => item.id)).toEqual(['alpha-note']);
      const explained = await client.callTool({ name: 'memory_explain', arguments: { recall_result: recallValue, memory_id: 'alpha-note' } });
      expect(JSON.parse(text(explained))).toMatchObject([{ memory_id: 'alpha-note', source_id: expect.any(String) }]);

      const invalid = await client.callTool({ name: 'memory_record', arguments: {
        space_id: 'alpha', evidence: { source_type: 'test', content: 'Invalid link' },
        memories: [{ id: 'invalid-note', kind: 'note', content: 'Invalid link payload' }],
        links: [{ from: { id: 'invalid-note', type: 'memory' }, relation: 'about', to: { id: 'beta-note', type: 'memory' } }],
      } });
      expect(invalid.isError).toBe(true);
      expect(memory.recall({ space_id: 'alpha', query: 'secret' }).items).toHaveLength(0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('adds hybrid indexing and unresolved mention suggestions when a runtime is configured', async () => {
    const memory = new Memory(':memory:');
    memories.push(memory);
    const runtime = new MemoryRuntime(memory, {
      embedding: { model: 'test-embedding', dimensions: 2, async embed(texts) { return texts.map(() => [1, 0]); } },
      decision: { async suggest(_question, candidates) { return candidates.map(candidate => ({ id: candidate.id, score: 0.7, reason: 'test suggestion' })); } },
    });
    const server = createMcpServer(memory, runtime);
    const client = new Client({ name: 'context-memory-runtime-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual([
        'memory_correct', 'memory_explain', 'memory_forget', 'memory_index', 'memory_recall', 'memory_record', 'memory_suggest', 'memory_timeline',
      ]);
      const recorded = await client.callTool({ name: 'memory_record', arguments: {
        space_id: 'runtime-space', evidence: { source_type: 'test', content: 'Black cloak mention evidence.' },
        entities: [{ id: 'lia', name: 'Lia' }],
        memories: [{ id: 'cloak-mention', kind: 'mention', content: 'Woman in a black cloak', resolution: 'unresolved' }],
      } });
      expect(recorded.isError).not.toBe(true);
      const indexed = await client.callTool({ name: 'memory_index', arguments: { space_id: 'runtime-space' } });
      expect(JSON.parse(text(indexed))).toMatchObject({ queued: 0, processed: 1, failed: 0 });
      const recalled = await client.callTool({ name: 'memory_recall', arguments: { space_id: 'runtime-space', query: 'cloak', mode: 'hybrid' } });
      expect(JSON.parse(text(recalled))).toMatchObject({ retrieval: { requested: 'hybrid', used: 'hybrid' } });
      const suggestion = await client.callTool({ name: 'memory_suggest', arguments: { space_id: 'runtime-space', memory_id: 'cloak-mention' } });
      expect(JSON.parse(text(suggestion))).toMatchObject({ unresolved: true, suggestions: [{ id: 'lia', score: 0.7 }] });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('speaks clean MCP protocol over the built stdio CLI', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'context-memory-mcp-'));
    directories.push(directory);
    const dbPath = join(directory, 'memory.db');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(process.cwd(), 'dist/src/cli.js'), 'mcp', '--db', dbPath],
      cwd: process.cwd(),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'context-memory-stdio-test', version: '1.0.0' });
    let phase = 'connect';
    try {
      await client.connect(transport);
      phase = 'list tools';
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(6);
      phase = 'call recall';
      const called = await client.callTool({ name: 'memory_recall', arguments: { space_id: 'empty-space' } });
      expect(called.isError).not.toBe(true);
      expect(JSON.parse(text(called))).toMatchObject({ items: [], sources: [] });
    } catch (error) {
      throw new Error(`stdio phase ${phase}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await client.close();
    }
  }, 15_000);
});
