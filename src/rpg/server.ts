import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import { serveStdio as serveMcpStdio } from '@modelcontextprotocol/server/stdio';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { Memory } from '../memory.js';
import { MemoryRuntime } from '../runtime.js';
import { DEFAULT_OPENROUTER_DECISION_MODEL, OpenRouterDecisionProvider } from '../openrouter.js';
import { RpgCore } from './core.js';
import { createRpgMcp } from './mcp.js';
import { contracts, requireThat, type ToolName } from './contracts.js';
export async function serve(core: RpgCore, options: {
    port?: number;
    host?: string;
    devToken?: string;
    bearerToken?: string;
    publicUrl?: string;
    issuer?: string;
    audience?: string;
    jwksUrl?: string;
    scope?: string;
} = {}) {
    const host = options.host ?? '127.0.0.1';
    const dev = options.devToken;
    const bearer = options.bearerToken;
    const oidc = Boolean(options.issuer && options.audience && options.jwksUrl);
    requireThat(!dev || ['127.0.0.1', '::1'].includes(host), 'VALIDATION_ERROR', '개발 토큰은 loopback에서만 허용합니다.');
    requireThat([Boolean(dev), Boolean(bearer), oidc].filter(Boolean).length === 1, 'VALIDATION_ERROR', 'JWT, 운영 bearer 토큰, 로컬 개발 토큰 중 하나의 인증 설정이 필요합니다.');
    if (options.publicUrl)
        requireThat(new URL(options.publicUrl).protocol === 'https:', 'VALIDATION_ERROR', '공개 URL은 HTTPS여야 합니다.');
    const scope = options.scope ?? 'rpg';
    requireThat(/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope), 'VALIDATION_ERROR', 'OAuth scope는 공백 없는 단일 값이어야 합니다.');
    const resourceUrl = oidc ? new URL(options.audience!) : undefined;
    requireThat(!resourceUrl || (resourceUrl.protocol === 'https:' && resourceUrl.pathname === '/mcp' && !resourceUrl.username && !resourceUrl.password && !resourceUrl.search && !resourceUrl.hash), 'VALIDATION_ERROR', 'OAuth resource는 자격 증명·쿼리·fragment 없는 HTTPS /mcp URL이어야 합니다.');
    const metadataPath = '/.well-known/oauth-protected-resource/mcp';
    const metadataUrl = resourceUrl ? `${resourceUrl.origin}${metadataPath}` : undefined;
    const jwks = options.jwksUrl ? createRemoteJWKSet(new URL(options.jwksUrl)) : undefined;
    const resources = new Set<McpHttpHandler>();
    const http = createServer(async (req, res) => {
        if (req.url === '/health') {
            res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
            return;
        }
        if ([metadataPath, '/.well-known/oauth-protected-resource'].includes(req.url ?? '') && oidc) {
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ resource: options.audience, authorization_servers: [options.issuer], scopes_supported: [scope], bearer_methods_supported: ['header'] }));
            return;
        }
        if (req.url !== '/mcp') {
            res.writeHead(404).end();
            return;
        }
        const origin = req.headers.origin;
        const publicOrigin = options.publicUrl ? new URL(options.publicUrl).origin : options.audience ? new URL(options.audience).origin : `http://${host}:${(http.address() as any)?.port}`;
        if (origin && origin !== publicOrigin) {
            res.writeHead(403).end();
            return;
        }
        let user: string;
        try {
            const auth = req.headers.authorization ?? '';
            requireThat(auth.startsWith('Bearer '), 'UNAUTHENTICATED');
            const token = auth.slice(7);
            if (dev) {
                const a = Buffer.from(token), b = Buffer.from(dev);
                requireThat(a.length === b.length && timingSafeEqual(a, b), 'UNAUTHENTICATED');
                user = core.user('local-development', 'developer');
            }
            else if (bearer) {
                const a = Buffer.from(token), b = Buffer.from(bearer);
                requireThat(a.length === b.length && timingSafeEqual(a, b), 'UNAUTHENTICATED');
                user = core.user('static-bearer', 'operator');
            }
            else {
                const { payload } = await jwtVerify(token, jwks!, { issuer: options.issuer, audience: options.audience, requiredClaims: ['sub', 'exp', 'iat'] });
                requireThat(typeof payload.sub === 'string' && typeof payload.scope === 'string' && payload.scope.split(' ').includes(scope), 'UNAUTHENTICATED');
                user = core.user(options.issuer!, payload.sub);
            }
        }
        catch {
            const challenge = oidc ? `Bearer resource_metadata="${metadataUrl}", scope="${scope}"` : 'Bearer';
            res.writeHead(401, { 'WWW-Authenticate': challenge, 'Cache-Control': 'no-store' }).end();
            return;
        }
        if (req.method !== 'POST') {
            res.writeHead(405, { 'Allow': 'POST' }).end();
            return;
        }
        let parsed: unknown;
        try {
            let body = '';
            for await (const chunk of req) {
                body += chunk.toString();
                if (Buffer.byteLength(body) > 262144) {
                    res.writeHead(413).end();
                    return;
                }
            }
            parsed = JSON.parse(body);
        }
        catch {
            res.writeHead(400).end();
            return;
        }
        // Secure MCP Tunnel currently forwards the modern envelope and protocol
        // version but can omit SEP-2243 mirror headers. Restore them from the
        // authenticated JSON-RPC body before handing the request to the strict SDK.
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const message = parsed as { method?: unknown; params?: { name?: unknown; uri?: unknown; taskId?: unknown; _meta?: Record<string, unknown> } };
            const protocol = message.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
            if (!req.headers['mcp-protocol-version'] && typeof protocol === 'string')
                req.headers['mcp-protocol-version'] = protocol;
            if (!req.headers['mcp-method'] && typeof message.method === 'string')
                req.headers['mcp-method'] = message.method;
            const mirroredName = message.params?.name ?? message.params?.uri ?? message.params?.taskId;
            if (!req.headers['mcp-name'] && typeof mirroredName === 'string')
                req.headers['mcp-name'] = mirroredName;
        }
        const chatgptComplexTools = new Set<ToolName>([
            'rpg_game_time_schedule',
            'rpg_game_gm_note_write',
            'rpg_game_propose_expansion',
            'rpg_world_edit',
        ]);
        const diagnosticToolNames = process.env.RPG_CHATGPT_MINIMAL === 'true'
            ? new Set<ToolName>(['rpg_game_list'])
            : process.env.RPG_CHATGPT_SAFE_CATALOG === 'true'
                ? new Set<ToolName>((Object.keys(contracts) as ToolName[]).filter(name => !chatgptComplexTools.has(name)))
                : undefined;
        const handler = createMcpHandler(
            () => createRpgMcp(core, user, { oauthScope: oidc ? scope : undefined, toolNames: diagnosticToolNames }),
            { legacy: 'stateless', maxRequestBodySize: 262144 },
        );
        resources.add(handler);
        try {
            await toNodeHandler(handler, { maxRequestBodySize: 262144 })(req, res, parsed);
        }
        catch {
            if (!res.headersSent)
                res.writeHead(500).end();
        }
        finally {
            await handler.close();
            resources.delete(handler);
        }
    });
    await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(options.port ?? 3000, host, resolve); });
    return { http, close: async () => { await new Promise<void>((resolve, reject) => http.close(e => e ? reject(e) : resolve())); await Promise.all([...resources].map(r => r.close())); } };
}
export async function main() {
    const memory = new Memory(process.env.RPG_DB ?? 'rpg.db');
    const runtime = process.env.OPENROUTER_API_KEY ? new MemoryRuntime(memory, { decision: new OpenRouterDecisionProvider({ model: process.env.OPENROUTER_DECISION_MODEL ?? DEFAULT_OPENROUTER_DECISION_MODEL }) }) : undefined;
    const core = new RpgCore(memory, runtime);
    let close: () => Promise<void>;
    if (process.argv.includes('--stdio')) {
        const user = core.user('local-development', process.env.RPG_LOCAL_USER ?? 'developer');
        const server = serveMcpStdio(() => createRpgMcp(core, user));
        close = () => server.close();
    }
    else {
        const server = await serve(core, { port: Number(process.env.PORT ?? 3000), host: process.env.HOST ?? '127.0.0.1', devToken: process.env.RPG_DEV_TOKEN, bearerToken: process.env.RPG_BEARER_TOKEN, publicUrl: process.env.RPG_PUBLIC_URL, issuer: process.env.OIDC_ISSUER, audience: process.env.OIDC_AUDIENCE, jwksUrl: process.env.OIDC_JWKS_URL, scope: process.env.OIDC_SCOPE });
        console.error('RPG MCP server listening', server.http.address());
        close = server.close;
    }
    const stop = async () => { await close(); memory.close(); process.exit(0); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
}
