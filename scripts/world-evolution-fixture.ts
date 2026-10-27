/** Authored, deterministic world-model acceptance fixture. No autonomous simulation is implied. */
import { expansionSchema, type Expansion, type Effect, type Condition } from '../src/rpg/campaign-contracts.js';
export const WORLD_BRANCHES = ['narration-only', 'mediation', 'blockade'] as const;
export type WorldBranch = typeof WORLD_BRANCHES[number];
export const W = { basin: 'river-basin', a: 'grain-city', b: 'harbor-city', remote: 'remote-valley', guild: 'grain-guild', faith: 'river-faith', archive: 'archive', ruin: 'old-ruin', relief: 'relief-union' };
const fact = (subject_id: string, predicate: string, value: string | number | boolean | null) => ({ subject_id, predicate, value, status: 'confirmed' as const });
const set = (subject_id: string, predicate: string, expected: string | number, value: string | number): Effect => ({ type: 'fact', subject_id, predicate, expected, value });
const fc = (subject_id: string, predicate: string, value: string | number): Condition => ({ type: 'fact', subject_id, predicate, value });
const change = (from_id: string, to_id: string, kind: 'trust' | 'hostility' | 'influence', delta: number): Effect => ({ type: 'relation', from_id, to_id, kind, delta });
function pack(title: string, fields: Record<string, unknown>): Expansion { return expansionSchema.parse({ title, rationale: title, ...fields }); }
function event(n: number, title: string, conditions: Condition[], effects: Effect[], alternative: Effect[], parent?: string): Expansion {
 const id = `world-step-${n}`, thread = `world-thread-${n}`;
 return pack(title, { threads: [{ id: thread, title, goal: title, entity_ids: [W.a,W.b,W.guild,W.faith] }], events: [{ id, title, description: title, category: ['threat','dilemma','consequence','opportunity','discovery'][n % 5], thread_id: thread, ...(parent ? { parent_event_id: parent } : {}), conditions, choices: [
  { id: 'advance', label: '세계 변화 확정', description: title, effects: [...effects, { type: 'thread', thread_id: thread, status: 'completed' }] },
  { id: 'defer', label: '개입 유보', description: '이번 개입을 유보하고 유보 사실만 기록한다.', effects: [{ type:'flag', key:`deferred.${n}`,value:true },...alternative,{ type:'thread',thread_id:thread,status:'failed' }] }
 ] }] });
}
export function foundation(location: string): Expansion {
 return pack('하천 유역의 기존 지리·경제·신앙', { entities: [
  { id: W.basin,kind:'region',name:'하천 유역',description:'두 도시가 교역하는 유역',connections:[location] },
  { id: W.a,kind:'city',name:'곡창 도시',description:'곡물을 수출하는 상류 도시',parent_id:W.basin,connections:[location,W.b] },
  { id: W.b,kind:'city',name:'항구 도시',description:'상류의 곡물에 의존하는 항구',parent_id:W.basin,connections:[W.a] },
  { id: W.remote,kind:'region',name:'먼 계곡',description:'이번 유역 분쟁과 무관한 계곡',connections:[location] },
  { id: W.guild,kind:'faction',name:'곡물 상단',description:'도시 간 곡물 교역을 운영한다.' },
  { id: W.faith,kind:'religion',name:'하천 신앙',description:'가뭄에 서로 다른 해석을 가진 공동체' },
  { id: W.archive,kind:'group',name:'역사 기록원',description:'오래된 기록을 보존하는 모임' }
 ], facts: [fact(W.basin,'climate','normal'), fact(W.basin,'settlement','unresolved'), fact(W.guild,'trade','open'),fact(W.a,'harvest','adequate'),fact(W.b,'food','adequate'),fact(W.b,'unrest','calm'),fact(W.remote,'climate','normal'),fact(W.remote,'settlements','forbidden'),fact(W.guild,'founded_tick',-100),fact(W.basin,'magic','no_resurrection'),
  { subject_id:W.basin,predicate:'drought_cause',value:'divine_punishment',status:'belief',perspective_id:W.faith },
  { subject_id:W.basin,predicate:'drought_cause',value:'upstream_damage',status:'rumor',perspective_id:W.guild }
 ],relations:[{from_id:W.guild,to_id:W.faith,kind:'trust',value:0},{from_id:W.a,to_id:W.b,kind:'hostility',value:0}] });
}
export function selectedChoice(n: number, branch: WorldBranch) { return n >= 3 && n <= 6 ? branch : 'advance'; }
function fork(n: number, title: string, peaceful: Condition[], conflict: Condition[], good: Effect[], bad: Effect[]): Expansion {
 const p=event(n,title,[],good,bad,`world-step-${n-1}`), thread=p.threads[0].id;
 p.events[0].choices=[
  {id:'mediation',label:n===3?'구호 통로를 열고 중재한다':'중재 경로의 후속 결과',description:title,conditions:peaceful,effects:[...good,{type:'thread',thread_id:thread,status:'completed'}]},
  {id:'blockade',label:n===3?'곡물 교역을 봉쇄한다':'봉쇄 경로의 후속 결과',description:title,conditions:conflict,effects:[...bad,{type:'thread',thread_id:thread,status:'completed'}]}
 ];return p;
}
export function chapter(n: number, _branch: WorldBranch, tick: number): Expansion {
 if(n===2) return event(n,'가뭄→수확 감소→교역 감소→항구 식량 부족',[fc(W.basin,'climate','normal')],[set(W.basin,'climate','normal','drought'),set(W.a,'harvest','adequate','poor'),set(W.guild,'trade','open','reduced'),set(W.b,'food','adequate','shortage')],[]);
 if(n===3) {
  const p=fork(n,'같은 교역 위기에서 중재 또는 봉쇄를 선택한다',[],[],
   [set(W.guild,'trade','reduced','relief_corridor'),change(W.a,W.b,'hostility',2),set(W.b,'unrest','calm','concern')],
   [set(W.guild,'trade','reduced','blockaded'),change(W.a,W.b,'hostility',8),set(W.b,'unrest','calm','riot')]);
  p.events[0].conditions=[fc(W.guild,'trade','reduced'),fc(W.b,'food','shortage')];return p;
 }
 if(n===4) {
  const p=fork(n,'종교 구호 활동이 기존 교역로와 연결된다',[fc(W.b,'unrest','concern')],[fc(W.b,'unrest','riot')],
   [set(W.faith,'relief_status','planned','active'),change(W.guild,W.faith,'trust',4),change(W.faith,W.b,'influence',3)],
   [set(W.faith,'relief_status','planned','obstructed'),change(W.guild,W.faith,'trust',-4),change(W.faith,W.b,'influence',1)]);
  p.entities=expansionSchema.parse({title:'구호연합',rationale:'식량 부족에 대응해 구호 활동을 조직한다.',entities:[{id:W.relief,kind:'group',name:'유역 구호연합',description:'상단과 신앙 공동체의 구호 활동으로 새로 결성된 단체'}]}).entities;
  p.facts=[fact(W.faith,'relief_status','planned'),fact(W.relief,'formed_tick',tick)];
  p.relations=[{from_id:W.relief,to_id:W.faith,kind:'member_of',value:1}];return p;
 }
 if(n===5) return fork(n,'중재와 봉쇄가 서로 다른 결과를 남긴다',
  [fc(W.faith,'relief_status','active'),{type:'relation',from_id:W.a,to_id:W.b,kind:'hostility',minimum:2}],
  [fc(W.faith,'relief_status','obstructed'),{type:'relation',from_id:W.a,to_id:W.b,kind:'hostility',minimum:8}],
  [set(W.b,'food','shortage','recovering'),set(W.b,'unrest','concern','calm'),change(W.a,W.b,'hostility',-2)],
  [set(W.b,'food','shortage','critical'),set(W.b,'unrest','riot','siege'),change(W.a,W.b,'hostility',4)]);
 if(n===6) return fork(n,'과거 선택을 참조해 평화 또는 전쟁으로 진행한다',[fc(W.b,'food','recovering')],[fc(W.b,'food','critical')],
  [set(W.guild,'trade','relief_corridor','restored'),set(W.basin,'settlement','unresolved','peace')],
  [set(W.guild,'trade','blockaded','war_economy'),set(W.basin,'settlement','unresolved','war')]);
 if(n===7) return pack('기존 유적의 발견을 신설과 구별한다',{entities:[{id:W.ruin,kind:'dungeon',name:'침수된 옛 신전',aliases:['백 년 신전'],description:'예전부터 존재한 유적을 이번에 발견했다. 이번에 새로 건축한 것은 아니다.',parent_id:W.basin,connections:[W.a]}],facts:[fact(W.ruin,'founded_tick',-100),fact(W.ruin,'discovered_tick',tick)]});
 throw Error(`No chapter ${n}`);
}
export const SCENARIO_NOTES = {
 drought: '가뭄→수확 감소→교역 감소→항구 식량 부족',
 trade: '중재: 구호 통로 / 봉쇄: 교역 봉쇄',
 faith: '구호연합 결성과 기존 종교·상단의 협력 또는 갈등',
 resolution: '식량·불안·적대의 차이가 평화 또는 전쟁으로 연결됨',
 discovery: '옛 신전은 원래 존재했고 이번에 발견됨. 구호연합은 플레이 도중 결성됨.'
};
