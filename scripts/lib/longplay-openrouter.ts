import { spawn } from 'node:child_process';
export const LONGPLAY_GM='recursive/flint-v1.0:free';
export const LONGPLAY_DECISION='inception/mercury-decide:free';
export interface LiveCall {model:string;path:string;http_status:number;duration_ms:number;usage:any;finish_reason:string|null;error:any}
export class LongplayOpenRouter {
 private count=0;
 constructor(private key:string,private record:(call:LiveCall)=>void,private limit=36) {if(!key)throw new Error('OPENROUTER_API_KEY required');}
 async post(path:string,body:any){
  if(++this.count>this.limit)throw new Error('API call limit exceeded');
  const escape=(s:string)=>s.replaceAll('\\','\\\\').replaceAll('"','\\"');
  const config=`url = "https://openrouter.ai${path}"\nrequest = "POST"\nheader = "Authorization: Bearer ${escape(this.key)}"\nheader = "Content-Type: application/json"\ndata = "${escape(JSON.stringify(body))}"\n`;
  const started=Date.now();let output:string;
  try {output=await new Promise<string>((resolve,reject)=>{const p=spawn('curl',['--silent','--show-error','--max-time','90','--config','-','--write-out','\n%{http_code}'],{stdio:['pipe','pipe','pipe']});let out='';p.stdout.on('data',x=>out+=x);p.stderr.resume();p.once('error',()=>reject(new Error('curl start failed')));p.once('exit',code=>code===0?resolve(out):reject(new Error('network request failed')));p.stdin.end(config);});}
  catch {this.record({model:body.model,path,http_status:0,duration_ms:Date.now()-started,usage:null,finish_reason:null,error:'network timeout or failure'});throw new Error('network timeout or failure');}
  const split=output.lastIndexOf('\n');const status=Number(output.slice(split+1));let data:any;
  try{data=JSON.parse(output.slice(0,split));}catch{data={error:'non-JSON response'};}
  this.record({model:body.model,path,http_status:status,duration_ms:Date.now()-started,usage:data.usage??null,finish_reason:data.choices?.[0]?.finish_reason??null,error:status>=400?data.error:null});
  return {status,data};
 }
 fetch:typeof fetch=async(url,init)=>{const r=await this.post(new URL(String(url)).pathname,JSON.parse(String(init?.body)));return new Response(JSON.stringify(r.data),{status:r.status,headers:{'content-type':'application/json'}});};
 async json(role:string,input:any){
  const r=await this.post('/api/v1/chat/completions',{model:LONGPLAY_GM,messages:[{role:'system',content:role+' 다른 페르소나의 대화는 보지 않는다. 서버 결과만 사실로 취급한다. JSON 객체만 반환한다.'},{role:'user',content:JSON.stringify(input)}],max_tokens:8192,reasoning:{effort:'low',exclude:true},response_format:{type:'json_object'},temperature:.2});
  if(r.status!==200)throw new Error(`model HTTP ${r.status}`);
  const text=r.data.choices?.[0]?.message?.content;if(typeof text!=='string'||r.data.choices?.[0]?.finish_reason==='length')throw new Error('model output missing or truncated');
  try{return JSON.parse(text.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));}catch{throw new Error('invalid model JSON');}
 }
 async verifyFreeModel(){
  const text=await new Promise<string>((resolve,reject)=>{const p=spawn('curl',['--silent','--show-error','--fail','--max-time','30','https://openrouter.ai/api/v1/models'],{stdio:['ignore','pipe','pipe']});let out='';p.stdout.on('data',x=>out+=x);p.stderr.resume();p.once('error',()=>reject(new Error('model catalog unavailable')));p.once('exit',c=>c===0?resolve(out):reject(new Error('model catalog unavailable')));});
  const model=JSON.parse(text).data.find((x:any)=>x.id===LONGPLAY_GM);if(!model||Number(model.pricing.prompt)!==0||Number(model.pricing.completion)!==0)throw new Error('free model price unverified');return {id:model.id,pricing:model.pricing,checked_at:new Date().toISOString()};
 }
}
