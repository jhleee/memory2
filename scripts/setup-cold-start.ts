import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Memory } from '../src/memory.js';
import { RpgCore } from '../src/rpg/core.js';
import { seedSample } from '../src/rpg/sample.js';
const runId=`cold-start-${new Date().toISOString().replaceAll(/[:.]/g,'-')}`;const root=resolve('evaluation/cold-start',runId);mkdirSync(root,{recursive:true});
const sessions=[];
for(const tag of ['quest','diplomacy','exploration','flint']){const directory=join(root,tag);mkdirSync(directory);const database=join(directory,'game.db');const m=new Memory(database);try{const c=new RpgCore(m),subject=`cold-start-${tag}`,user=c.user('longplay-evaluation',subject),fixture=await seedSample(c,user);const descriptor={run_id:runId,tag,directory,database,subject,phase:1,game_id:fixture.game_id,actor_id:fixture.hero,release_id:fixture.release_id};writeFileSync(join(directory,'session.json'),JSON.stringify(descriptor,null,2)+'\n');writeFileSync(join(directory,'fixture.json'),JSON.stringify({...fixture,user},null,2)+'\n');sessions.push(descriptor);}finally{m.close();}}
const plan={run_id:runId,at:new Date().toISOString(),engine_version:'0.4.0',mode:'first-contact-agent-behavior',sessions,phases:[
 {id:1,brief:'출발 장소에서 마을의 물 부족을 해결하기 위한 의뢰가 생겼다. 오래된 수로를 찾아 조사하는 던전 탐험을 시작한다. 기존 세계를 이어가며 실제 플레이 가능한 상황을 만들고 던전 입구까지 진행한다. 아직 방문하지 않은 세계 전체를 미리 완성할 필요는 없다.'},
 {id:2,brief:'플레이어는 이 물길을 두 나라가 함께 쓴다는 소식을 듣는다. 한쪽 관리가 상대국이 물을 훔쳤다고 주장하지만 사실은 아직 확인되지 않았다. 앞의 던전 조사와 연결해 국경 갈등을 확장하고, 전쟁 외의 협상·조사 방법도 남겨둔다.'},
 {id:3,brief:'던전 안에서 다른 모험가 파티와 마주친다. 그들이 악당의 부하라는 소문이 있지만 아직 확실하지 않다. 그들 중 한 명은 협상하려 한다. 기존 국가 갈등·물 부족과 연결할 단서를 찾되, 다른 방법으로 문제를 풀려는 플레이어 선언도 처리한다.'},
 {id:4,brief:'새 에이전트가 같은 게임을 이어받는다. 새 국왕이나 새 던전을 다시 만들지 않고 기존 인물·갈등을 회수할 수 있는지 확인한다.'}
],criteria:{behavior:['tool_discovery','read_before_expansion','proposal_review_commit','revision_recovery','narration_vs_state','time_activation_and_quotes','memory_and_unresolved_notes','resumption'],world:['quest_dungeon_link','geographic_anchor','national_conflict_and_uncertainty','party_and_villain_roles','existing_entity_reuse','overexpansion','choice_effects','unsupported_free_action'],limits:['Fresh agents are instructed not to read implementation, but share a filesystem; this is not a security-enforced blind environment','Same base agent family may correlate failures','No human enjoyment claim']}};
writeFileSync('docs/cold-start-plan.json',JSON.stringify(plan,null,2)+'\n');console.log(JSON.stringify({run_id:runId,sessions:sessions.map(s=>({tag:s.tag,session:join(s.directory,'session.json'),game_id:s.game_id,actor_id:s.actor_id}))},null,2));
