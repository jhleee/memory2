import { readFile,writeFile,mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Memory } from '../src/memory.js';
import { MemoryRuntime } from '../src/runtime.js';
import { OpenRouterEmbeddingProvider,OpenRouterDecisionProvider } from '../src/openrouter.js';
import type { MemoryInput,EmbeddingProvider,RetrievalMode,RuntimeQueryInput } from '../src/types.js';

interface Case {id:string;query:string;relevant:string[];entity_id?:string;from?:string;to?:string}
const fixture=JSON.parse(await readFile(new URL('../evaluation/korean-memory.json',import.meta.url),'utf8')) as {description:string;memories:MemoryInput[];queries:Case[]};
const key=process.env.OPENROUTER_API_KEY??process.env.OPENAPIKEY;
if(!key)throw new Error('Set OPENROUTER_API_KEY before running this explicit live evaluation');
const directory=await mkdtemp(join(tmpdir(),'context-memory-live-'));
const memory=new Memory(join(directory,'memory.db'));
const calls:Record<string,unknown>[]=[];
const observedFetch:typeof fetch=async(input,init)=> {
  const started=performance.now();
  const response=await fetch(input,init);
  let payload:Record<string,unknown>={};
  try {payload=await response.clone().json() as Record<string,unknown>;}catch{/* Only response metadata is recorded. */}
  const usage=payload.usage as Record<string,unknown>|undefined;
  calls.push({endpoint:new URL(String(input)).pathname,status:response.status,ms:Math.round(performance.now()-started),model:payload.model??null,cost:usage?.cost??null,prompt_tokens:usage?.prompt_tokens??null,total_tokens:usage?.total_tokens??null});
  return response;
};
const embedding=new OpenRouterEmbeddingProvider({fetch:observedFetch,timeoutMs:45_000});
const decision=new OpenRouterDecisionProvider({fetch:observedFetch,timeoutMs:45_000});
let runtime=new MemoryRuntime(memory,{embedding,decision});
const assert=(condition:unknown,message:string)=>{if(!condition)throw new Error(message);};
const checkNoWrites=()=>Number((memory.db.prepare('SELECT total_changes() n').get() as {n:number}).n);
try {
  const entities=[{id:'lia',name:'리아',metadata:{clothing:'검은 망토'}},{id:'mina',name:'미나',metadata:{clothing:'흰 코트'}},{id:'junho',name:'준호'},{id:'sujin',name:'수진'}];
  fixture.memories.forEach((item,i)=>runtime.record({space_id:'eval-main',entities:i===0?entities:undefined,evidence:{source_type:'synthetic_fixture',content:item.content},memories:[item]}));
  runtime.record({space_id:'eval-other',evidence:{source_type:'synthetic_fixture',content:'다른 Space의 비공개 정보'},memories:[{id:'other_transfer',kind:'event',content:'리아가 열쇠를 미나에게 건넸다.'}]});
  const indexStart=performance.now();const indexing=await runtime.index({space_id:'eval-main'});
  assert(indexing.failed===0,'Indexing failed; inspect safe job status');
  assert(memory.db.prepare("SELECT COUNT(*) n FROM embeddings e JOIN memories m ON m.id=e.memory_id WHERE m.space_id='eval-other'").get()&&(memory.db.prepare("SELECT COUNT(*) n FROM embeddings e JOIN memories m ON m.id=e.memory_id WHERE m.space_id='eval-other'").get() as {n:number}).n===0,'Indexing escaped requested space');
  const indexMs=Math.round(performance.now()-indexStart);
  // Batch real query vectors once; re-use identical vectors for fair mode comparisons and free-tier rate limits.
  const queryStart=performance.now();const vectors=await embedding.embed(fixture.queries.map(test=>test.query));
  const queryBatchMs=Math.round(performance.now()-queryStart);
  const cache=new Map(fixture.queries.map((test,i)=>[test.query,vectors[i]]));
  const cachedEmbedding:EmbeddingProvider={model:embedding.model,dimensions:embedding.dimensions,async embed(texts){return Promise.all(texts.map(async text=>cache.get(text)??(await embedding.embed([text]))[0]));}};
  runtime=new MemoryRuntime(memory,{embedding:cachedEmbedding,decision});
  const results:Record<string,unknown>[]=[];
  for(const mode of ['lexical','hybrid','decision'] as RetrievalMode[]) {
    console.log(`Evaluating ${mode}: ${fixture.queries.length} fixed Korean queries`);
    let top1=0,recall5=0,mrr=0,failures=0;const latencies:number[]=[];const cases:Record<string,unknown>[]=[];
    for(const test of fixture.queries) {
      const before=checkNoWrites();const started=performance.now();
      const input:RuntimeQueryInput={space_id:'eval-main',query:test.query,entity_id:test.entity_id,from:test.from,to:test.to,limit:5,mode};
      const result=await runtime.recall(input);const ms=performance.now()-started;latencies.push(ms);
      assert(checkNoWrites()===before,'Recall changed the database');
      assert(result.items.every(item=>item.space_id==='eval-main'&&item.lifecycle==='active'),'Recall leaked a space or lifecycle');
      const ids=result.items.map(item=>item.id);const rank=ids.findIndex(id=>test.relevant.includes(id));
      if(rank===0)top1++;
      recall5+=ids.filter(id=>test.relevant.includes(id)).length/test.relevant.length;
      if(rank>=0)mrr+=1/(rank+1);
      if(result.retrieval?.warnings.some(w=>w.includes('failed')))failures++;
      cases.push({id:test.id,query:test.query,expected:test.relevant,returned:ids,rank:rank<0?null:rank+1,ms:Math.round(ms),retrieval:result.retrieval});
    }
    latencies.sort((a,b)=>a-b);
    const n=fixture.queries.length;
    results.push({mode,top1:top1/n,recall_at_5:recall5/n,mrr_at_5:mrr/n,provider_failures:failures,p95_runtime_ms:Math.round(latencies[Math.ceil(n*.95)-1]),cases});
  }
  // Measure one hybrid request including a fresh remote query embedding, separate from cached comparisons.
  const coldRuntime=new MemoryRuntime(memory,{embedding,decision});
  const coldStart=performance.now();const coldResult=await coldRuntime.recall({space_id:'eval-main',query:fixture.queries[0].query,mode:'hybrid',limit:5});
  const coldHybridMs=Math.round(performance.now()-coldStart);
  assert(!coldResult.retrieval?.warnings.some(w=>w.includes('failed')),'Cold embedding request failed');
  const typed=await decision.decide('고객이 결제가 사흘째 실패했고 오늘 반드시 해결해야 한다고 말했다.',[
    {key:'urgent',type:'noul',instructions:'고객이 명시적인 시간 긴급성을 표현했는가?',criteria:{true:'명시적 시간 긴급성',false:'시간 긴급성 없음'}},
    {key:'department',type:'choice',instructions:'어떤 팀의 사안인가?',options:['billing','technical','unknown'],criteria:{billing:'결제와 청구 문제',technical:'결제 이외 기술 문제',unknown:'근거 부족'}},
    {key:'frustration',type:'score',instructions:'표현된 불만의 정도를 평가한다.',criteria:['차분함','불만','강한 분노']},
  ]);
  const choice=await decision.choose('묘사: 검은 망토를 입은 여자. 후보의 명시적 복장만 비교하라.',[{id:'lia',content:'리아는 검은 망토를 입었다.'},{id:'mina',content:'미나는 흰 코트를 입었다.'}]);
  const unknownChoice=await decision.choose('묘사: 누군가가 들어왔다. 이름이나 외모는 알려지지 않았다. 근거 없이 추측하지 말라.',[{id:'lia',content:'리아는 검은 망토를 입었다.'},{id:'mina',content:'미나는 흰 코트를 입었다.'}]);
  runtime.record({space_id:'eval-main',evidence:{source_type:'synthetic_fixture',content:'검은 망토를 입은 여자'},memories:[{id:'mention',kind:'mention',content:'검은 망토를 입은 여자',resolution:'unresolved'}]});
  const beforeSuggestion=checkNoWrites();const suggestion=await runtime.suggestMention({space_id:'eval-main',memory_id:'mention',entity_ids:['lia','mina']});
  assert(checkNoWrites()===beforeSuggestion,'Decision suggestion wrote to database');
  assert((memory.db.prepare("SELECT resolution FROM memories WHERE id='mention'").get() as {resolution:string}).resolution==='unresolved','Decision automatically resolved a mention');
  const corrected=runtime.correct({space_id:'eval-main',memory_id:'m_transfer',evidence:{source_type:'synthetic_correction',content:'열쇠를 받은 사람은 미나가 아니라 준호였다.'},replacement:{kind:'event',content:'리아가 열쇠를 준호에게 건넸다.',entity_ids:['lia','junho']}});
  assert((memory.db.prepare("SELECT COUNT(*) n FROM embeddings WHERE memory_id='m_transfer'").get() as {n:number}).n===0,'Correction left the old vector indexed');
  runtime.forget({space_id:'eval-main',memory_id:'m_budget'});
  assert((memory.db.prepare("SELECT COUNT(*) n FROM embeddings WHERE memory_id='m_budget'").get() as {n:number}).n===0,'Deletion left a vector indexed');
  // Explicit re-index includes the replacement; original stale/deleted records stay excluded.
  const reindexing=await runtime.index({space_id:'eval-main'});assert(reindexing.failed===0,'Replacement indexing failed');
  const after=await runtime.recall({space_id:'eval-main',query:fixture.queries[0].query,mode:'decision',limit:20});
  assert(!after.items.some(item=>item.id==='m_transfer'||item.id==='m_budget'),'Corrected/deleted memory resurfaced');
  assert(after.items.some(item=>item.id===corrected.memory_ids[0]),'Replacement missing from recall');
  const report={date:new Date().toISOString(),fixture:fixture.description,models:{embedding:embedding.model,dimensions:embedding.dimensions,decision:decision.model},methodology:{memories:fixture.memories.length,queries:fixture.queries.length,query_vectors:'Real OpenRouter query embeddings batched once and reused across modes. Comparison runtimes exclude remote query embedding latency; Decision calls remain live.',decision_pool:20,scope:'Small synthetic development validation; no claim of general model quality.'},indexing:{...indexing,ms:indexMs},query_batch_ms:queryBatchMs,cold_hybrid_ms:coldHybridMs,results,decisions:{typed,choice,unknown_choice:unknownChoice,mention_suggestion:suggestion},invariants:{space_isolation:true,read_only_recall:true,suggestions_do_not_resolve:true,correction_excludes_old:true,deletion_removes_vector:true,replacement_indexed:true},network:calls,reported_cost:calls.reduce((sum,row)=>sum+(typeof row.cost==='number'?row.cost:0),0),missing_cost_metadata:calls.filter(row=>row.cost===null).length};
  const serialized=JSON.stringify(report,null,2)+'\n';
  assert(!serialized.includes(key),'Credential would leak into evaluation report');
  await writeFile(new URL('../evaluation/openrouter-live-result.json',import.meta.url),serialized);
  console.log(JSON.stringify({results:results.map(({cases,...summary})=>summary),invariants:report.invariants,cold_hybrid_ms:coldHybridMs,reported_cost:report.reported_cost,network_calls:calls.length},null,2));
}finally{memory.close();await rm(directory,{recursive:true,force:true});}
