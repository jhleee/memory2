import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Memory } from '../src/memory.js';
import { RpgCore } from '../src/rpg/core.js';
import { hash } from '../src/rpg/contracts.js';
import { seedSample } from '../src/rpg/sample.js';
import { foundation, chapter, selectedChoice, WORLD_BRANCHES, W, SCENARIO_NOTES, type WorldBranch } from './world-evolution-fixture.js';

const runId = `world-evolution-${new Date().toISOString().replaceAll(/[:.]/g,'-')}`;
const dir = resolve('evaluation/world-evolution', runId);
mkdirSync(dir,{recursive:true});
const report: any = { run_id:runId,started_at:new Date().toISOString(),mode:'deterministic-actual-mcp',
 design:{branches:WORLD_BRANCHES,sessions_per_branch:8,model_calls:0,notes:SCENARIO_NOTES,
  limits:['Authored effects, not autonomous world simulation','No LLM or human entertainment ratings','Gap probes are not counted as passing product capabilities','Performance is descriptive, without a production SLA']},
 branches:[],checks:[],gap_probes:[],errors:[] };
function save(){const data=JSON.stringify(report,null,2)+'\n';writeFileSync(join(dir,'result.json'),data);writeFileSync('docs/world-evolution-results.json',data);}
function check(branch:string,session:number,name:string,pass:boolean,detail?:unknown){report.checks.push({branch,session,name,passed:pass,detail});if(!pass)report.errors.push({branch,session,name,detail});}
const subject='world-evolution-owner';
const seedMemory=new Memory(join(dir,'seed.db'));const seedCore=new RpgCore(seedMemory);
const owner=seedCore.user('longplay-evaluation',subject);const f=await seedSample(seedCore,owner);
report.fixture=f;seedMemory.close();
const stateOf=(c:RpgCore)=>JSON.parse(c.game(owner,f.game_id).state_json);
const active=(s:any,subject:string,predicate:string)=>s.campaign?.facts.findLast((x:any)=>x.subject_id===subject&&x.predicate===predicate&&x.status==='confirmed'&&x.valid_to===null)?.value;
function inspect(db:string){const m=new Memory(db);const c=new RpgCore(m);try{return {state:stateOf(c),release:c.row('SELECT * FROM releases WHERE id=?',f.release_id),revision:c.game(owner,f.game_id).revision};}finally{m.close();}}
async function connect(db:string){
 const env={...process.env,RPG_DB:db,RPG_EVAL_SUBJECT:subject} as Record<string,string>;delete env.OPENROUTER_API_KEY;
 const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx','scripts/rpg-longplay-worker.ts'],env,stderr:'pipe'});
 transport.stderr?.on('data',()=>undefined);
 const client=new Client({name:'world-evolution-evaluation',version:'1.0'});await client.connect(transport);
 const call=async(name:string,args:any)=>{const r=await client.callTool({name,arguments:args});let data:any=r.structuredContent;if(!data){const raw=(r.content as any)[0]?.text??'';try{data=JSON.parse(raw);}catch{data={message:raw};}}return {error:!!r.isError,data};};
 return {client,call,pid:transport.pid};
}
function audit(db:string,branch:string){
 const m=new Memory(db);const c=new RpgCore(m);try{
 const s=stateOf(c), snapshots=c.rows('SELECT * FROM game_snapshots WHERE game_id=? ORDER BY seq',f.game_id);
 const events=c.rows('SELECT * FROM game_events WHERE game_id=? ORDER BY seq',f.game_id);let replay=JSON.parse(snapshots[0].state_json);let seq=0;
 for(const e of events){const patch=JSON.parse(e.patch_json);check(branch,9,`replay.${e.seq}`,e.seq===++seq&&hash(replay)===e.before_hash&&hash(patch[0].before)===e.before_hash&&hash(patch[0].after)===e.after_hash);replay=patch[0].after;}
 check(branch,9,'full_replay_matches',hash(replay)===hash(s));
 for(const snap of snapshots){const expected=snap.seq===0?JSON.parse(snapshots[0].state_json):JSON.parse(events[snap.seq-1].patch_json)[0].after;check(branch,9,`snapshot.${snap.seq}`,hash(expected)===snap.state_hash&&hash(JSON.parse(snap.state_json))===snap.state_hash);}
 check(branch,9,'verify',c.verify(owner,f.game_id).verified);
 const validSource=(id:string)=>!!c.row('SELECT id FROM game_events WHERE game_id=? AND id=?',f.game_id,id);
 const records=[...Object.values(s.campaign.entities),...s.campaign.facts,...s.campaign.relations,...Object.values(s.campaign.events),...Object.values(s.campaign.threads)] as any[];
 check(branch,9,'all_canon_has_event_source',records.every(r=>validSource(r.source_event_id)),{records:records.length});
 const links=c.rows("SELECT * FROM links WHERE space_id=? AND relation='causes'",`game:${f.game_id}`);
 check(branch,9,'causal_evidence_exists',links.every(l=>{const ids=JSON.parse(l.metadata).evidence_ids;return ids?.length>0&&ids.every((id:string)=>!!c.row('SELECT id FROM evidence WHERE id=?',id));}));
 // Every authored parent-event edge must point to the actual chosen parent's memory.
 const chosen=s.campaign.history as any[];
 for(const h of chosen){const parent=s.campaign.events[h.event_id].parent_event_id;if(!parent)continue;const p=[...chosen].reverse().find((x:any)=>x.event_id===parent);check(branch,9,`causal_parent.${h.event_id}`,!!p&&links.some(l=>l.from_id===`memory:${p.source_event_id}`&&l.to_id===`memory:${h.source_event_id}`));}
 const groups=new Map<string,any[]>();for(const fact of s.campaign.facts.filter((x:any)=>x.status==='confirmed')){const key=JSON.stringify([fact.subject_id,fact.predicate]);groups.set(key,[...(groups.get(key)??[]),fact]);}
 let intervals=0;for(const facts of groups.values()){facts.sort((a,b)=>a.valid_from-b.valid_from);for(let n=1;n<facts.length;n++){intervals++;check(branch,9,`temporal.${facts[n].subject_id}.${facts[n].predicate}.${n}`,facts[n-1].valid_to!==null&&facts[n-1].valid_to===facts[n].valid_from&&facts[n].valid_from>=facts[n-1].valid_from);}check(branch,9,`single_active.${facts[0].subject_id}.${facts[0].predicate}`,facts.filter(x=>x.valid_to===null).length===1);}
 const memories=c.rows('SELECT gm.event_id,m.source_id,e.metadata FROM game_event_memories gm JOIN memories m ON m.id=gm.memory_id JOIN evidence e ON e.id=m.source_id WHERE gm.game_id=?',f.game_id);
 check(branch,9,'event_memory_provenance',memories.length===events.length&&memories.every(r=>JSON.parse(r.metadata).event_id===r.event_id));
 return {events:events.length,snapshots:snapshots.length,records_with_sources:records.length,temporal_transitions:intervals,causal_edges:links.length,state_hash:hash(s),integrity:c.row('PRAGMA integrity_check')};
 }finally{m.close();}
}
try{
 for(const branch of WORLD_BRANCHES){
  const db=join(dir,`${branch}.db`);copyFileSync(join(dir,'seed.db'),db);
  const result:any={branch,game_id:f.game_id,release_id:f.release_id,sessions:[],authored_choices:0,lookup_latencies_ms:[]};report.branches.push(result);
  const originalRelease=inspect(db).release;let lastHash=hash(inspect(db).state);let lastPid:number|null=null;
  for(let session=1;session<=8;session++){
   const before=inspect(db);const conn=await connect(db);let revision=before.revision;let key=0;
   const row:any={session,pid:conn.pid,start_hash:hash(before.state),start_revision:revision};result.sessions.push(row);
   try{
    const required=async(name:string,args:any)=>{const r=await conn.call(name,args);if(r.error)throw Error(`${name}: ${JSON.stringify(r.data)}`);return r.data;};
    const context=await required('rpg_game_get_context',{game_id:f.game_id,max_chars:64000});
    check(branch,session,'restart_state_hash',context.state_hash===lastHash);
    check(branch,session,'same_release',context.release_id===f.release_id);
    check(branch,session,'new_server_process',lastPid===null||conn.pid!==lastPid);lastPid=conn.pid;
    const proposal=async(p:any)=>required('rpg_game_propose_expansion',{game_id:f.game_id,expected_revision:revision,idempotency_key:`${session}-p-${key++}`,proposal:p});
    const install=async(p:any)=>{const q=await proposal(p);if(!q.validation.valid)throw Error(`invalid fixture: ${q.validation.errors}`);const r=await required('rpg_game_commit_expansion',{game_id:f.game_id,expected_revision:revision,idempotency_key:`${session}-c-${key++}`,proposal_id:q.proposal_id,acknowledge_semantic_limits:true});revision=r.revision;return r;};
    const reject=async(name:string,p:any)=>{const prior=await required('rpg_game_get_context',{game_id:f.game_id,max_chars:64000});const q=await conn.call('rpg_game_propose_expansion',{game_id:f.game_id,expected_revision:revision,idempotency_key:`${session}-bad-${key++}`,proposal:p});const rejected=q.error||!q.data.validation.valid;check(branch,session,`reject.${name}`,rejected);if(!q.error){const commit=await conn.call('rpg_game_commit_expansion',{game_id:f.game_id,expected_revision:revision,idempotency_key:`${session}-bad-commit-${key++}`,proposal_id:q.data.proposal_id,acknowledge_semantic_limits:true});check(branch,session,`reject_commit.${name}`,commit.error);}const after=await required('rpg_game_get_context',{game_id:f.game_id,max_chars:64000});check(branch,session,`reject_atomic.${name}`,prior.state_hash===after.state_hash&&prior.revision===after.revision);};
    if(session===1){await install(foundation(f.location_a));}
    if(session>=2&&session<=6){
     const p=chapter(session,branch,before.state.world_tick);row.chapter=p.title;row.definition_hash=hash(p);
     if(session===6)p.facts=[]; // terminal status was established in the foundation.
     if(branch==='narration-only'){
      await required('rpg_game_turn_commit',{game_id:f.game_id,turn_seq:context.turn_seq,client_message_id:`narration-${session}`,narration:`${p.title}: ${JSON.stringify(p.events[0].choices)}`});
      const attempted=await conn.call('rpg_game_act',{game_id:f.game_id,expected_revision:revision,idempotency_key:`unapproved-${session}`,action:{actor_id:f.hero,type:'choose',params:{event_id:`world-step-${session}`,choice_id:'advance'}}});check(branch,session,'unapproved_world_change_rejected',attempted.error);
     }else{
      await install(p);
      const act={game_id:f.game_id,expected_revision:revision,idempotency_key:`choose-${session}`,action:{actor_id:f.hero,type:'choose',params:{event_id:`world-step-${session}`,choice_id:selectedChoice(session,branch)}}};
      const offered=await required('rpg_game_get_events',{game_id:f.game_id});
      const choices=offered.events.find((e:any)=>e.id===`world-step-${session}`)?.choices??[];
      check(branch,session,'expected_choice_available',choices.some((ch:any)=>ch.id===selectedChoice(session,branch)));
      if(session===3)check(branch,session,'same_crisis_both_choices',choices.some((ch:any)=>ch.id==='mediation')&&choices.some((ch:any)=>ch.id==='blockade'));
      if(session>=4){const opposite=branch==='mediation'?'blockade':'mediation';check(branch,session,'prior_choice_gates_followup',!choices.some((ch:any)=>ch.id===opposite));const wrong=await conn.call('rpg_game_act',{...act,idempotency_key:`wrong-branch-${session}`,action:{...act.action,params:{...act.action.params,choice_id:opposite}}});check(branch,session,'opposite_followup_rejected',wrong.error);}
      const chosen=await required('rpg_game_act',act);revision=chosen.revision;result.authored_choices++;row.chosen_event_id=chosen.event_id;
      const duplicate=await required('rpg_game_act',act);check(branch,session,'replay_same_event',duplicate.event_id===chosen.event_id&&duplicate.revision===chosen.revision);
      const repeat=await conn.call('rpg_game_act',{...act,expected_revision:revision,idempotency_key:`repeat-${session}`});check(branch,session,'repeat_world_transition_rejected',repeat.error);
     }
    }
    if(session===2&&branch!=='narration-only'){
     // Approve a cross-session dependent event before its parent is resolved.
     const future=chapter(4,branch,context.state.world_tick);
     // Its declared parent isn't installed yet: structural validation must reject it.
     await reject('missing_future_parent',future);
    }
    if(session===3&&branch!=='narration-only'){
     // Correctly referenced parent exists, but this future event's factual gate is deliberately unmet.
     const future=chapter(5,branch,context.state.world_tick);future.events[0].parent_event_id='world-step-3';future.events[0].conditions=[{type:'fact',subject_id:W.b,predicate:'food',value:'impossible_future'}];future.events[0].id='future-gated';future.events[0].thread_id='future-gated-thread';future.threads[0].id='future-gated-thread';future.events[0].choices.forEach(ch=>ch.effects=ch.effects.filter(e=>e.type!=='thread'));
     await install(future);const candidates=await required('rpg_game_get_events',{game_id:f.game_id});check(branch,session,'unmet_future_fact_hidden',!candidates.events.some((e:any)=>e.id==='future-gated'));
     const attempt=await conn.call('rpg_game_act',{game_id:f.game_id,expected_revision:revision,idempotency_key:'premature',action:{actor_id:f.hero,type:'choose',params:{event_id:'future-gated',choice_id:'advance'}}});check(branch,session,'unmet_future_fact_rejected',attempt.error);
    }
    if(session===7){
     await install(chapter(7,branch,before.state.world_tick));
     const title='invalid-world';const wrap=(fields:any)=>({title,rationale:'의도적으로 모순인 제안을 거부해야 한다.',...fields});
     await reject('contradictory_climate',wrap({facts:[{subject_id:W.basin,predicate:'climate',value:'frozen',status:'confirmed'}]}));
     await reject('forbidden_settlement',wrap({entities:[{id:'forbidden-city',kind:'city',name:'금지된 도시',description:'정착 금지 계곡에 도시를 생성한다.',parent_id:W.remote,connections:[f.location_a]}]}));
     await reject('disconnected_geography',wrap({entities:[{id:'island-a',kind:'city',name:'고립 도시 가',description:'기존 지리에 닿지 않는다.',connections:['island-b']},{id:'island-b',kind:'city',name:'고립 도시 나',description:'기존 지리에 닿지 않는다.',connections:['island-a']}]}));
     await reject('identity_alias',wrap({entities:[{id:'fake-ruin',kind:'dungeon',name:'다른 신전',aliases:['백 년 신전'],description:'기존 유적을 중복 생성',connections:[W.a]}]}));
     await reject('operational_fact',wrap({facts:[{subject_id:f.hero,predicate:'alive',value:false,status:'confirmed'}]}));
     await reject('unscoped_rumor',wrap({facts:[{subject_id:W.basin,predicate:'cause',value:'curse',status:'rumor'}]}));
     // Known capability gaps: probe, record, never silently turn acceptance into a pass.
     const probes=[
      {id:'semantic_magic_conflict',description:'설명에만 기존 부활 금지 설정과 모순되는 능력을 넣는다.',fields:{entities:[{id:'resurrection-faith',kind:'religion',name:'부활 교단',description:'누구나 대가 없이 죽은 사람을 실제로 부활시킬 수 있다.'}]}},
      {id:'backdated_new_group',description:'새 단체의 창설 시점을 과거로 단정한다. 발견/생성 입력 계약이 구별하지 못한다.',fields:{entities:[{id:'new-union',kind:'group',name:'새로 창설된 연합',description:'지금 새로 창설되었다.'}],facts:[{subject_id:'new-union',predicate:'formed_tick',value:-999,status:'confirmed'}]}},
      {id:'predicate_paraphrase',description:'같은 기후 개념을 다른 predicate로 써서 모순을 제안한다.',fields:{facts:[{subject_id:W.basin,predicate:'regional_weather',value:'abundant_rain',status:'confirmed'}]}},
      {id:'relation_lifecycle',description:'동맹/적대의 종료·시점 변경을 기존 관계 스키마로 표현하려 한다.',fields:{relations:[{from_id:W.guild,to_id:W.faith,kind:'ally_of',value:1,valid_to:10}]}}
     ];
     for(const probe of probes){const q=await conn.call('rpg_game_propose_expansion',{game_id:f.game_id,expected_revision:revision,idempotency_key:`gap-${probe.id}`,proposal:wrap(probe.fields)});const accepted=!q.error&&q.data.validation.valid;report.gap_probes.push({branch,...probe,fields:undefined,accepted_as_structurally_valid:accepted,status:probe.id==='relation_lifecycle'?'unsupported_schema':accepted?'owner_semantic_review_required':'detected',response:q.data});}
     // Beliefs remain distinct, but this public-only API does not enforce observer-specific knowledge.
     const knowledge=await required('rpg_game_entities',{game_id:f.game_id,query:'drought_cause'});
     check(branch,session,'beliefs_not_promoted_to_confirmed',knowledge.facts.length===2&&knowledge.facts.every((x:any)=>x.status==='belief'||x.status==='rumor'));
     report.gap_probes.push({branch,id:'observer_knowledge_boundary',status:'unsupported_public_only',description:'관점 표시는 있으나 관찰자별 지식·비밀·정보 전파 권한이 없다.',visible_perspectives:knowledge.facts.map((x:any)=>x.perspective_id)});
    }
    if(session===8){
     for(let batch=0;batch<7;batch++)await install({title:`세계 규모 확장 ${batch}`,rationale:'기존 유역에 붙은 지역을 추가해 조회 정확도와 비용을 측정한다.',entities:Array.from({length:20},(_,i)=>{const id=`district-${String(batch*20+i).padStart(3,'0')}`;return {id,kind:'location',name:`확장 지구 ${String(batch*20+i).padStart(3,'0')}`,aliases:[`찾기${String(batch*20+i).padStart(3,'0')}`],description:'기존 유역을 세분한 장소',parent_id:W.basin,connections:[W.a]};})});
     let hits=0;for(let i=0;i<140;i++){const start=performance.now();const q=await required('rpg_game_entities',{game_id:f.game_id,query:`찾기${String(i).padStart(3,'0')}`});result.lookup_latencies_ms.push(performance.now()-start);if(q.entities.some((x:any)=>x.id===`district-${String(i).padStart(3,'0')}`))hits++;}
     check(branch,session,'scaled_alias_retrieval',hits===140,{hits,total:140});const all=await required('rpg_game_entities',{game_id:f.game_id});check(branch,session,'broad_query_reports_truncation',all.truncated&&all.entities.length===50);row.scaled_lookup_hits=hits;
     // Overflow remains a rejection, without partial state changes.
     for(let batch=0;batch<2;batch++)await install({title:`한도 접근 ${batch}`,rationale:'누적 Entity 한도 거부를 확인한다.',entities:Array.from({length:20},(_,i)=>({id:`limit-${batch}-${i}`,kind:'group',name:`한도 모임 ${batch}-${i}`,description:'규모 경계 확인용 모임'}))});
     await reject('entity_budget', {title:'한도 초과',rationale:'누적 200개 한도를 넘긴다.',entities:Array.from({length:20},(_,i)=>({id:`overflow-${i}`,kind:'group',name:`초과 모임 ${i}`,description:'저장되면 안 되는 모임'}))});
    }
    const afterContext=await required('rpg_game_get_context',{game_id:f.game_id,max_chars:64000});row.end_hash=afterContext.state_hash;row.end_revision=afterContext.revision;lastHash=row.end_hash;
   }finally{await conn.client.close();}
   const after=inspect(db);check(branch,session,'context_hash_matches_db',hash(after.state)===lastHash);check(branch,session,'release_content_unchanged',hash(after.release)===hash(originalRelease));
   const s=after.state;
   check(branch,session,'unrelated_region_unchanged',active(s,W.remote,'climate')==='normal'&&active(s,W.remote,'settlements')==='forbidden');
   check(branch,session,'actors_unaffected',hash(s.characters)===hash(before.state.characters));
   check(branch,session,'beliefs_unchanged',hash(s.campaign.facts.filter((x:any)=>x.status!=='confirmed'))===hash(session===1?s.campaign.facts.filter((x:any)=>x.status!=='confirmed'):before.state.campaign.facts.filter((x:any)=>x.status!=='confirmed')));
   if(session>=2&&session<=6){
    const selected=chapter(session,branch,before.state.world_tick).events[0].choices.find(ch=>ch.id===selectedChoice(session,branch));
    const effects=branch==='narration-only'?[]:selected!.effects;
    const intended=effects.filter(e=>e.type==='fact');
    for(const effect of effects.filter(e=>e.type==='relation')){if(effect.type!=='relation')continue;const matches=(r:any)=>r.from_id===effect.from_id&&r.to_id===effect.to_id&&r.kind===effect.kind;const previous=before.state.campaign.relations.find(matches)?.value??0;const current=s.campaign.relations.find(matches);check(branch,session,`expected_relation.${effect.from_id}.${effect.to_id}.${effect.kind}`,current?.value===Math.max(-100,Math.min(100,previous+effect.delta))&&current.source_event_id===row.chosen_event_id);}
    for(const old of before.state.campaign.relations){if(effects.some(e=>e.type==='relation'&&e.from_id===old.from_id&&e.to_id===old.to_id&&e.kind===old.kind))continue;const current=s.campaign.relations.find((r:any)=>r.from_id===old.from_id&&r.to_id===old.to_id&&r.kind===old.kind);check(branch,session,`non_target_relation.${old.from_id}.${old.to_id}.${old.kind}`,hash(current)===hash(old));}
    for(const effect of intended){if(effect.type==='fact')check(branch,session,`expected_effect.${effect.subject_id}.${effect.predicate}`,active(s,effect.subject_id,effect.predicate)===effect.value);}
    if(branch==='narration-only')check(branch,session,'narration_does_not_mutate_world',hash(before.state)===hash(s));
    // Any confirmed fact not in the authored mutation footprint must retain its value.
    for(const old of (before.state.campaign?.facts??[]).filter((x:any)=>x.status==='confirmed'&&x.valid_to===null)){
     if(intended.some(e=>e.type==='fact'&&e.subject_id===old.subject_id&&e.predicate===old.predicate))continue;
     check(branch,session,`non_target_fact.${old.subject_id}.${old.predicate}`,active(s,old.subject_id,old.predicate)===old.value);
    }
   }
   row.world={climate:active(s,W.basin,'climate'),trade:active(s,W.guild,'trade'),food:active(s,W.b,'food'),unrest:active(s,W.b,'unrest'),settlement:active(s,W.basin,'settlement'),entities:Object.keys(s.campaign.entities).length};save();
  }
  const final=inspect(db).state;result.final=result.sessions.at(-1).world;
  check(branch,9,'expected_final_state',branch==='narration-only'?active(final,W.basin,'settlement')==='unresolved':active(final,W.basin,'settlement')===(branch==='mediation'?'peace':'war'));
  const discovered=final.campaign.facts.filter((x:any)=>x.subject_id===W.ruin);check(branch,9,'discovery_keeps_historical_age',discovered.find((x:any)=>x.predicate==='founded_tick')?.value===-100&&discovered.find((x:any)=>x.predicate==='discovered_tick')?.value>=0);
  result.audit=audit(db,branch);const sorted=[...result.lookup_latencies_ms].sort((a:number,b:number)=>a-b);result.lookup={queries:sorted.length,median_ms:sorted[Math.floor(sorted.length/2)],p95_ms:sorted[Math.ceil(sorted.length*.95)-1],max_ms:sorted.at(-1)};save();
 }
 const left=report.branches.find((b:any)=>b.branch==='mediation'),right=report.branches.find((b:any)=>b.branch==='blockade');
 for(let n=2;n<=6;n++)check('cross-branch',n,'identical_approved_definition',left.sessions[n-1].definition_hash===right.sessions[n-1].definition_hash);
 report.summary={sessions:report.branches.reduce((n:number,b:any)=>n+b.sessions.length,0),checks:report.checks.length,passed:report.checks.filter((x:any)=>x.passed).length,failed:report.errors.length,authored_choices:report.branches.reduce((n:number,b:any)=>n+b.authored_choices,0),gap_cases:report.gap_probes.length,model_calls:0,cost_usd:0};
 report.finished_at=new Date().toISOString();save();console.log(JSON.stringify({run_id:runId,...report.summary,branches:report.branches.map((b:any)=>({branch:b.branch,final:b.final,audit:b.audit,lookup:b.lookup}))},null,2));if(report.errors.length)process.exitCode=1;
}catch(e){report.errors.push({fatal:String(e)});save();throw e;}
