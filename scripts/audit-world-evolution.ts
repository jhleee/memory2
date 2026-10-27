/** Independent fixed oracles: deliberately does not import the scenario's effect generator. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Memory } from '../src/memory.js';
import { RpgCore } from '../src/rpg/core.js';
import { hash } from '../src/rpg/contracts.js';
const result=JSON.parse(readFileSync(process.argv[2]??'docs/world-evolution-results.json','utf8'));
if(!result.finished_at||result.errors.length)throw Error('A completed, successful evaluation is required');
const audit:any={run_id:result.run_id,at:new Date().toISOString(),mode:'fixed-oracle-sqlite-audit',checks:[],errors:[],branches:[]};
function check(branch:string,name:string,passed:boolean,detail?:unknown){audit.checks.push({branch,name,passed,detail});if(!passed)audit.errors.push({branch,name,detail});}
const expected:any={
 'narration-only':{climate:'normal',trade:'open',food:'adequate',unrest:'calm',settlement:'unresolved',trust:0,hostility:0,influence:undefined,events:11,choices:0,entities:188},
 mediation:{climate:'drought',trade:'restored',food:'recovering',unrest:'calm',settlement:'peace',trust:4,hostility:0,influence:3,events:22,choices:5,entities:189},
 blockade:{climate:'drought',trade:'war_economy',food:'critical',unrest:'siege',settlement:'war',trust:-4,hostility:12,influence:1,events:22,choices:5,entities:189}
};
const eventDefinitions:any={};
for(const branch of Object.keys(expected)){
 const memory=new Memory(join('evaluation/world-evolution',result.run_id,`${branch}.db`));const core=new RpgCore(memory);
 try{
  const game=core.row('SELECT * FROM games WHERE id=?',result.fixture.game_id),s=JSON.parse(game.state_json),c=s.campaign,exp=expected[branch];
  const active=(subject:string,predicate:string)=>[...c.facts].reverse().find((f:any)=>f.subject_id===subject&&f.predicate===predicate&&f.status==='confirmed'&&f.valid_to===null)?.value;
  const relation=(from:string,to:string,kind:string)=>c.relations.find((r:any)=>r.from_id===from&&r.to_id===to&&r.kind===kind)?.value;
  const found={climate:active('river-basin','climate'),trade:active('grain-guild','trade'),food:active('harbor-city','food'),unrest:active('harbor-city','unrest'),settlement:active('river-basin','settlement'),trust:relation('grain-guild','river-faith','trust'),hostility:relation('grain-city','harbor-city','hostility'),influence:relation('river-faith','harbor-city','influence')};
  for(const [key,value] of Object.entries(found))check(branch,`fixed_final.${key}`,value===exp[key],{expected:exp[key]??null,actual:value??null});
  check(branch,'same_release',game.release_id===result.fixture.release_id);
  check(branch,'exact_world_tick',s.world_tick===exp.choices,{expected:exp.choices,actual:s.world_tick});
  check(branch,'remote_region_isolated',active('remote-valley','climate')==='normal'&&active('remote-valley','settlements')==='forbidden');
  check(branch,'beliefs_preserved',c.facts.filter((f:any)=>f.predicate==='drought_cause').length===2&&c.facts.filter((f:any)=>f.predicate==='drought_cause').every((f:any)=>f.status!=='confirmed'&&f.perspective_id));
  check(branch,'entity_count',Object.keys(c.entities).length===exp.entities);
  check(branch,'choices_count',c.history.length===exp.choices);
  check(branch,'observed_not_newly_built',active('old-ruin','founded_tick')===-100&&active('old-ruin','discovered_tick')===(branch==='narration-only'?0:5));
  if(branch!=='narration-only'){
   check(branch,'formation_time',active('relief-union','formed_tick')===2);
   check(branch,'actual_choice_history',c.history.every((h:any)=>h.choice_id===(h.event_id==='world-step-2'?'advance':branch)));
   check(branch,'completed_goals',Object.values(c.threads).filter((t:any)=>t.status==='completed').length===5);
   // The intentionally ineligible future event is open; claiming all goals complete would be wrong.
   check(branch,'future_goal_still_open',c.threads['future-gated-thread'].status==='open');
  }
  const events=core.rows('SELECT * FROM game_events WHERE game_id=? ORDER BY seq',game.id);
  check(branch,'events_count',events.length===exp.events);
  let restored=JSON.parse(core.row('SELECT state_json FROM game_snapshots WHERE game_id=? AND seq=0',game.id).state_json);
  for(const event of events){const patch=JSON.parse(event.patch_json);check(branch,`replay_before.${event.seq}`,hash(restored)===event.before_hash&&hash(patch[0].before)===hash(restored));restored=patch[0].after;check(branch,`replay_after.${event.seq}`,hash(restored)===event.after_hash);}
  check(branch,'full_replay',hash(restored)===hash(s));
  const snapshots=core.rows('SELECT * FROM game_snapshots WHERE game_id=?',game.id);
  for(const snap of snapshots){const replay=snap.seq===0?JSON.parse(snap.state_json):JSON.parse(events[snap.seq-1].patch_json)[0].after;check(branch,`snapshot.${snap.seq}`,snap.state_hash===hash(replay)&&snap.state_hash===hash(JSON.parse(snap.state_json)));}
  const sources=core.rows('SELECT e.id,e.metadata,m.space_id,gm.event_id FROM game_event_memories gm JOIN memories m ON m.id=gm.memory_id JOIN evidence e ON e.id=m.source_id WHERE gm.game_id=?',game.id);
  check(branch,'one_memory_per_event',sources.length===events.length);
  check(branch,'evidence_game_boundary',sources.every(x=>x.space_id===`game:${game.id}`&&JSON.parse(x.metadata).event_id===x.event_id));
  const groups=new Map<string,any[]>();for(const f of c.facts.filter((f:any)=>f.status==='confirmed')){const key=JSON.stringify([f.subject_id,f.predicate]);groups.set(key,[...(groups.get(key)??[]),f]);}
  for(const [key,fs] of groups){check(branch,`active_unique.${key}`,fs.filter(f=>f.valid_to===null).length===1);for(let i=1;i<fs.length;i++)check(branch,`interval.${key}.${i}`,fs[i-1].valid_to===fs[i].valid_from);}
  check(branch,'integrity',Object.values(core.row('PRAGMA integrity_check'))[0]==='ok');
  check(branch,'no_foreign_key_failures',core.rows('PRAGMA foreign_key_check').length===0);
  eventDefinitions[branch]=Object.fromEntries(Object.entries(c.events).filter(([id])=>id.startsWith('world-step-')).map(([id,raw])=>{const v:any={...(raw as any)};delete v.source_event_id;return [id,v];}));
  const sessions=result.branches.find((b:any)=>b.branch===branch).sessions;
  check(branch,'eight_sessions',sessions.length===8);
  for(let i=1;i<sessions.length;i++)check(branch,`restart_boundary.${i}`,sessions[i].start_hash===sessions[i-1].end_hash&&sessions[i].pid!==sessions[i-1].pid);
  audit.branches.push({branch,world_tick:s.world_tick,replayed_events:events.length,snapshots:snapshots.length,final:found});
 }finally{memory.close();}
}
check('cross-branch','same_approved_event_definitions',hash(eventDefinitions.mediation)===hash(eventDefinitions.blockade));
audit.summary={checks:audit.checks.length,passed:audit.checks.filter((x:any)=>x.passed).length,failed:audit.errors.length,events_replayed:audit.branches.reduce((n:number,b:any)=>n+b.replayed_events,0),snapshots:audit.branches.reduce((n:number,b:any)=>n+b.snapshots,0)};
writeFileSync('docs/world-evolution-audit.json',JSON.stringify(audit,null,2)+'\n');
console.log(JSON.stringify({run_id:audit.run_id,...audit.summary,errors:audit.errors},null,2));if(audit.errors.length)process.exitCode=1;
