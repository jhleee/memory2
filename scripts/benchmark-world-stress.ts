import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { Memory } from '../src/memory.js';
import { MemoryRuntime } from '../src/runtime.js';
import { OpenRouterEmbeddingProvider, OpenRouterDecisionProvider } from '../src/openrouter.js';
import type { EmbeddingProvider, RetrievalMode } from '../src/types.js';
import { buildWorldStressFixture } from './world-stress-fixture.js';
import { buildWorldContextProbe } from './world-context-probes.js';
import { seedGameplay, validateGoldenGraph, gameplayQueryInput, scoreGameplay } from './gameplay-benchmark-lib.js';
import type { GameplayFixture } from './gameplay-benchmark-lib.js';
import { freezeGameplayFixture, worldStressProvenance, collectWorldCorpusStats, summarizeGameplayScores, summarizeBudgetCeilings, causalPathDiagnostics } from './world-stress-lib.js';

const live=process.argv.includes('--live');
const key=process.env.OPENROUTER_API_KEY??process.env.OPENAPIKEY;
if(live&&!key)throw new Error('--live requires OPENROUTER_API_KEY');
const seed=20261005;
const sizes=[256,1024,4096] as const;
const budgets=[{limit:20,max_chars:12000},{limit:60,max_chars:36000},{limit:120,max_chars:72000}];
const cacheDir=join(tmpdir(),'context-memory-world-stress-v1');
await mkdir(join(cacheDir,'vectors'),{recursive:true});
const fixtures=sizes.map(size=>({size,fixture:buildWorldStressFixture({size,seed})}));
// Freeze all corpus variants and all gold before the first model call.
const frozen=fixtures.map(({size,fixture})=>({size,...worldStressProvenance(fixture,{seed,trialIndex:0})}));
const probes=([32000,96000] as const).flatMap(characters=>(['start','middle','end'] as const).map(position=>buildWorldContextProbe({characters,position,seed})));
const contextResults:Array<Record<string,unknown>>=[];
const contextManifest=probes.map(({id,metadata,questions,expected_answers,state})=>({id,metadata,questions,expected_answers,state_sha256:createHash('sha256').update(state).digest('hex')}));
const calls:Array<Record<string,unknown>>=[];
let lastRemoteStart=0;
const observedFetch:typeof fetch=async(input,init)=>{
  const wait=3500-(performance.now()-lastRemoteStart);if(wait>0)await delay(wait);
  lastRemoteStart=performance.now();const start=lastRemoteStart;
  const response=await fetch(input,init);
  let payload:Record<string,unknown>={};try{payload=await response.clone().json() as Record<string,unknown>;}catch{/* No raw response logging. */}
  const usage=payload.usage as {cost?:number;prompt_tokens?:number}|undefined;
  const error=payload.error as {code?:number;message?:string}|undefined;
  calls.push({endpoint:new URL(String(input)).pathname,status:response.status,ms:Math.round(performance.now()-start),model:payload.model??null,cost:usage?.cost??null,prompt_tokens:usage?.prompt_tokens??null,error_code:error?.code??null,policy_block:error?.message?.includes('ZDR violation')?'account_zdr':null});
  return response;
};
const remoteEmbedding=live?new OpenRouterEmbeddingProvider({fetch:observedFetch,timeoutMs:90_000}):undefined;
const decision=live?new OpenRouterDecisionProvider({fetch:observedFetch,timeoutMs:90_000}):undefined;
const cacheHits={texts:0,remote_texts:0};
const vectorCache=new Map<string,number[]>();
const embedding:EmbeddingProvider|undefined=remoteEmbedding?{
  model:remoteEmbedding.model,dimensions:remoteEmbedding.dimensions,
  async embed(texts){
    const keys=texts.map(text=>createHash('sha256').update(`${remoteEmbedding.model}\0${text}`).digest('hex'));
    const missing=new Map<string,string>();
    for(let i=0;i<keys.length;i++){
      const hash=keys[i]!;
      if(!vectorCache.has(hash))try{
        const saved=JSON.parse(await readFile(join(cacheDir,'vectors',`${hash}.json`),'utf8')) as number[];
        if(saved.length!==remoteEmbedding.dimensions||!saved.every(Number.isFinite))throw new Error('Invalid vector cache');
        vectorCache.set(hash,saved);
      }catch{missing.set(hash,texts[i]!);}
      if(vectorCache.has(hash))cacheHits.texts++;
    }
    const entries=[...missing];
    for(let start=0;start<entries.length;start+=128){
      const batch=entries.slice(start,start+128);const vectors=await remoteEmbedding.embed(batch.map(([,text])=>text));
      cacheHits.remote_texts+=batch.length;
      for(let i=0;i<batch.length;i++){const hash=batch[i]![0];vectorCache.set(hash,vectors[i]!);await writeFile(join(cacheDir,'vectors',`${hash}.json`),JSON.stringify(vectors[i]));}
    }
    return keys.map(hash=>vectorCache.get(hash)!);
  },
}:undefined;
const changes=(m:Memory)=>Number((m.db.prepare('SELECT total_changes() n').get() as {n:number}).n);
const assert=(value:unknown,message:string)=>{if(!value)throw new Error(message);};
const results:Array<Record<string,unknown>>=[];
const corpora:Array<Record<string,unknown>>=[];
const indexing:Array<Record<string,unknown>>=[];
const entityCases:Array<Record<string,unknown>>=[];
const opened:Memory[]=[];
const output=new URL(`../evaluation/world-stress-${live?'openrouter':'offline'}-result.json`,import.meta.url);
let status='running';
let failureStage:string|null=null;
let stage='seed';
const persist=async()=>{
  const retrievalComplete=results.length===(live?19:9)&&results.every(r=>r.provider_failures===0);
  const report={date:new Date().toISOString(),version:1,live,status,retrieval_complete:retrievalComplete,failure_stage:failureStage,seed,corpora,provenance:frozen,
    methodology:{sizes,budgets,replicates:1,distractors:'Deterministically generated, nested corpus variants; core story and questions fixed across scales.',gold_used_only_by_evaluator:true,
      query_vectors:'Real model vectors cached by model+content hash and reused across scales/budgets. Cached query vectors exclude remote query-embedding time. runtime_ms includes request pacing and local retrieval; network.ms measures HTTP time only.',
      decision_scope:'Only largest world, 20-result budget. Production runtime reranks at most 20 candidates; larger-budget comparisons use lexical/hybrid only.',
      entity_scope:'Default production candidate discovery: first 20 Entities ordered by id, using only name/metadata known at the query session. Fixture-specified oracle candidates are not passed to the model.',
      path_score:'Stored directed path-node evidence coverage, not a structured path answer or causal QA accuracy.',index_batch_size:128,request_min_interval_ms:3500,
      corpus_size:'Characters/bytes are measured, not estimated tokenizer tokens; summed Memory/Evidence/name text can repeat source facts.'},
    models:live?{embedding:embedding!.model,dimensions:embedding!.dimensions,decision:decision!.model}:null,indexing,cache:cacheHits,results,entity_cases:entityCases,long_context:{methodology:'Independent controlled needle-in-haystack typed MCQ, not memory retrieval. Same background/core across positions; neutral options, unknown control, no-context baseline. Full state size is characters, actual provider prompt tokens are telemetry.',manifest:contextManifest,results:contextResults},network:calls,
    reported_cost:calls.reduce((n,c)=>n+(typeof c.cost==='number'?c.cost:0),0),missing_cost_metadata:calls.filter(c=>c.cost===null).length,
    capabilities:{retrieval_expansion_hops:1,vector_candidate_pool:200,decision_candidate_pool:20,structured_path_api:false,automatic_entity_creation:false},invariants:{read_only_queries:true,scoped_active:true,gold_not_sent_to_retrieval:true}};
  const serialized=JSON.stringify(report,null,2)+'\n';assert(!key||!serialized.includes(key),'Credential in benchmark report');await writeFile(output,serialized);
};
try{
  // Largest first warms shared vectors. Each smaller world is independently seeded with its own scoped vector index.
  const worlds=[];
  for(const {size,fixture} of [...fixtures].reverse()){
    stage=`seed:${size}`;
    const hash=freezeGameplayFixture(fixture).fixture_sha256;
    const directory=join(cacheDir,`${size}-${hash}`);await mkdir(directory,{recursive:true});
    const path=join(directory,live?'live.db':'offline.db');
    const marker=join(directory,live?'live-seeded.json':'offline-seeded.json');
    let seeded=false;try{seeded=(JSON.parse(await readFile(marker,'utf8')) as {hash:string}).hash===hash;}catch{/* First run. */}
    if(!seeded)for(const suffix of ['','-wal','-shm'])await rm(path+suffix,{force:true});
    const memory=new Memory(path);opened.push(memory);
    if(!seeded){seedGameplay(memory,fixture);validateGoldenGraph(memory,fixture);await writeFile(marker,JSON.stringify({hash}));}else validateGoldenGraph(memory,fixture);
    corpora.push({size,...collectWorldCorpusStats(memory,fixture.space_id)});
    const runtime=new MemoryRuntime(memory,{embedding,decision});
    if(live){
      stage=`index:${size}`;const start=performance.now();runtime.worker!.retryFailed(fixture.space_id);
      const queued=runtime.worker!.enqueue({space_id:fixture.space_id});let processed=0,batch=0;
      while(true){const n=await runtime.worker!.runOnce(128,fixture.space_id);if(!n)break;processed+=n;batch++;
        const failed=(memory.db.prepare("SELECT COUNT(*) n FROM jobs j JOIN memories m ON m.id=j.memory_id WHERE j.state='failed' AND m.space_id=?").get(fixture.space_id) as {n:number}).n;
        assert(!failed,'Embedding indexing failed; cached progress retained for explicit retry');
        if(batch%4===0)console.log(`Indexing ${size}: ${processed} jobs processed`);
      }
      indexing.push({size,queued,processed,failed:0,ms:Math.round(performance.now()-start)});
    }
    worlds.push({size,fixture,memory,runtime});
    await persist();
  }
  if(embedding){stage='query_embeddings';await embedding.embed(fixtures[0]!.fixture.queries.map(q=>q.query));}
  for(const {size,fixture,memory,runtime} of worlds.sort((a,b)=>a.size-b.size)){
    for(const budget of budgets){
      for(const mode of (live?['lexical','hybrid']:['lexical']) as RetrievalMode[]){
        stage=`retrieval:${size}:${budget.limit}:${mode}`;console.log(stage);const cases=[];
        for(const query of fixture.queries){
          const before=changes(memory),start=performance.now();
          const result=await runtime.recall({...gameplayQueryInput(fixture,query,mode),...budget});
          assert(changes(memory)===before,'Query changed the database');const score=scoreGameplay(memory,query,result);assert(score.scoped_active,'Query escaped Space or lifecycle');
          const returned=result.items.map(i=>i.id);
          cases.push({...score,query:query.query,returned_ids:returned,runtime_ms:Math.round(performance.now()-start),retrieval:result.retrieval,
            paths:causalPathDiagnostics(memory,query,returned),returned_memories:result.items.length,returned_content_chars:result.items.reduce((n,i)=>n+i.content.length,0)});
        }
        results.push({size,...budget,mode,summary:summarizeGameplayScores(cases),ceiling:summarizeBudgetCeilings(fixture,budget.limit),provider_failures:cases.filter(c=>c.retrieval?.warnings.some(w=>w.includes('failed'))).length,cases});
        await persist();
      }
    }
  }
  if(live){
    const largest=worlds.find(w=>w.size===4096)!;const {fixture,memory,runtime}=largest;const budget=budgets[0]!;
    const cases=[];
    for(const query of fixture.queries){
      stage=`decision:${query.id}`;const before=changes(memory),start=performance.now();
      const result=await runtime.recall({...gameplayQueryInput(fixture,query,'decision'),...budget});
      assert(changes(memory)===before,'Decision query wrote to DB');const score=scoreGameplay(memory,query,result);assert(score.scoped_active,'Decision escaped scope');
      cases.push({...score,query:query.query,returned_ids:result.items.map(i=>i.id),runtime_ms:Math.round(performance.now()-start),retrieval:result.retrieval});
      if(cases.length%6===0)console.log(`Decision ${cases.length}/${fixture.queries.length}`);
    }
    const failures=cases.filter(c=>c.retrieval?.warnings.some(w=>w.includes('failed'))).length;
    if(failures)status='provider_incomplete';
    results.push({size:4096,...budget,mode:'decision',summary:summarizeGameplayScores(cases),provider_failures:failures,cases});await persist();
    // Direct large-context probes are isolated from Memory retrieval and its score.
    for(const probe of [null,...probes]){
      stage=probe?`long_context:${probe.metadata.characters}:${probe.metadata.position}`:'long_context:no_context';
      console.log(stage);let providerError=false;
      const questions=probe?.questions??probes[0]!.questions;
      const answers=await decision!.decide(probe?.state??'증거 기록이 제공되지 않았다. 어떤 사건이나 신원도 입증되지 않았으며 정보가 부족하면 미확인 선택지를 사용한다.',questions).catch(()=>{providerError=true;if(status!=='provider_incomplete')status='complete_with_context_rejections';return null;});
      const expected=probe?.expected_answers??Object.fromEntries(questions.map(q=>[q.key,'c3']));
      const scores=questions.map(q=>({key:q.key,expected:expected[q.key],choice:answers?.[q.key]?.type==='choice'?(answers[q.key] as {choice:string}).choice:null,correct:providerError?null:answers?.[q.key]?.type==='choice'&&(answers[q.key] as {choice:string}).choice===expected[q.key]}));
      contextResults.push({id:probe?.id??'no_context',metadata:probe?.metadata??null,evaluated:!providerError,provider_error:providerError,answers,scores});await persist();
    }
    // Default candidate discovery is exercised against the larger world, not preselected gold-containing pools.
    stage='entity_snapshots';const snapshot=new Memory(':memory:');opened.push(snapshot);
    for(const session of fixture.sessions){
      for(const record of session.records)snapshot.record(record);
      for(const test of (fixture.entity_decisions??[]).filter(c=>c.as_of_session===session.id)){
        stage=`entity:${test.id}`;
        const candidates=snapshot.db.prepare('SELECT id,name,metadata FROM entities WHERE space_id=? ORDER BY id LIMIT 20').all(fixture.space_id) as {id:string;name:string;metadata:string}[];
        const before=changes(snapshot);let providerError=false;
        const response=await decision!.choose(`명시적인 이름·확인된 별명·신원 설명·속성으로 후보를 비교하라. 동명이인은 구별되는 근거가 필요하다. 근거가 부족하거나 후보에 없는 인물이면 unknown. 묘사: ${test.mention}\n속성: ${JSON.stringify(test.attributes??{})}`,candidates.map(c=>({id:c.id,content:`${c.name}\n${c.metadata}`}))).catch(()=>{providerError=true;status='provider_incomplete';return null;});
        assert(changes(snapshot)===before,'Entity choice mutated the world');
        const candidatePresent=test.expected_entity_id===null?null:candidates.some(c=>c.id===test.expected_entity_id);
        entityCases.push({id:test.id,session:session.id,expected_entity_id:test.expected_entity_id,candidate_ids:candidates.map(c=>c.id),correct_candidate_in_pool:candidatePresent,
          evaluated:!providerError,provider_error:providerError,choice:response?.choice??null,identity_resolution_correct:providerError?null:response?.choice===test.expected_entity_id,
          honest_within_pool:providerError?null:response?.choice===(candidatePresent?test.expected_entity_id:null),response});await persist();
      }
    }
  }
  if(status==='running')status='complete';
  await persist();
  console.log(JSON.stringify({status,corpora,results:results.map(({cases,ceiling,...s})=>s),entity_evaluated:entityCases.length,network_calls:calls.length},null,2));
  if(status!=='complete')process.exitCode=1;
}catch(error){
  status='incomplete';failureStage=stage;await persist();console.error(JSON.stringify({status,failure_stage:stage,reason:error instanceof Error?error.message.replace(key??'__NO_KEY__','[REDACTED]'):'Unknown benchmark error',network:calls.slice(-3),cache_retained:true}));process.exitCode=1;
}finally{for(const m of opened)m.close();}
