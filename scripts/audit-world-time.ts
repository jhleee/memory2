/** Fixed-oracle audit without importing the time sample or scenario generator. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Memory } from '../src/memory.js';
import { RpgCore } from '../src/rpg/core.js';
import { WorldTime } from '../src/rpg/time.js';
import { hash } from '../src/rpg/contracts.js';
const report=JSON.parse(readFileSync(process.argv[2]??'docs/world-time-results.json','utf8'));if(!report.finished_at||report.errors.length)throw Error('Completed successful MCP evaluation required');
const audit:any={run_id:report.run_id,at:new Date().toISOString(),checks:[],errors:[],arms:[]};
function check(name:string,passed:boolean,detail?:unknown){audit.checks.push({name,passed,detail});if(!passed)audit.errors.push({name,detail});}
const expected:Record<string,{turns:number;hostage:string}>={compact:{turns:4,hostage:'rescued_safe'},detailed:{turns:103,hostage:'rescued_safe'},boundary:{turns:103,hostage:'rescued_injured'},late:{turns:103,hostage:'lost'}};
for(const [name,exp]of Object.entries(expected)){const memory=new Memory(join('evaluation/world-time',report.run_id,`${name}.db`));try{const c=new RpgCore(memory),game=c.row('SELECT * FROM games WHERE id=?',report.fixture.game_id),state=JSON.parse(game.state_json),clock=new WorldTime(c.db),book=clock.load(game.id).state!;
 const events=c.rows('SELECT * FROM game_events WHERE game_id=? ORDER BY seq',game.id),snapshots=c.rows('SELECT * FROM game_snapshots WHERE game_id=? ORDER BY seq',game.id);let previous=JSON.parse(snapshots[0].state_json),seq=0;
 for(const event of events){const patch=JSON.parse(event.patch_json);check(`${name}.before.${event.seq}`,event.seq===++seq&&hash(previous)===event.before_hash&&hash(patch[0].before)===hash(previous));previous=patch[0].after;check(`${name}.after.${event.seq}`,hash(previous)===event.after_hash);}
 check(`${name}.full_replay`,hash(previous)===hash(state));for(const snap of snapshots){const v=snap.seq===0?JSON.parse(snap.state_json):JSON.parse(events[snap.seq-1].patch_json)[0].after;check(`${name}.snapshot.${snap.seq}`,hash(v)===snap.state_hash&&hash(JSON.parse(snap.state_json))===snap.state_hash);}
 check(`${name}.physical_time`,state.time.seconds===2500&&book.seconds===2500);check(`${name}.input_count`,game.turn_seq===exp.turns);check(`${name}.same_release`,game.release_id===report.fixture.release_id);
 check(`${name}.narrative_truth`,book.incidents.find(i=>i.id==='hostage-clock')!.truth_values[0].value===exp.hostage);check(`${name}.actual_weather`,book.incidents.find(i=>i.id==='weather-clock')!.truth_values[0].value==='clear');
 const known=state.campaign.facts.filter((f:any)=>f.valid_to===null&&f.predicate==='weather_report');check(`${name}.stale_observation`,known.length===1&&known[0].value==='storm'&&known[0].observed_at_seconds===1500);
 const observations=events.filter(e=>JSON.parse(e.action_json).type==='time_observation');check(`${name}.one_reveal`,observations.length===1);
 for(const event of events.filter(e=>e.seq<observations[0].seq)){check(`${name}.hidden_before_observation.${event.seq}`,![event.action_json,event.result_json,event.patch_json].some(text=>/PRIVATE_|hostage_condition|weather_report/.test(text)));}
 const failed=events.filter(e=>JSON.parse(e.result_json).outcome?.status==='attempt_failed');check(`${name}.failure_count`,failed.length===(name==='late'?1:0));
 check(`${name}.reward`,state.characters[report.fixture.hero].inventory.find((i:any)=>i.item_id===report.fixture.potion).quantity===(name==='late'?2:3));
 check(`${name}.time_history`,clock.verify(game.id).verified);check(`${name}.public_history`,c.verify(game.owner_user_id,game.id).verified);
 const publicSources=c.rows('SELECT gm.event_id,m.space_id,e.metadata FROM game_event_memories gm JOIN memories m ON gm.memory_id=m.id JOIN evidence e ON m.source_id=e.id WHERE gm.game_id=?',game.id);check(`${name}.public_sources`,publicSources.length===events.length&&publicSources.every(x=>x.space_id===`game:${game.id}`&&JSON.parse(x.metadata).event_id===x.event_id));
 check(`${name}.integrity`,Object.values(c.row('PRAGMA integrity_check'))[0]==='ok');check(`${name}.foreign_keys`,c.rows('PRAGMA foreign_key_check').length===0);
 audit.arms.push({name,player_actions:game.turn_seq,events:events.length,snapshots:snapshots.length,time_revision:clock.load(game.id).revision,seconds:state.time.seconds,hostage:exp.hostage});
}finally{memory.close();}}
audit.summary={checks:audit.checks.length,passed:audit.checks.filter((c:any)=>c.passed).length,failed:audit.errors.length,events_replayed:audit.arms.reduce((n:number,a:any)=>n+a.events,0),snapshots:audit.arms.reduce((n:number,a:any)=>n+a.snapshots,0)};
writeFileSync('docs/world-time-audit.json',JSON.stringify(audit,null,2)+'\n');console.log(JSON.stringify({run_id:audit.run_id,...audit.summary,errors:audit.errors},null,2));if(audit.errors.length)process.exitCode=1;
