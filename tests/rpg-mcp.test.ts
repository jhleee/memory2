import { it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Memory } from '../src/memory.js';
import { RpgCore } from '../src/rpg/core.js';
import { createRpgMcp } from '../src/rpg/mcp.js';
import { serve } from '../src/rpg/server.js';
import { seedSample } from '../src/rpg/sample.js';
it('T-MCP-01 exposes twenty-five tools and structured, safe errors', async () => { const m = new Memory(':memory:'); const c = new RpgCore(m); const u = c.user('test', 'owner'); const server = createRpgMcp(c, u); const client = new Client({ name: 'contract', version: '1' }); const [a, b] = InMemoryTransport.createLinkedPair(); try {
    await server.connect(a);
    await client.connect(b);
    const list = await client.listTools();
    expect(list.tools).toHaveLength(25);
    expect(list.tools.some(x => x.name === 'memory_record')).toBe(false);
    const response = await client.callTool({ name: 'rpg_world_create', arguments: { name: 'test', idempotency_key: 'create' } });
    expect(response.structuredContent).toMatchObject({ revision: 0 });
    const denied = await client.callTool({ name: 'rpg_game_get_context', arguments: { game_id: 'missing' } });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(JSON.stringify(denied)).not.toMatch(/SELECT|SQLITE/);
}
finally {
    await client.close();
    await server.close();
    m.close();
} });
it('T-MCP-02/03 two independent HTTP clients share durable game and enforce auth/origin', async () => { const m = new Memory(':memory:'); const core = new RpgCore(m); const u = core.user('local-development', 'developer'); const f = await seedSample(core, u); const s = await serve(core, { port: 0, devToken: 'test-only-token' }); const port = (s.http.address() as any).port; const url = new URL(`http://127.0.0.1:${port}/mcp`); const clients = [new Client({ name: 'host-a', version: '1' }), new Client({ name: 'host-b', version: '1' })]; try {
    expect((await fetch(url, { method: 'POST' })).status).toBe(401);
    expect((await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer test-only-token', Origin: 'https://evil.example' } })).status).toBe(403);
    for (const client of clients)
        await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer test-only-token' } } }));
    const act = await clients[0].callTool({ name: 'rpg_game_act', arguments: { game_id: f.game_id, expected_revision: 0, idempotency_key: 'http-act', action: { type: 'move', actor_id: f.hero, target_id: f.location_b } } });
    expect(act.isError).not.toBe(true);
    const resumed = await clients[1].callTool({ name: 'rpg_game_get_context', arguments: { game_id: f.game_id } });
    expect(resumed.structuredContent).toMatchObject({ revision: 1, state: { scene_id: f.location_b } });
    expect(core.verify(u, f.game_id).verified).toBe(true);
}
finally {
    await Promise.all(clients.map(c => c.close()));
    await s.close();
    m.close();
} });
it('T-SEC-01 validates JWT signature, issuer, audience, expiry and scope', async () => {
    const { generateKeyPair, exportJWK, SignJWT } = await import('jose');
    const { createServer } = await import('node:http');
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...await exportJWK(publicKey), kid: 'test' };
    const jwks = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [jwk] })));
    await new Promise<void>(r => jwks.listen(0, '127.0.0.1', r));
    const issuer = 'https://issuer.example', audience = 'https://rpg.example/mcp';
    const m = new Memory(':memory:');
    const core = new RpgCore(m);
    const server = await serve(core, { port: 0, issuer, audience, jwksUrl: `http://127.0.0.1:${(jwks.address() as any).port}/jwks` });
    const url = new URL(`http://127.0.0.1:${(server.http.address() as any).port}/mcp`);
    const token = (overrides: {
        issuer?: string;
        audience?: string;
        expiry?: number;
        scope?: string;
    } = {}) => new SignJWT({ scope: overrides.scope ?? 'rpg' }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setSubject('alice').setIssuer(overrides.issuer ?? issuer).setAudience(overrides.audience ?? audience).setIssuedAt().setExpirationTime(overrides.expiry ?? Math.floor(Date.now() / 1000) + 60).sign(privateKey);
    const client = new Client({ name: 'jwt-host', version: '1' });
    try {
        for (const t of ['invalid', await token({ issuer: 'https://evil.example' }), await token({ audience: 'wrong-resource' }), await token({ expiry: 1 }), await token({ scope: 'other' })])
            expect((await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
        await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${await token()}` } } }));
        expect((await client.listTools()).tools).toHaveLength(25);
        expect(core.row('SELECT count(*) n FROM users WHERE issuer=? AND subject=?', issuer, 'alice').n).toBe(1);
    }
    finally {
        await client.close();
        await server.close();
        await new Promise<void>(r => jwks.close(() => r()));
        m.close();
    }
});
it('T-SEC-02 supports a production bearer token on a public bind', async () => {
    const memory = new Memory(':memory:');
    const core = new RpgCore(memory);
    const server = await serve(core, { port: 0, host: '0.0.0.0', bearerToken: 'production-test-token', publicUrl: 'https://memory.example' });
    const url = new URL(`http://127.0.0.1:${(server.http.address() as any).port}/mcp`);
    const client = new Client({ name: 'bearer-host', version: '1' });
    try {
        expect((await fetch(url, { method: 'POST' })).status).toBe(401);
        expect((await fetch(new URL('/.well-known/oauth-protected-resource', url))).status).toBe(404);
        await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer production-test-token' } } }));
        expect((await client.listTools()).tools).toHaveLength(25);
        expect(core.row('SELECT count(*) n FROM users WHERE issuer=? AND subject=?', 'static-bearer', 'operator').n).toBe(1);
    }
    finally {
        await client.close();
        await server.close();
        memory.close();
    }
});
it('T-MCP-01 completes World authoring and Game creation only through tools',async()=>{
 const m=new Memory(':memory:');const core=new RpgCore(m);const u=core.user('test','maker');const fixture=await seedSample(core,u);const original=core.manifest(core.world(u,fixture.world_id));const server=createRpgMcp(core,u);const client=new Client({name:'authoring-host',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 const call=async(name:string,args:any)=>{const r=await client.callTool({name,arguments:args});expect(r.isError).not.toBe(true);return r.structuredContent as any;};
 try{const world=await call('rpg_world_create',{name:'wire world',idempotency_key:'wire-create'});const manifest=JSON.parse(JSON.stringify(original).replaceAll(fixture.world_id,world.world_id));await call('rpg_world_edit',{world_id:world.world_id,expected_revision:0,idempotency_key:'wire-edit',operations:[...manifest.schemas.map((s:any)=>({op:'upsert_schema',type_name:s.type_name,schema:s.schema})),...manifest.entities.map((e:any)=>({op:'upsert_entity',id:e.id,type_name:e.type_name,data:e.data})),{op:'set_start_config',config:manifest.start_config}]});const release=await call('rpg_world_publish',{world_id:world.world_id,version:'1.0.0',expected_revision:1,idempotency_key:'wire-publish'});const game=await call('rpg_game_start',{release_id:release.release_id,idempotency_key:'wire-start'});expect(await call('rpg_game_get_context',{game_id:game.game_id})).toMatchObject({revision:0,release_id:release.release_id});expect((await call('rpg_world_get',{world_id:world.world_id})).releases[0].id).toBe(release.release_id);expect((await call('rpg_world_list',{})).items.length).toBe(2);expect((await call('rpg_game_list',{})).items.length).toBe(2);expect((await call('rpg_game_timeline',{game_id:game.game_id})).events.items).toEqual([]);}finally{await client.close();await server.close();m.close();}
});

it('configures a clock through MCP with omitted costs and preserves defaults on replay', async () => {
    const memory = new Memory(':memory:');
    const core = new RpgCore(memory);
    const owner = core.user('contract-test', 'owner');
    const sample = await seedSample(core, owner);
    const server = createRpgMcp(core, owner);
    const client = new Client({ name: 'clock-contract', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
        await server.connect(a);
        await client.connect(b);
        const request = { name: 'rpg_game_time_configure', arguments: {
            game_id: sample.game_id, expected_revision: 0, idempotency_key: 'default-clock',
        } };
        expect((await client.callTool(request)).isError).not.toBe(true);
        expect((await client.callTool(request)).structuredContent).toMatchObject({ status: 'replayed' });
        const clock = await client.callTool({ name: 'rpg_game_time_get', arguments: { game_id: sample.game_id } });
        expect(clock.structuredContent).toMatchObject({ enabled: true, seconds: 0,
            action_seconds: { move: 60, attack: 6, use_item: 6, skill_check: 30, inspect: 0, choose: 0 } });
        expect(core.verify(owner, sample.game_id).verified).toBe(true);
    } finally {
        await client.close();
        await server.close();
        memory.close();
    }
});
