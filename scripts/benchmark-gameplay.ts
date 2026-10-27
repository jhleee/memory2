import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { Memory } from '../src/memory.js';
import { MemoryRuntime } from '../src/runtime.js';
import { OpenRouterEmbeddingProvider, OpenRouterDecisionProvider } from '../src/openrouter.js';
import type { EmbeddingProvider, RetrievalMode, RecallResult } from '../src/types.js';
import { loadGameplayFixture, seedGameplay, validateGoldenGraph, scoreGameplay, gameplayQueryInput } from './gameplay-benchmark-lib.js';
import type { GameplayScore } from './gameplay-benchmark-lib.js';

const live=process.argv.includes('--live');
const key=process.env.OPENROUTER_API_KEY??process.env.OPENAPIKEY;
if(live&&!key)throw new Error('--live requires OPENROUTER_API_KEY');
const fixture=await loadGameplayFixture(fileURLToPath(new URL('../evaluation/gameplay-graph.fixture.json',import.meta.url)));
const directory=await mkdtemp(join(tmpdir(),'gameplay-benchmark-'));
const memory=new Memory(join(directory,'memory.db'));
const calls:Record<string,unknown>[]=[];
const observedFetch:typeof fetch=async(input,init)=>{
  const start=performance.now(); const response=await fetch(input,init);
  let payload:Record<string,unknown>={};
  try{payload=await response.clone().json() as Record<string,unknown>;}catch{/* Metadata only. */}
  const usage=payload.usage as Record<string,unknown>|undefined;
  const error=payload.error as {code?:unknown;message?:unknown}|undefined;
  calls.push({endpoint:new URL(String(input)).pathname,status:response.status,ms:Math.round(performance.now()-start),model:payload.model??null,cost:usage?.cost??null,error_code:typeof error?.code==='number'?error.code:null,policy_block:typeof error?.message==='string'&&error.message.includes('ZDR violation')?'account_zdr':null});
  return response;
};
const assert=(condition:unknown,message:string)=>{if(!condition)throw new Error(message);};
const changes=(m:Memory)=>Number((m.db.prepare('SELECT total_changes() n').get() as {n:number}).n);
const mean=(values:number[])=>values.reduce((a,b)=>a+b,0)/Math.max(values.length,1);
const summarize=(cases:GameplayScore[])=>({
  cases:cases.length,
  support_recall:mean(cases.filter(c=>fixture.queries.find(q=>q.id===c.query_id)!.expected_support_ids.length>0).map(c=>c.support_recall)),
  support_recall_at_5:mean(cases.filter(c=>c.support_recall_at_5!==null).map(c=>c.support_recall_at_5!)),
  mrr:mean(cases.filter(c=>c.reciprocal_rank!==null).map(c=>c.reciprocal_rank!)),
  top1_support:mean(cases.filter(c=>c.top1_support!==null).map(c=>Number(c.top1_support))),
  minimal_gold_precision:mean(cases.filter(c=>c.support_precision!==null).map(c=>c.support_precision!)),
  support_complete:cases.filter(c=>c.support_complete).length,
  path_node_coverage_complete:cases.reduce((n,c)=>n+c.directed_paths_complete,0),
  path_count:cases.reduce((n,c)=>n+c.directed_paths_total,0),
  scoped_active:cases.every(c=>c.scoped_active),
  exclusion_violations:cases.reduce((n,c)=>n+c.excluded_returned_ids.length,0),
});
try{
  const seeded=seedGameplay(memory,fixture); validateGoldenGraph(memory,fixture);
  let runtime=new MemoryRuntime(memory);
  let indexing:unknown=null, queryBatchMs:number|null=null;
  let embeddingAvailable=false;
  let embedding:OpenRouterEmbeddingProvider|undefined,decision:OpenRouterDecisionProvider|undefined;
  if(live){
    embedding=new OpenRouterEmbeddingProvider({fetch:observedFetch,timeoutMs:45_000});
    decision=new OpenRouterDecisionProvider({fetch:observedFetch,timeoutMs:45_000});
    runtime=new MemoryRuntime(memory,{embedding,decision});
    console.log('Indexing fixed gameplay fixture using the requested embedding model');
    indexing=await runtime.index({space_id:fixture.space_id});
    if((indexing as {failed:number}).failed===0){
    embeddingAvailable=true;
    const start=performance.now();const vectors=await embedding.embed(fixture.queries.map(q=>q.query));
    queryBatchMs=Math.round(performance.now()-start);
    const cache=new Map(fixture.queries.map((q,i)=>[q.query,vectors[i]]));
    const cached:EmbeddingProvider={model:embedding.model,dimensions:embedding.dimensions,async embed(texts){return texts.map(text=>{const v=cache.get(text);if(!v)throw new Error('Uncached benchmark query');return v;});}};
    runtime=new MemoryRuntime(memory,{embedding:cached,decision});
    }else{console.log('Embedding unavailable; hybrid comparison omitted, Decision uses lexical candidates');runtime=new MemoryRuntime(memory,{decision});}
  }
  const results=[];
  for(const mode of (live?(embeddingAvailable?['lexical','hybrid','decision']:['lexical','decision']):['lexical']) as RetrievalMode[]){
    console.log(`Running ${mode}: ${fixture.queries.length} gameplay queries`);
    const cases:Array<GameplayScore & {query:string;expected_support_ids:string[];expected_paths:unknown[];returned_ids:string[];runtime_ms:number;retrieval:RecallResult['retrieval']}> = [];
    for(const query of fixture.queries){
      if(mode==='decision'&&decision)await delay(3500);
      const before=changes(memory),start=performance.now();
      const result=await runtime.recall({...gameplayQueryInput(fixture,query,mode),max_chars:12000});
      assert(changes(memory)===before,'Recall mutated the database');
      const score=scoreGameplay(memory,query,result);
      assert(score.scoped_active,'Recall leaked another Space or inactive Memory');
      cases.push({...score,query:query.query,expected_support_ids:query.expected_support_ids,expected_paths:query.expected_paths??[],returned_ids:result.items.map(i=>i.id),runtime_ms:Math.round(performance.now()-start),retrieval:result.retrieval});
    }
    const latencies=cases.map(c=>c.runtime_ms).sort((a,b)=>a-b);
    results.push({mode,provider_comparison_valid:mode==='lexical'||cases.every(c=>c.retrieval?.used===mode),...summarize(cases),p95_runtime_ms:latencies[Math.ceil(latencies.length*.95)-1],provider_failures:cases.filter(c=>c.retrieval?.warnings.some(w=>w.includes('failed'))).length,categories:Object.fromEntries([...new Set(cases.map(c=>c.category))].map(category=>[category,summarize(cases.filter(c=>c.category===category))])),cases});
  }
  const entityCases=[];
  for(const test of fixture.entity_decisions??[]){
    // Seed only records known at this session, using the same public ingestion API.
    // Final correction/resolve operations are deliberately not applied to earlier snapshots.
    const snapshot=new Memory(':memory:');
    try{
      for(const session of fixture.sessions){for(const record of session.records)snapshot.record(record);if(session.id===test.as_of_session)break;}
      const candidates=test.candidate_entity_ids.map(id=>{
        const row=snapshot.db.prepare('SELECT name,metadata FROM entities WHERE id=? AND space_id=?').get(id,fixture.space_id) as {name:string;metadata:string}|undefined;
        assert(row,`Candidate ${id} was not created by ${test.as_of_session}`);
        // This probes the current production candidate metadata contract, not an oracle fact lookup.
        return {id,content:`${row!.name}\n${row!.metadata}`};
      });
      const before=changes(snapshot);
      if(decision)await delay(3500);
      let providerError=false;
      const response=decision?await decision.choose(`명시적인 이름·확인된 별명·신원 설명·속성으로 후보를 비교하라. 동일 이름의 인물이 여럿이면 역할 등 구별되는 근거가 필요하다. 근거가 부족하거나 후보에 없는 인물이면 unknown. 묘사: ${test.mention}\n속성: ${JSON.stringify(test.attributes??{})}`,candidates).catch(()=>{providerError=true;return null;}):null;
      assert(changes(snapshot)===before,'Entity proposal changed database');
      entityCases.push({id:test.id,as_of_session:test.as_of_session,mention:test.mention,expected_entity_id:test.expected_entity_id,candidate_ids:candidates.map(c=>c.id),evaluated:live&&!providerError,provider_error:providerError,choice:response?.choice??null,correct:live&&!providerError?response?.choice===test.expected_entity_id:null,response});
    }finally{snapshot.close();}
  }
  const evaluated=entityCases.filter(c=>c.evaluated),unknown=evaluated.filter(c=>c.expected_entity_id===null);
  const report={date:new Date().toISOString(),title:fixture.title,fixture:'gameplay-graph.fixture.json',live,status:live&&(!embeddingAvailable||results.some(r=>!r.provider_comparison_valid)||entityCases.some(c=>c.provider_error))?'provider_incomplete':'complete',embedding_available:embeddingAvailable,seeded,
    capabilities:{retrieval_link_expansion_hops:1,directed_path_api:false,automatic_causal_inference:false,entity_creation:'explicit structured host input; unresolved Mention does not create or merge Entity'},
    methodology:{gold_frozen_before_retrieval:true,gold_sent_to_provider:false,context_limit:20,max_chars:12000,decision_pacing_ms:3500,query_vectors:'Live query embeddings batched once and reused; per-query runtime excludes that network latency. Decision requests remain live.',metrics:'Support recall and stored directed path-node coverage measure evidence retrieval, not causal answer correctness. Minimal-gold precision may count useful extra context as non-gold.',entity_decisions:'Session snapshots, candidate name/metadata only (production candidate contract). Model chooses existing candidate or unknown; never creates/resolves automatically.',negative_cases:'Exclusion violations are diagnostic; read-only, Space and lifecycle checks are asserted.'},
    models:live?{embedding:embedding!.model,dimensions:embedding!.dimensions,decision:decision!.model}:null,indexing,query_batch_ms:queryBatchMs,results,
    entity_decisions:{evaluated:evaluated.length,correct:evaluated.filter(c=>c.correct).length,unknown_cases:unknown.length,false_merges:unknown.length?unknown.filter(c=>c.choice!==null).length:null,cases:entityCases},
    invariants:{read_only_recall:true,scoped_active:true,entity_proposals_read_only:true},network:calls,reported_cost:calls.reduce((n,c)=>n+(typeof c.cost==='number'?c.cost:0),0),missing_cost_metadata:calls.filter(c=>c.cost===null).length};
  const serialized=JSON.stringify(report,null,2)+'\n';assert(!key||!serialized.includes(key),'Credential leak in report');
  await writeFile(new URL(`../evaluation/gameplay-${live?'openrouter':'offline'}-result.json`,import.meta.url),serialized);
  if(report.status==='provider_incomplete')process.exitCode=1;
  console.log(JSON.stringify({results:results.map(({cases,categories,...summary})=>summary),entity_decisions:{evaluated:evaluated.length,correct:evaluated.filter(c=>c.correct).length,false_merges:report.entity_decisions.false_merges},network_calls:calls.length},null,2));
}catch(error){
  if(!live)throw error;
  const failure={date:new Date().toISOString(),live,status:'incomplete',reason:'Provider/indexing benchmark failed; no hybrid/decision quality score is claimed.',network:calls,jobs:memory.db.prepare('SELECT state,COUNT(*) count FROM jobs GROUP BY state').all()};
  await writeFile(new URL('../evaluation/gameplay-live-failure.json',import.meta.url),JSON.stringify(failure,null,2)+'\n');
  console.error(JSON.stringify(failure,null,2));process.exitCode=1;
}finally{memory.close();await rm(directory,{recursive:true,force:true});}
