import type Database from 'better-sqlite3';
import { canonical, hash, id, now, requireThat, type State, type Action } from './contracts.js';
import { canonicalEntities, emptyCampaign } from './campaign.js';
import { timeCosts, type Timeline, type TimeIncident, type Truth, type Activity } from './time-contracts.js';
const factKey=(f:{subject_id:string;predicate:string})=>canonical([f.subject_id,f.predicate]);
const forbidden=new Set(['hp','max_hp','inventory','position_id','alive','life_state','conditions','source_event_id']);
const actions:Record<Activity['kind'],string>={conversation:'speak',search:'inspect',travel:'move',work:'activity',rest:'activity',wait:'activity',decision:'choose'};
export class WorldTime {
 constructor(readonly db:Database.Database){}
 private row(sql:string,...args:any[]):any{return this.db.prepare(sql).get(...args);}
 private owner(g:any,user:string){requireThat(g.owner_user_id===user,'FORBIDDEN','시간 계획과 실제 비공개 사실은 Game 소유자 전용입니다.');}
 load(gid:string):{revision:number;state:Timeline|null}{const r=this.row('SELECT * FROM game_timebooks WHERE game_id=?',gid);return r?{revision:r.revision,state:JSON.parse(r.state_json)}:{revision:0,state:null};}
 private manifest(g:any){return JSON.parse(this.row('SELECT manifest_json FROM releases WHERE id=?',g.release_id).manifest_json);}
 private save(g:any,user:string,before:Timeline|null,after:Timeline,op:string,source:string|null=null,eventId?:string){
  const stored=this.load(g.id),seq=stored.revision+1,eid=eventId??id('timeevt');
  this.db.prepare('INSERT INTO game_time_events VALUES(?,?,?,?,?,?,?,?,?,?)').run(eid,g.id,seq,user,op,hash(before),hash(after),canonical(after),source,now());
  this.db.prepare('INSERT INTO game_timebooks VALUES(?,?,?) ON CONFLICT(game_id) DO UPDATE SET revision=excluded.revision,state_json=excluded.state_json').run(g.id,seq,canonical(after));
  return {time_revision:seq,time_event_id:eid};
 }
 get(g:any,user:string){const book=this.load(g.id);if(!book.state)return {enabled:false,time_revision:0};
  const publicView={enabled:true,seconds:book.state.seconds,unit:'seconds',action_seconds:book.state.costs,speech:'activity_quote_required',activity_accounting:'full duration once at first action completion; scoped followups at the same completion time',required_decisions:book.state.decision_requirements.filter(r=>g.owner_user_id===user||r.actor_id===g.member.character_id),required_travel:book.state.travel_requirements.filter(r=>g.owner_user_id===user||r.actor_id===g.member.character_id),quotes:book.state.activities.filter(a=>!a.closed&&(g.owner_user_id===user||a.actor_id===g.member.character_id))};
  return g.owner_user_id===user?{...publicView,time_revision:book.revision,incidents:book.state.incidents,private:true}:publicView;
 }
 annotateEvents(g:any,user:string,events:any[]){const book=this.load(g.id);if(!book.state)return events;const actor=g.member.character_id;return events.map(event=>({...event,choices:event.choices.map((choice:any)=>{
  const required=book.state!.decision_requirements.some(r=>r.actor_id===actor&&r.story_event_id===event.id&&(!r.choice_id||r.choice_id===choice.id));
  if(!required)return choice;const quotes=book.state!.activities.filter(q=>!q.closed&&q.kind==='decision'&&q.actor_id===actor&&q.story_event_id===event.id&&(!q.choice_id||q.choice_id===choice.id));
  return {...choice,time_requirement:{requires_quote:true,quotes:quotes.map(q=>({quote_id:q.id,duration_seconds:q.duration_seconds}))}};
 })}));}
 configure(g:any,user:string,x:any,source:string){this.owner(g,user);requireThat(!this.load(g.id).state,'RULE_VIOLATION','시간 모델은 이미 활성화되었습니다.');requireThat(g.turn_seq===0,'RULE_VIOLATION','기존 플레이 시간을 추측해 변환하지 않습니다. 첫 플레이 행동 전에 활성화하세요.');
  const before:State=JSON.parse(g.state_json);requireThat(!before.time,'RULE_VIOLATION');const state=structuredClone(before);state.time={seconds:x.initial_seconds,unit:'seconds'};
  const timeline:Timeline={seconds:x.initial_seconds,active_quote_id:null,costs:timeCosts.parse(x.action_seconds),activities:[],incidents:[],decision_requirements:[],travel_requirements:[]};
  this.save(g,user,null,timeline,'configure',source);return state;
 }
 edit(name:string,g:any,user:string,x:any){this.owner(g,user);const book=this.load(g.id);requireThat(book.state,'RULE_VIOLATION','먼저 시간 모델을 활성화하세요.');requireThat(book.revision===x.expected_time_revision,'REVISION_CONFLICT','최신 time_revision을 조회하세요.');const before=book.state,state=structuredClone(before);const world:State=JSON.parse(g.state_json),canon=canonicalEntities(world,this.manifest(g));
  const journalId=id('timeevt');let output:any;
  if(name==='rpg_game_time_plan'){
   const q=x.activity;requireThat(world.characters[q.actor_id]?.hp>0&&this.row('SELECT 1 FROM game_members WHERE game_id=? AND character_id=?',g.id,q.actor_id),'VALIDATION_ERROR','활동은 배정된 캐릭터의 것이어야 합니다.');
   const actor=world.characters[q.actor_id];let targets=q.target_ids;
   if(q.kind==='conversation')requireThat(targets.length>0&&targets.every((t:string)=>world.characters[t]?.position_id===actor.position_id),'VALIDATION_ERROR','대화할 대상과 같은 위치를 명시하세요.');
   if(q.kind==='search'&&!targets.length)targets=[actor.position_id];
   if(q.kind==='travel')requireThat(targets.length===1,'VALIDATION_ERROR','이동 목적지 하나가 필요합니다.');
   for(const t of targets)requireThat(Object.hasOwn(canon,t),'VALIDATION_ERROR','견적 대상이 없습니다.');
   if(q.kind==='decision'){
    const event=world.campaign?.events[q.story_event_id??''];requireThat(event&&(!q.choice_id||event.choices.some(c=>c.id===q.choice_id)),'VALIDATION_ERROR','시간을 소비할 선택 사건을 지정하세요.');
    if(!state.decision_requirements.some(r=>r.actor_id===q.actor_id&&r.story_event_id===q.story_event_id&&r.choice_id===q.choice_id)){requireThat(state.decision_requirements.length<200,'RESOURCE_LIMIT');state.decision_requirements.push({actor_id:q.actor_id,story_event_id:q.story_event_id,...(q.choice_id?{choice_id:q.choice_id}:{})});}
    for(const old of state.activities)if(old.actor_id===q.actor_id&&old.kind==='decision'&&old.story_event_id===q.story_event_id&&(!old.choice_id||!q.choice_id||old.choice_id===q.choice_id)){old.closed=true;if(state.active_quote_id===old.id)state.active_quote_id=null;}
   }else requireThat(!q.story_event_id&&!q.choice_id,'VALIDATION_ERROR');
   if(q.kind==='travel'){
    if(!state.travel_requirements.some(r=>r.actor_id===q.actor_id&&r.from_id===actor.position_id&&r.to_id===targets[0])){requireThat(state.travel_requirements.length<200,'RESOURCE_LIMIT');state.travel_requirements.push({actor_id:q.actor_id,from_id:actor.position_id,to_id:targets[0]});}
    for(const old of state.activities)if(old.actor_id===q.actor_id&&old.kind==='travel'&&old.location_id===actor.position_id&&old.target_ids[0]===targets[0]){old.closed=true;if(state.active_quote_id===old.id)state.active_quote_id=null;}
   }
   state.activities=state.activities.filter(a=>!a.closed);requireThat(state.activities.length<200,'RESOURCE_LIMIT');
   const quote:Activity={...q,target_ids:targets,max_actions:['conversation','search'].includes(q.kind)?q.max_actions:1,id:id('activity'),location_id:actor.position_id,uses:0,issued_at_seconds:state.seconds,closed:false};state.activities.push(quote);output={quote};
  }else{
   const incident:TimeIncident=x.incident;requireThat(!state.incidents.some(i=>i.id===incident.id),'CANON_CONFLICT','사건 ID가 이미 있습니다.');
   requireThat(state.incidents.length<100&&state.incidents.reduce((n,i)=>n+i.transitions.length,0)+incident.transitions.length<=1000,'RESOURCE_LIMIT');
   const declared=new Set<string>();for(const truth of incident.truths){requireThat(Object.hasOwn(canon,truth.subject_id)&&!forbidden.has(truth.predicate.normalize('NFKC').toLowerCase()),'VALIDATION_ERROR','시간 사건은 정식 대상의 서사 사실만 변경합니다.');const k=factKey(truth);requireThat(!declared.has(k)&&!state.incidents.some(i=>i.truth_values.some(f=>factKey(f)===k)),'CANON_CONFLICT','실제 사실은 한 사건에서 관리합니다.');declared.add(k);}
   const validateConditions=(cs:any[])=>{for(const c of cs)if(c.type==='truth')requireThat(declared.has(factKey(c)),'CANON_CONFLICT','조건의 실제 사실을 먼저 선언하세요.');};
   const validateEffects=(effects:any[])=>{const keys=new Set<string>();for(const e of effects){requireThat(declared.has(factKey(e))&&!keys.has(factKey(e)),'CANON_CONFLICT','효과는 선언된 사실을 한 번씩 변경해야 합니다.');keys.add(factKey(e));}};
   let last=state.seconds;const ids=new Set<string>();for(const t of incident.transitions){requireThat(t.at_seconds>last&&!ids.has(t.id),'VALIDATION_ERROR','사건 시점은 현재 이후로 엄격히 증가해야 합니다.');last=t.at_seconds;ids.add(t.id);validateConditions(t.conditions);validateEffects(t.effects);}
   for(const resolution of incident.resolutions){const event=world.campaign?.events[resolution.story_event_id];requireThat(event?.choices.some(c=>c.id===resolution.choice_id),'CANON_CONFLICT','해결 선택이 없습니다.');requireThat(!state.incidents.some(i=>i.resolutions.some(r=>r.story_event_id===resolution.story_event_id&&r.choice_id===resolution.choice_id)),'CANON_CONFLICT','해결 선택은 한 시간 사건만 관리합니다.');validateConditions(resolution.conditions);validateEffects(resolution.effects);}
   state.incidents.push({...incident,source_id:journalId,resolved:false,truth_values:structuredClone(incident.truths),processed:[]});output={incident_id:incident.id};
  }
  return {status:'recorded',...this.save(g,user,before,state,name,null,journalId),...output};
 }
 private condition(i:Timeline['incidents'][number],c:any,world:State){if(c.type==='flag')return Object.hasOwn(world.flags,c.key)&&canonical(world.flags[c.key])===canonical(c.value);const value=i.truth_values.find(f=>factKey(f)===factKey(c));return !!value&&canonical(value.value)===canonical(c.value);}
 private effectsPossible(i:Timeline['incidents'][number],effects:any[]){return effects.every(e=>e.expected===undefined||canonical(i.truth_values.find(f=>factKey(f)===factKey(e))?.value??null)===canonical(e.expected));}
 private set(i:Timeline['incidents'][number],effects:any[]){for(const effect of effects)i.truth_values.find(f=>factKey(f)===factKey(effect))!.value=effect.value;}
 prepare(g:any,action:Action,source:string){
  const stored=this.load(g.id);const before:State=JSON.parse(g.state_json);
  if(!stored.state){requireThat(!action.time_quote_id&&action.type!=='activity','RULE_VIOLATION','시간 활동은 활성화된 시간 모델에서 사용하세요.');return null;}
  const timeline=structuredClone(stored.state),state=structuredClone(before);requireThat(state.time?.seconds===timeline.seconds,'INTERNAL_ERROR','시간 저장 상태가 일치하지 않습니다.');
  let duration=0;
  if(action.time_quote_id){const quote=timeline.activities.find(q=>q.id===action.time_quote_id);requireThat(quote&&!quote.closed&&quote.actor_id===action.actor_id&&quote.location_id===state.characters[action.actor_id]?.position_id,'RULE_VIOLATION','유효한 현재 활동 견적이 아닙니다.');
   requireThat(actions[quote.kind]===action.type&&quote.uses<quote.max_actions,'RULE_VIOLATION','견적의 행동 종류 또는 횟수를 벗어났습니다.');
   if(action.type==='choose')requireThat(action.params?.event_id===quote.story_event_id&&(!quote.choice_id||quote.choice_id===action.params?.choice_id),'RULE_VIOLATION','다른 선택 사건에 견적을 사용할 수 없습니다.');
   else if(action.type==='activity')requireThat(!action.target_id,'RULE_VIOLATION');
   else requireThat(!!action.target_id&&quote.target_ids.includes(action.target_id),'RULE_VIOLATION','활동 범위를 벗어났습니다.');
   if(quote.uses){requireThat(timeline.active_quote_id===quote.id,'RULE_VIOLATION','중단된 활동은 새 견적이 필요합니다.');}
   else {duration=quote.duration_seconds;const prior=timeline.activities.find(a=>a.id===timeline.active_quote_id);if(prior)prior.closed=true;timeline.active_quote_id=quote.id;}
   quote.uses++;if(quote.uses>=quote.max_actions){quote.closed=true;timeline.active_quote_id=null;}
  }else{
   requireThat(!['speak','activity'].includes(action.type),'RULE_VIOLATION','대화·긴 작업은 소요 시간을 제시한 활동 견적이 필요합니다.');
   if(action.type==='choose')requireThat(!timeline.decision_requirements.some(r=>r.actor_id===action.actor_id&&r.story_event_id===action.params?.event_id&&(!r.choice_id||r.choice_id===action.params?.choice_id)),'RULE_VIOLATION','이 선택은 GM이 제시한 시간 견적이 필요합니다.');
   if(action.type==='move')requireThat(!timeline.travel_requirements.some(r=>r.actor_id===action.actor_id&&r.from_id===state.characters[action.actor_id]?.position_id&&r.to_id===action.target_id),'RULE_VIOLATION','이 이동은 GM이 제시한 시간 견적이 필요합니다.');
   duration=(timeline.costs as any)[action.type]??0;
   if(action.type!=='inspect'){const prior=timeline.activities.find(a=>a.id===timeline.active_quote_id);if(prior)prior.closed=true;timeline.active_quote_id=null;}
  }
  const end=timeline.seconds+duration;requireThat(Number.isSafeInteger(end),'RESOURCE_LIMIT','세계 시간 범위를 넘습니다.');
  const pending=timeline.incidents.flatMap((incident,order)=>incident.transitions.filter(t=>!incident.processed.some(p=>p.id===t.id)&&t.at_seconds<=end).map((transition,index)=>({incident,transition,order,index})));
  pending.sort((a,b)=>a.transition.at_seconds-b.transition.at_seconds||a.order-b.order||a.index-b.index);
  for(const {incident:i,transition:t} of pending){const cancelled=i.resolved;const fire=!cancelled&&t.conditions.every(c=>this.condition(i,c,state))&&this.effectsPossible(i,t.effects);if(fire)this.set(i,t.effects);i.processed.push({id:t.id,at_seconds:t.at_seconds,status:cancelled?'cancelled':fire?'fired':'skipped',source_id:source});}
  timeline.seconds=end;state.time={seconds:end,unit:'seconds'};
  const matches=timeline.incidents.map(i=>({incident:i,rules:i.resolutions.filter(r=>action.type==='choose'&&r.story_event_id===action.params?.event_id&&r.choice_id===action.params?.choice_id)})).filter(x=>x.rules.length);
  const resolutions=matches.map(x=>({...x,eligible:x.rules.filter(r=>r.conditions.every(c=>this.condition(x.incident,c,state))&&this.effectsPossible(x.incident,r.effects))}));
  const blocked=resolutions.some(x=>x.incident.resolved||x.eligible.length!==1);
  return {before:stored.state,timeline,state,duration,blocked,resolutions};
 }
 finish(g:any,user:string,prepared:NonNullable<ReturnType<WorldTime['prepare']>>,world:State,source:string){
  if(!prepared.blocked)for(const r of prepared.resolutions){const rule=r.eligible[0];this.set(r.incident,rule.effects);if(rule.cancel_remaining){r.incident.resolved=true;for(const t of r.incident.transitions)if(!r.incident.processed.some(p=>p.id===t.id))r.incident.processed.push({id:t.id,at_seconds:t.at_seconds,status:'cancelled',source_id:source});}}
  // Physical time is authoritative even if a valid attempted rescue no longer satisfies hidden conditions.
  requireThat(world.time?.seconds===prepared.timeline.seconds,'INTERNAL_ERROR');
  if(hash(prepared.before)!==hash(prepared.timeline))this.save(g,user,prepared.before,prepared.timeline,'player_action',source);
 }
 reveal(g:any,user:string,x:any,source:string){this.owner(g,user);const book=this.load(g.id);requireThat(book.state,'RULE_VIOLATION');const state:State=structuredClone(JSON.parse(g.state_json));
  state.campaign ??= emptyCampaign();const values:Truth[]=[];const keys=new Set<string>();
  for(const ref of x.facts){const k=factKey(ref);requireThat(!keys.has(k),'VALIDATION_ERROR','관측할 사실이 중복됩니다.');keys.add(k);const value=book.state.incidents.flatMap(i=>i.truth_values).find(t=>factKey(t)===k);requireThat(value,'NOT_FOUND','공개할 실제 사실이 없습니다.');values.push(structuredClone(value));}
  for(const value of values){const existing=[...state.campaign.facts].reverse().find(f=>factKey(f)===factKey(value)&&f.status==='confirmed'&&f.valid_to===null);if(existing)existing.valid_to=state.time!.seconds;
   state.campaign.facts.push({...value,status:'confirmed',source_event_id:source,valid_from:state.time!.seconds,valid_to:null,observed_at_seconds:state.time!.seconds});}
  return {state,values};
 }
 verify(gid:string){const current=this.load(gid);const rows=this.db.prepare('SELECT * FROM game_time_events WHERE game_id=? ORDER BY seq').all(gid) as any[];let state:Timeline|null=null,seq=0;
  for(const event of rows){requireThat(event.seq===++seq&&hash(state)===event.before_hash,'INTERNAL_ERROR','비공개 시간 이력의 연속성이 다릅니다.');state=JSON.parse(event.state_json);requireThat(hash(state)===event.after_hash,'INTERNAL_ERROR','비공개 시간 이력 해시가 다릅니다.');if(event.cause_event_id)requireThat(this.row('SELECT id FROM game_events WHERE id=? AND game_id=?',event.cause_event_id,gid),'INTERNAL_ERROR','시간 이력의 원인 Event가 없습니다.');}
  if(state)for(const incident of state.incidents){requireThat(this.row('SELECT id FROM game_time_events WHERE id=? AND game_id=?',incident.source_id,gid),'INTERNAL_ERROR','시간 사건 발행 출처가 없습니다.');for(const transition of incident.processed)requireThat(this.row('SELECT id FROM game_events WHERE id=? AND game_id=?',transition.source_id,gid),'INTERNAL_ERROR','시점 변화의 원인 Event가 없습니다.');}
  const game=this.row('SELECT state_json FROM games WHERE id=?',gid),world:State=JSON.parse(game.state_json);requireThat(current.revision===seq&&hash(current.state)===hash(state)&&(!state?!world.time:world.time?.seconds===state.seconds),'INTERNAL_ERROR','현재 세계 시간과 이력이 다릅니다.');return {verified:true,time_revision:seq,seconds:state?.seconds??null};
 }
}
