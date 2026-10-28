import { expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { Memory } from '../src/memory.js';
import { RpgCore } from '../src/rpg/core.js';
import { createRpgMcp } from '../src/rpg/mcp.js';
import { contracts } from '../src/rpg/contracts.js';
import { serve } from '../src/rpg/server.js';

it('advertises canonical OAuth metadata and scope without trusting the request Host', async () => {
 const memory=new Memory(':memory:');
 const server=await serve(new RpgCore(memory),{port:0,issuer:'https://idp.example/',audience:'https://rpg.example/mcp',jwksUrl:'https://idp.example/jwks'});
 const base=`http://127.0.0.1:${(server.http.address() as any).port}`;
 try {
  const denied=await fetch(`${base}/mcp`,{method:'POST',headers:{Host:'untrusted.example'},body:'{}'});
  expect(denied.status).toBe(401);
  expect(denied.headers.get('www-authenticate')).toBe('Bearer resource_metadata="https://rpg.example/.well-known/oauth-protected-resource/mcp", scope="rpg"');
  expect(denied.headers.get('cache-control')).toBe('no-store');
  for(const path of ['/.well-known/oauth-protected-resource/mcp','/.well-known/oauth-protected-resource']) {
   const response=await fetch(base+path);
   expect(response.status).toBe(200);
   expect(await response.json()).toEqual({resource:'https://rpg.example/mcp',authorization_servers:['https://idp.example/'],scopes_supported:['rpg'],bearer_methods_supported:['header']});
  }
  expect(memory.db.prepare('SELECT COUNT(*) n FROM users').get()).toMatchObject({n:0});
 } finally {await server.close();memory.close();}
});

it('does not advertise OAuth for a local development token', async () => {
 const memory=new Memory(':memory:');const server=await serve(new RpgCore(memory),{port:0,devToken:'local-test-only'});
 const base=`http://127.0.0.1:${(server.http.address() as any).port}`;
 try {
  expect((await fetch(base+'/mcp',{method:'POST',body:'{}'})).headers.get('www-authenticate')).toBe('Bearer');
  expect((await fetch(base+'/.well-known/oauth-protected-resource/mcp')).status).toBe(404);
 } finally {await server.close();memory.close();}
});

it('serves ChatGPT tunnel discovery when SEP-2243 mirror headers are omitted', async () => {
 const memory=new Memory(':memory:');const server=await serve(new RpgCore(memory),{port:0,devToken:'local-test-only'});
 const base=`http://127.0.0.1:${(server.http.address() as any).port}`;
 try {
  const response=await fetch(base+'/mcp',{method:'POST',headers:{Authorization:'Bearer local-test-only','Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'openai-mcp-discover',method:'server/discover',params:{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}}}})});
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({jsonrpc:'2.0',id:'openai-mcp-discover',result:{supportedVersions:['2026-07-28'],capabilities:{tools:{listChanged:true}},resultType:'complete',_meta:{'io.modelcontextprotocol/serverInfo':{name:'rpg-mcp-platform',version:'0.4.0'}}}});
 } finally {await server.close();memory.close();}
});

it('describes reads, state changes and OAuth scopes in the actual MCP tool catalogue', async () => {
 const memory=new Memory(':memory:');const core=new RpgCore(memory);
 const server=createRpgMcp(core,core.user('test','owner'),{oauthScope:'rpg'});
 const client=new Client({name:'chatgpt-contract',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
 try {
  await server.connect(a);await client.connect(b);
  const {tools}=await client.listTools();expect(tools).toHaveLength(25);
  for(const tool of tools) {
   expect(tool.title).toBeTruthy();
   expect(tool.inputSchema).toMatchObject({type:'object',additionalProperties:false});
   expect(tool.annotations).toMatchObject({idempotentHint:true});
   expect(typeof tool.annotations?.readOnlyHint).toBe('boolean');
   expect(tool._meta?.securitySchemes).toEqual([{type:'oauth2',scopes:['rpg']}]);
  }
  expect(tools.find(t=>t.name==='rpg_game_get_context')?.annotations).toMatchObject({readOnlyHint:true,destructiveHint:false,openWorldHint:false});
  expect(tools.find(t=>t.name==='rpg_game_act')?.annotations).toMatchObject({readOnlyHint:false,destructiveHint:true});
  expect(tools.find(t=>t.name==='rpg_game_gm_review')?.annotations?.readOnlyHint).toBe(false);
  expect(tools.find(t=>t.name==='rpg_game_recall')?.annotations?.openWorldHint).toBe(true);
 } finally {await client.close();await server.close();memory.close();}
});

it('can expose one simple read tool to isolate ChatGPT catalogue validation', async () => {
 const memory=new Memory(':memory:');const core=new RpgCore(memory);
 const server=createRpgMcp(core,core.user('test','owner'),{toolNames:new Set(['rpg_game_list'])});
 const client=new Client({name:'chatgpt-minimal-contract',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
 try {
  await server.connect(a);await client.connect(b);
  const {tools}=await client.listTools();
  expect(tools.map(tool=>tool.name)).toEqual(['rpg_game_list']);
  expect(tools[0]).toMatchObject({title:'캠페인 목록 조회',inputSchema:{type:'object',additionalProperties:false}});
 } finally {await client.close();await server.close();memory.close();}
});

it('can expose the ChatGPT-safe catalogue without deeply nested authoring schemas', async () => {
 const excluded=new Set(['rpg_game_time_schedule','rpg_game_gm_note_write','rpg_game_gm_review','rpg_game_propose_expansion','rpg_world_edit']);
 const names=new Set(Object.keys(contracts).filter(name=>!excluded.has(name)) as Array<keyof typeof contracts>);
 const memory=new Memory(':memory:');const core=new RpgCore(memory);
 const server=createRpgMcp(core,core.user('test','owner'),{toolNames:names});
 const client=new Client({name:'chatgpt-safe-contract',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
 try {
  await server.connect(a);await client.connect(b);
  const {tools}=await client.listTools();
  expect(tools).toHaveLength(20);
  expect(tools.every(tool=>!excluded.has(tool.name))).toBe(true);
  expect(tools.every(tool=>Boolean(tool.title))).toBe(true);
 } finally {await client.close();await server.close();memory.close();}
});

it('rejects scope/header injection and noncanonical OAuth resources before listening', async () => {
 const memory=new Memory(':memory:');const core=new RpgCore(memory);
 const options={port:0,issuer:'https://idp.example/',audience:'https://rpg.example/mcp',jwksUrl:'https://idp.example/jwks'};
 try {
  for(const scope of ['rpg other','rpg"','rpg\\','rpg\r\nX-Test: injected'])
   await expect(serve(core,{...options,scope})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
  for(const audience of ['http://rpg.example/mcp','https://rpg.example/other','https://user:password@rpg.example/mcp','https://rpg.example/mcp?token=example'])
   await expect(serve(core,{...options,audience})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
 } finally {memory.close();}
});
