/** Read-only pure-rules probes of the exact phase-1 states. No agent DB is changed. */
import { readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Memory } from '../src/memory.js';
import { RpgCore } from '../src/rpg/core.js';
import { execute } from '../src/rpg/rules.js';
import { effectiveConfig } from '../src/rpg/campaign.js';
const plan=JSON.parse(readFileSync('docs/cold-start-plan.json','utf8'));const out:any={run_id:plan.run_id,at:new Date().toISOString(),mode:'read-only-pure-rule-probe',probes:[]};
for(const tag of ['quest','exploration']){const s=plan.sessions.find((s:any)=>s.tag===tag),snapshot=JSON.parse(readFileSync(join(s.directory,'phase1-snapshot.json'),'utf8')),state=snapshot.state;const m=new Memory(s.database);try{const core=new RpgCore(m),manifest=JSON.parse(core.row('SELECT manifest_json FROM releases WHERE id=?',s.release_id).manifest_json),config=effectiveConfig(state,manifest.start_config);const position=state.characters[s.actor_id].position_id;const targets=Object.values(state.campaign.entities).filter((e:any)=>['dungeon','location'].includes(e.kind)&&e.id!==position&&e.name.includes('전실')) as any[];
 for(const target of targets){let allowed=false,message='';try{const result=execute(state,config,{type:'move',actor_id:s.actor_id,target_id:target.id});allowed=result.state.characters[s.actor_id].position_id===target.id;}catch(e){message=String(e);}out.probes.push({tag,from:position,to:target.id,target_name:target.name,flags_before:state.flags,move_before_gate_choice_allowed:allowed,error:message||null,scope:'execute() with pinned Release and exact phase1 GameState; not a persisted MCP action'});}
 }finally{m.close();}}
writeFileSync('docs/cold-start-probes.json',JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out,null,2));
