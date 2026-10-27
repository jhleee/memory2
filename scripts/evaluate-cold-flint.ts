import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LongplayOpenRouter, LONGPLAY_GM } from './lib/longplay-openrouter.js';
const adapter=process.argv.includes('--json-tools');
const plan=JSON.parse(readFileSync('docs/cold-start-plan.json','utf8'));const descriptor=plan.sessions.find((s:any)=>s.tag==='flint');const key=process.env.OPENROUTER_API_KEY;if(!key)throw Error('OPENROUTER_API_KEY required');
const report:any={run_id:plan.run_id,model:LONGPLAY_GM,mode:adapter?'cold-json-tool-agent':'cold-native-tool-agent',started_at:new Date().toISOString(),api_calls:[],messages:[],tool_calls:[],errors:[],phases:[]};
function save(){writeFileSync(join(descriptor.directory,'live-agent.json'),JSON.stringify(report,null,2)+'\n');writeFileSync('docs/cold-start-flint-results.json',JSON.stringify(report,null,2)+'\n');}
const remote=new LongplayOpenRouter(key,call=>{report.api_calls.push(call);save();console.error(JSON.stringify({kind:'model_call',number:report.api_calls.length,status:call.http_status,ms:call.duration_ms}));},32);
const env={...process.env,RPG_DB:descriptor.database,RPG_EVAL_SUBJECT:descriptor.subject} as Record<string,string>;
const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx','scripts/rpg-longplay-worker.ts'],env,stderr:'pipe'});let stderr='';transport.stderr?.on('data',x=>{stderr+=x.toString();const lines=stderr.split('\n');stderr=lines.pop()??'';for(const line of lines)try{const event=JSON.parse(line);if(event.kind==='remote-call'){report.api_calls.push({...event,source:'server-decision'});save();}}catch{}});
const client=new Client({name:'first-contact-flint',version:'1'});
try{
 report.price_check=await remote.verifyFreeModel();await client.connect(transport);const catalogue=await client.listTools();
 const tools=catalogue.tools.map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.inputSchema}}));
 const messages:any[]=[{role:'system',content:'너는 이 RPG MCP 시스템을 처음 접하는 GM이다. 이전 구현·문서를 모른다. 제공된 도구 설명과 실제 응답으로 발견해서 사용한다. 실제 게임 상태는 도구로 기록하고, 미지원은 지어내지 않는다. 사용자에게 확인을 요청하지 말고 가능한 범위에서 진행한다. 완료하면 달성·누락·짧은 플레이 장면을 한국어로 답한다.'}];
 if(adapter){messages[0].content+=' 도구를 선택할 때 JSON {"tool_calls":[{"name":"도구명","arguments":{...}}],"done":false,"reason":"짧은 이유"}만 반환한다. 완료 시 {"tool_calls":[],"done":true,"summary":"달성·누락·장면"}을 반환한다. 도구 결과는 다음 user 메시지의 tool_results로 전달된다.';messages.push({role:'user',content:JSON.stringify({tool_catalogue:catalogue.tools})});}
 for(const phase of plan.phases.slice(0,3)){
  messages.push({role:'user',content:JSON.stringify({game_id:descriptor.game_id,actor_id:descriptor.actor_id,task:phase.brief})});
  const phaseRow:any={phase:phase.id,started_at:new Date().toISOString(),steps:0,completed:false};report.phases.push(phaseRow);
  for(let step=0;step<11;step++){
   const response=await remote.post('/api/v1/chat/completions',{model:LONGPLAY_GM,messages,...(adapter?{response_format:{type:'json_object'}}:{tools,tool_choice:'auto'}),max_tokens:8192,reasoning:{effort:'low',exclude:true},temperature:.2});
   if(response.status!==200)throw Error(`model HTTP ${response.status}`);
   const message=response.data.choices?.[0]?.message;if(!message)throw Error('model message missing');
   phaseRow.steps++;report.messages.push({phase:phase.id,message,finish_reason:response.data.choices?.[0]?.finish_reason});
   if(response.data.choices?.[0]?.finish_reason==='length')throw Error('model output budget exhausted before a complete tool selection');
   let parsed:any=null;if(adapter){try{parsed=JSON.parse((message.content??'').replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));}catch{throw Error('invalid JSON tool selection');}message.tool_calls=(parsed.tool_calls??[]).map((c:any,i:number)=>({id:`json-${phase.id}-${step}-${i}`,type:'function',function:{name:c.name,arguments:JSON.stringify(c.arguments??{})}}));}
   const assistant:any={role:'assistant',content:message.content??null};if(message.tool_calls&&!adapter)assistant.tool_calls=message.tool_calls;messages.push(assistant);
   if(!message.tool_calls?.length){phaseRow.completed=true;phaseRow.final=message.content;break;}
   for(const call of message.tool_calls){let args:any,result:any,isError=false;try{args=JSON.parse(call.function.arguments);const reply=await client.callTool({name:call.function.name,arguments:args});isError=!!reply.isError;result=reply.structuredContent;if(!result){try{result=JSON.parse((reply.content as any)[0]?.text);}catch{result={message:(reply.content as any)[0]?.text};}}}catch(e){isError=true;result={client_error:String(e)};}
    const record={at:new Date().toISOString(),phase:phase.id,request:{op:'call',name:call.function.name,arguments:args},response:{isError,result}};report.tool_calls.push(record);appendFileSync(join(descriptor.directory,'calls.jsonl'),JSON.stringify(record)+'\n');messages.push(adapter?{role:'user',content:JSON.stringify({tool_results:[{name:call.function.name,isError,result}]})}:{role:'tool',tool_call_id:call.id,content:JSON.stringify({isError,result})});save();
   }
   save();
  }phaseRow.finished_at=new Date().toISOString();save();
 }
 report.finished_at=new Date().toISOString();report.reported_cost_usd=report.api_calls.reduce((n:number,c:any)=>n+(Number(c.usage?.cost)||0),0);save();console.log(JSON.stringify({run_id:report.run_id,phases:report.phases,tool_calls:report.tool_calls.length,api_calls:report.api_calls.length,cost:report.reported_cost_usd},null,2));
}catch(e){report.errors.push({at:new Date().toISOString(),message:String(e)});report.stopped_at=new Date().toISOString();save();console.error(String(e));process.exitCode=1;}finally{await client.close();}
