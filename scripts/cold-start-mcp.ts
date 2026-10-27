/** Black-box MCP client. It only forwards catalogue/calls and logs the observed protocol. */
import { readFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const path=resolve(process.argv[2]??'');const session=JSON.parse(readFileSync(path,'utf8'));const request=JSON.parse(readFileSync(0,'utf8'));
const env={...process.env,RPG_DB:session.database,RPG_EVAL_SUBJECT:session.subject} as Record<string,string>;delete env.OPENROUTER_API_KEY;
const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx','scripts/rpg-longplay-worker.ts'],env,stderr:'pipe'});transport.stderr?.on('data',()=>undefined);
const client=new Client({name:'cold-start-black-box-client',version:'1'});let response:any;
const started=Date.now();try{
 await client.connect(transport);
 if(request.op==='list'){const list=await client.listTools();response={tools:list.tools.filter(t=>!request.name||t.name===request.name).map(t=>request.names_only?{name:t.name,description:t.description}:t)};}
 else if(request.op==='call'){const r=await client.callTool({name:request.name,arguments:request.arguments??{}});let data:any=r.structuredContent;if(!data){try{data=JSON.parse((r.content as any)[0]?.text??'null');}catch{data={message:(r.content as any)[0]?.text};}}response={isError:!!r.isError,result:data};}
 else throw Error('Use op=list or op=call');
}catch(e){response={client_error:String(e)};}
finally{await client.close();}
appendFileSync(join(session.directory,'calls.jsonl'),JSON.stringify({at:new Date().toISOString(),phase:session.phase,elapsed_ms:Date.now()-started,request,response})+'\n');
process.stdout.write(JSON.stringify(response,null,2)+'\n');
