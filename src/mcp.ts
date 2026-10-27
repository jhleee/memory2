import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Memory } from './memory.js';
import { createRuntimeFromEnv, type RuntimeEnvOptions } from './runtime.js';
import type { MemoryRuntime } from './runtime.js';
import type { QueryInput, RecallResult, RuntimeQueryInput } from './types.js';

const jsonObject = z.record(z.string(), z.unknown());
const evidence = z.object({
  source_type: z.string().min(1), content: z.string(), metadata: jsonObject.optional(),
});
const memoryItem = z.object({
  id: z.string().optional(), kind: z.string().min(1), content: z.string(),
  data: jsonObject.optional(), occurred_at: z.string().optional(), valid_from: z.string().optional(),
  valid_to: z.string().optional(), lifecycle: z.enum(['pending', 'active']).optional(),
  resolution: z.enum(['unresolved', 'resolved']).optional(),
  support: z.enum(['asserted', 'supported', 'disputed']).optional(), entity_ids: z.array(z.string()).optional(),
});
const ref = z.object({ id: z.string().min(1), type: z.enum(['memory', 'entity', 'evidence']) });
const link = z.object({ from: ref, relation: z.string().min(1), to: ref, metadata: jsonObject.optional() });

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}
function failure(error: unknown) {
  return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] };
}

/** Create the MCP adapter. It owns no storage; all work goes through Memory. */
export function createMcpServer(memory: Memory, runtime?: MemoryRuntime): McpServer {
  const server = new McpServer({ name: 'context-memory', version: '0.1.0' });

  server.tool('memory_record', 'Store source evidence and structured memory items.', {
    space_id: z.string().min(1), evidence, memories: z.array(memoryItem).min(1),
    entities: z.array(z.object({ id: z.string().optional(), name: z.string().min(1), metadata: jsonObject.optional() })).optional(),
    links: z.array(link).optional(), idempotency_key: z.string().optional(),
  }, async (input) => {
    try { return result(runtime ? runtime.record(input) : memory.record(input)); } catch (error) { return failure(error); }
  });

  const recallSchema: z.ZodRawShape = {
    space_id: z.string().min(1), query: z.string().optional(), kind: z.string().optional(),
    entity_id: z.string().optional(), from: z.string().optional(), to: z.string().optional(),
    at: z.string().optional(), limit: z.number().int().positive().max(200).optional(),
    max_chars: z.number().int().positive().optional(), recent_since: z.string().optional(),
  };
  if (runtime) recallSchema.mode = z.enum(['lexical', 'hybrid', 'decision']).optional();
  server.tool('memory_recall', 'Search memories within one space.', {
    ...recallSchema,
  }, async (input) => {
    try { return result(runtime ? await runtime.recall(input as RuntimeQueryInput) : memory.recall(input as QueryInput)); } catch (error) { return failure(error); }
  });

  server.tool('memory_correct', 'Correct a memory while preserving its history.', {
    space_id: z.string().min(1), memory_id: z.string().min(1), replacement: memoryItem,
    evidence, expected_updated_at: z.string().optional(),
  }, async (input) => {
    try { return result(runtime ? runtime.correct(input) : memory.correct(input)); } catch (error) { return failure(error); }
  });

  server.tool('memory_forget', 'Logically delete a memory from future recall.', {
    space_id: z.string().min(1), memory_id: z.string().min(1),
  }, async (input) => {
    try { return result(runtime ? runtime.forget(input) : memory.forget(input)); } catch (error) { return failure(error); }
  });

  server.tool('memory_explain', 'Explain why a memory appears in a recall result.', {
    recall_result: z.unknown(), memory_id: z.string().optional(),
  }, async ({ recall_result, memory_id }) => {
    try { return result(memory.explain(recall_result as RecallResult, memory_id)); } catch (error) { return failure(error); }
  });

  server.tool('memory_timeline', 'Read memories in chronological order.', {
    space_id: z.string().min(1), entity_id: z.string().optional(), from: z.string().optional(),
    to: z.string().optional(), limit: z.number().int().positive().max(200).optional(),
    offset: z.number().int().nonnegative().optional(), include_stale: z.boolean().optional(),
  }, async (input) => {
    try { return result(memory.timeline(input)); } catch (error) { return failure(error); }
  });

  if (runtime) {
    server.tool('memory_index', 'Queue and process memory embeddings.', {
      space_id: z.string().min(1).optional(), retry: z.boolean().optional(),
    }, async (input) => {
      try { return result(await runtime.index(input)); } catch (error) { return failure(error); }
    });
    server.tool('memory_suggest', 'Suggest possible entity matches for an unresolved mention.', {
      space_id: z.string().min(1), memory_id: z.string().min(1), entity_ids: z.array(z.string()).optional(),
    }, async (input) => {
      try { return result(await runtime.suggestMention(input)); } catch (error) { return failure(error); }
    });
  }

  return server;
}

/** Run the MCP stdio transport. Protocol traffic is the only stdout output. */
export async function runMcp(path = './memory.db', runtimeOptions?: RuntimeEnvOptions): Promise<void> {
  const memory = new Memory(path);
  const runtime = runtimeOptions?.provider && runtimeOptions.provider !== 'none'
    ? createRuntimeFromEnv(memory, runtimeOptions)
    : undefined;
  const server = createMcpServer(memory, runtime);
  const transport = new StdioServerTransport();
  const keepAlive = setInterval(() => undefined, 60_000);
  let stop: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  transport.onclose = stop;
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.stdin.once('end', stop);
  try {
    await server.connect(transport);
    await stopped;
  } finally {
    clearInterval(keepAlive);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    process.stdin.removeListener('end', stop);
    await server.close();
    memory.close();
  }
}
