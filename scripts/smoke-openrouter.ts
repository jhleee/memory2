import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Memory } from '../src/memory.js';
import { createRuntimeFromEnv } from '../src/runtime.js';
import { runHttp } from '../src/http.js';
import type { RecallResult } from '../src/types.js';

const key=process.env.OPENROUTER_API_KEY??process.env.OPENAPIKEY;
if(!key)throw new Error('Set OPENROUTER_API_KEY for the explicit live adapter smoke test');
const directory=await mkdtemp(join(tmpdir(),'context-memory-adapter-live-'));
const dbPath=join(directory,'memory.db');
const transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/src/cli.js'),'mcp','--provider','openrouter','--db',dbPath],env:process.env as Record<string,string>,stderr:'pipe'});
const client=new Client({name:'context-memory-live-validation',version:'1.0.0'});
let memory:Memory|undefined;
let httpServer:Awaited<ReturnType<typeof runHttp>>|undefined;
const assert=(condition:unknown,message:string)=>{if(!condition)throw new Error(message);};
async function tool(name:string,args:Record<string,unknown>) {
  const result=await client.callTool({name,arguments:args});
  if(result.isError)throw new Error(`${name} returned an error`);
  const block=(result.content as {type:string;text?:string}[]).find(content=>content.type==='text');
  if(!block?.text)throw new Error('Missing MCP response');
  return JSON.parse(block.text);
}
try {
  await client.connect(transport);
  const names=(await client.listTools()).tools.map(tool=>tool.name);
  assert(names.includes('memory_index')&&names.includes('memory_suggest'),'Configured MCP tools missing');
  await tool('memory_record',{space_id:'smoke',entities:[{id:'lia',name:'리아',metadata:{clothing:'검은 망토'}}],evidence:{source_type:'live_synthetic',content:'합성 실증 문서'},memories:[{id:'transfer',kind:'event',content:'리아가 열쇠를 미나에게 건넸다.'},{id:'privacy',kind:'claim',content:'API 인증 값은 환경 변수로 전달하고 저장소에 넣지 않는다.'},{id:'mention',kind:'mention',content:'검은 망토를 입은 여자',resolution:'unresolved'}]});
  const indexing=await tool('memory_index',{space_id:'smoke'});assert(indexing.failed===0,'MCP index failed');
  const recalled=await tool('memory_recall',{space_id:'smoke',query:'물건을 다른 사람에게 준 사건',mode:'decision',limit:1}) as RecallResult;
  assert(recalled.retrieval?.used==='decision'&&!recalled.retrieval.warnings.length,'MCP did not use the live configured models');
  assert(recalled.items[0]?.id==='transfer','MCP relevance ranking failed');
  const suggestions=await tool('memory_suggest',{space_id:'smoke',memory_id:'mention',entity_ids:['lia']});
  assert(suggestions.suggestions[0]?.id==='lia','MCP decision suggestions failed');
  memory=new Memory(dbPath);
  assert((memory.db.prepare("SELECT resolution FROM memories WHERE id='mention'").get() as {resolution:string}).resolution==='unresolved','MCP auto-resolved a mention');
  httpServer=await runHttp(memory,0,createRuntimeFromEnv(memory,{provider:'openrouter'}));
  const denied=await fetch(httpServer.url+'/api/status');assert(denied.status===401,'HTTP accepted unauthenticated access');
  const html=await fetch(httpServer.url).then(response=>response.text());assert(html.includes('decision')&&html.includes('/api/index'),'Dashboard stage2 controls missing');
  const response=await fetch(httpServer.url+'/api/recall',{method:'POST',headers:{Authorization:`Bearer ${httpServer.token}`,'Content-Type':'application/json'},body:JSON.stringify({space_id:'smoke',query:'비밀 값을 깃에 노출하지 않는 방법',mode:'decision',limit:1})});
  assert(response.ok,'HTTP live recall failed');
  const httpRecall=await response.json() as RecallResult;
  assert(httpRecall.retrieval?.used==='decision'&&!httpRecall.retrieval.warnings.length,'HTTP did not use live models');
  assert(httpRecall.items[0]?.id==='privacy','HTTP relevance ranking failed');
  const status=await fetch(httpServer.url+'/api/status?space_id=smoke',{headers:{Authorization:`Bearer ${httpServer.token}`}}).then(response=>response.json());
  const report={date:new Date().toISOString(),mcp:{transport:'real child process stdio',tools:names,indexing,top1:recalled.items[0]?.id,retrieval:recalled.retrieval,suggestions},http:{authenticated:true,unauthenticated_status:denied.status,top1:httpRecall.items[0]?.id,retrieval:httpRecall.retrieval,status},dashboard:{controls_present:true,visual_browser_test:false},mention_unresolved:true};
  const serialized=JSON.stringify(report,null,2)+'\n';assert(!serialized.includes(key),'Credential would leak into adapter report');
  await writeFile(new URL('../evaluation/openrouter-adapter-result.json',import.meta.url),serialized);
  console.log(JSON.stringify({mcp:report.mcp.top1,http:report.http.top1,mention_unresolved:true,status:'passed'}));
}finally {
  if(httpServer)await new Promise<void>((resolve,reject)=>httpServer!.server.close(error=>error?reject(error):resolve()));
  await client.close();memory?.close();await rm(directory,{recursive:true,force:true});
}
