import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { RecordInput, RuntimeQueryInput, CorrectInput, ForgetInput, TimelineInput, RecallResult } from './types.js';
import type { Memory } from './memory.js';
import { MemoryRuntime } from './runtime.js';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 1024 * 1024;

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:" });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body as string);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(part);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw Object.assign(new Error('Expected a JSON object'), { status: 400 }); }
}

export function createHttpServer(memory: Memory, options: { token?: string; runtime?: MemoryRuntime } = {}): Server {
  const token = options.token ?? randomBytes(32).toString('hex');
  if (!token) throw new TypeError('token must not be empty');
  const recallRuntime = options.runtime ?? new MemoryRuntime(memory);
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const origin = req.headers.origin;
      if (origin) {
        let parsed: URL;
        try { parsed = new URL(origin); } catch { return send(res, 403, { error: 'Origin rejected' }); }
        const host = req.headers.host;
        if (!host || parsed.host !== host || !['http:', 'https:'].includes(parsed.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) return send(res, 403, { error: 'Origin rejected' });
      }
      if (url.pathname === '/' && req.method === 'GET') {
        let html: string;
        try { html = await readFile(resolve(moduleDir, 'dashboard.html'), 'utf8'); }
        catch { html = await readFile(resolve(moduleDir, '../../src/dashboard.html'), 'utf8'); }
        return send(res, 200, html, 'text/html; charset=utf-8');
      }
      if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
      const supplied = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? '';
      const a = Buffer.from(supplied), b = Buffer.from(token);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return send(res, 401, { error: 'Unauthorized' });
      if (req.method === 'GET' && url.pathname === '/api/spaces') {
        const rows = memory.db.prepare(`SELECT s.id, s.created_at,
          (SELECT count(*) FROM memories m WHERE m.space_id=s.id AND m.lifecycle='active') AS memories,
          (SELECT count(*) FROM entities e WHERE e.space_id=s.id) AS entities,
          (SELECT count(*) FROM evidence v WHERE v.space_id=s.id) AS evidence
          FROM spaces s ORDER BY s.created_at DESC`).all();
        return send(res, 200, rows);
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        return send(res, 200, recallRuntime.status(url.searchParams.get('space_id') ?? undefined));
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
      if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) return send(res, 415, { error: 'Content-Type must be application/json' });
      const input = await readJson(req);
      let result: unknown;
      switch (url.pathname) {
        case '/api/record': result = options.runtime ? options.runtime.record(input as unknown as RecordInput) : memory.record(input as unknown as RecordInput); break;
        case '/api/recall': result = await recallRuntime.recall(input as unknown as RuntimeQueryInput); break;
        case '/api/explain': {
          const query = input as unknown as RuntimeQueryInput & { memory_id?: string };
          const recalled = await recallRuntime.recall(query);
          result = memory.explain(recalled as RecallResult, query.memory_id);
          break;
        }
        case '/api/correct': result = options.runtime ? options.runtime.correct(input as unknown as CorrectInput) : memory.correct(input as unknown as CorrectInput); break;
        case '/api/forget': result = options.runtime ? options.runtime.forget(input as unknown as ForgetInput) : memory.forget(input as unknown as ForgetInput); break;
        case '/api/timeline': result = memory.timeline(input as unknown as TimelineInput); break;
        case '/api/resolve': result = memory.resolveMention(input as unknown as { space_id: string; mention_id: string; entity_id: string }); break;
        case '/api/index':
          if (!options.runtime) return send(res, 400, { error: 'Runtime provider is disabled' });
          result = await options.runtime.index(input as { space_id?: string; retry?: boolean });
          break;
        case '/api/suggest':
          if (!options.runtime) return send(res, 400, { error: 'Runtime provider is disabled' });
          result = await options.runtime.suggestMention(input as { space_id: string; memory_id: string; entity_ids?: string[] });
          break;
        default: return send(res, 404, { error: 'Not found' });
      }
      return send(res, 200, result);
    } catch (err) {
      const status = Number((err as { status?: number })?.status) || 400;
      const message = err instanceof Error ? err.message : 'Request failed';
      return send(res, status, { error: message });
    }
  });
}

export async function runHttp(memory: Memory, port = 8787, runtime?: MemoryRuntime): Promise<{ server: Server; url: string; token: string }> {
  const token = randomBytes(32).toString('hex');
  const server = createHttpServer(memory, { token, runtime });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return { server, url: `http://127.0.0.1:${actualPort}`, token };
}
