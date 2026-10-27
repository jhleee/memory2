import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Memory } from '../memory.js';
import { MemoryRuntime } from '../runtime.js';
import { OpenRouterDecisionProvider } from '../openrouter.js';
import { RpgCore } from './core.js';
import { createRpgMcp } from './mcp.js';
import { requireThat } from './contracts.js';
export async function serve(core: RpgCore, options: {
    port?: number;
    host?: string;
    devToken?: string;
    issuer?: string;
    audience?: string;
    jwksUrl?: string;
    scope?: string;
} = {}) {
    const host = options.host ?? '127.0.0.1';
    const dev = options.devToken;
    requireThat(!dev || ['127.0.0.1', '::1'].includes(host), 'VALIDATION_ERROR', '개발 토큰은 loopback에서만 허용합니다.');
    requireThat(dev || options.issuer && options.audience && options.jwksUrl, 'VALIDATION_ERROR', 'JWT 인증 설정 또는 로컬 개발 토큰이 필요합니다.');
    const jwks = options.jwksUrl ? createRemoteJWKSet(new URL(options.jwksUrl)) : undefined;
    const resources = new Set<{
        server: ReturnType<typeof createRpgMcp>;
        transport: StreamableHTTPServerTransport;
    }>();
    const http = createServer(async (req, res) => {
        if (req.url === '/health') {
            res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
            return;
        }
        if (req.url === '/.well-known/oauth-protected-resource' && !dev) {
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ resource: options.audience, authorization_servers: [options.issuer], scopes_supported: [options.scope ?? 'rpg'] }));
            return;
        }
        if (req.url !== '/mcp') {
            res.writeHead(404).end();
            return;
        }
        const origin = req.headers.origin;
        const publicOrigin = options.audience ? new URL(options.audience).origin : `http://${host}:${(http.address() as any)?.port}`;
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
            else {
                const { payload } = await jwtVerify(token, jwks!, { issuer: options.issuer, audience: options.audience, requiredClaims: ['sub', 'exp', 'iat'] });
                requireThat(typeof payload.sub === 'string' && typeof payload.scope === 'string' && payload.scope.split(' ').includes(options.scope ?? 'rpg'), 'UNAUTHENTICATED');
                user = core.user(options.issuer!, payload.sub);
            }
        }
        catch {
            res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${publicOrigin}/.well-known/oauth-protected-resource"` }).end();
            return;
        }
        if (req.method !== 'POST') {
            res.writeHead(405, { 'Allow': 'POST' }).end();
            return;
        }
        let body = '';
        try {
            for await (const chunk of req) {
                body += chunk.toString();
                if (Buffer.byteLength(body) > 262144) {
                    res.writeHead(413).end();
                    return;
                }
            }
        }
        catch {
            res.writeHead(400).end();
            return;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(body);
        }
        catch {
            res.writeHead(400).end();
            return;
        }
        const server = createRpgMcp(core, user);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        const resource = { server, transport };
        resources.add(resource);
        try {
            await server.connect(transport);
            await transport.handleRequest(req, res, parsed);
        }
        catch {
            if (!res.headersSent)
                res.writeHead(500).end();
        }
        finally {
            await server.close();
            resources.delete(resource);
        }
    });
    await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(options.port ?? 3000, host, resolve); });
    return { http, close: async () => { await new Promise<void>((resolve, reject) => http.close(e => e ? reject(e) : resolve())); await Promise.all([...resources].map(r => r.server.close())); } };
}
export async function main() {
    const memory = new Memory(process.env.RPG_DB ?? 'rpg.db');
    const runtime = process.env.OPENROUTER_API_KEY ? new MemoryRuntime(memory, { decision: new OpenRouterDecisionProvider({ model: process.env.OPENROUTER_DECISION_MODEL ?? 'inception/mercury-decide:free' }) }) : undefined;
    const core = new RpgCore(memory, runtime);
    let close: () => Promise<void>;
    if (process.argv.includes('--stdio')) {
        const user = core.user('local-development', process.env.RPG_LOCAL_USER ?? 'developer');
        const server = createRpgMcp(core, user);
        await server.connect(new StdioServerTransport());
        close = () => server.close();
    }
    else {
        const server = await serve(core, { port: Number(process.env.PORT ?? 3000), host: process.env.HOST ?? '127.0.0.1', devToken: process.env.RPG_DEV_TOKEN, issuer: process.env.OIDC_ISSUER, audience: process.env.OIDC_AUDIENCE, jwksUrl: process.env.OIDC_JWKS_URL, scope: process.env.OIDC_SCOPE });
        console.error('RPG MCP server listening', server.http.address());
        close = server.close;
    }
    const stop = async () => { await close(); memory.close(); process.exit(0); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
}
