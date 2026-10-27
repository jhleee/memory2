import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory } from '../src/memory.js';
import { RpgCore } from '../src/rpg/core.js';
import { WorldTime } from '../src/rpg/time.js';
import { seedSample } from '../src/rpg/sample.js';
import { rescueClock } from '../src/rpg/time-sample.js';
async function setup(db=':memory:',configure=true){const memory=new Memory(db),core=new RpgCore(memory),user=core.user('time-test','owner'),f=await seedSample(core,user);let key=0;
 const context=()=>core.call('rpg_game_get_context',user,{game_id:f.game_id,max_chars:64000});
 const get=()=>core.call('rpg_game_time_get',user,{game_id:f.game_id});
 const act=(action:any)=>core.call('rpg_game_act',user,{game_id:f.game_id,expected_revision:core.game(user,f.game_id).revision,idempotency_key:`act-${key++}`,action:{actor_id:f.hero,...action}});
 const plan=async(kind:string,duration_seconds:number,extra:any={})=>core.call('rpg_game_time_plan',user,{game_id:f.game_id,expected_time_revision:(await get()).time_revision,idempotency_key:`plan-${key++}`,activity:{actor_id:f.hero,kind,label:'공개된 활동 비용',duration_seconds,...extra}});
 const schedule=async(incident:any)=>core.call('rpg_game_time_schedule',user,{game_id:f.game_id,expected_time_revision:(await get()).time_revision,idempotency_key:`schedule-${key++}`,incident});
 const spend=async(seconds:number)=>{const q=await plan('wait',seconds);return act({type:'activity',time_quote_id:q.quote.id});};
 const install=async()=>{const revision=core.game(user,f.game_id).revision;const p=await core.call('rpg_game_propose_expansion',user,{game_id:f.game_id,expected_revision:revision,idempotency_key:`expand-${key++}`,proposal:{title:'구조 선택',rationale:'시간 상태에 따라 구조 결과가 다르다.',threads:[{id:'rescue-thread',title:'구조',goal:'인질을 구한다.',entity_ids:[f.enemy]}],events:[{id:'rescue-event',title:'구조 시도',description:'현장으로 진입한다.',thread_id:'rescue-thread',category:'dilemma',choices:[{id:'rescue',label:'구조',description:'구조를 시도한다.',effects:[{type:'flag',key:'rescued',value:true},{type:'item',character_id:f.hero,item_id:f.potion,delta:1},{type:'thread',thread_id:'rescue-thread',status:'completed'}]},{id:'leave',label:'떠난다',description:'유보한다.',effects:[{type:'flag',key:'left',value:true}]}]}]}});await core.call('rpg_game_commit_expansion',user,{game_id:f.game_id,expected_revision:revision,proposal_id:p.proposal_id,idempotency_key:`commit-${key++}`,acknowledge_semantic_limits:true});};
 if(configure)await core.call('rpg_game_time_configure',user,{game_id:f.game_id,expected_revision:0,idempotency_key:'enable'});
 return {memory,core,user,f,context,get,act,plan,schedule,spend,install};
}
it('legacy games retain their existing hashes, and reads, planning, notes and narration never advance physical time',async()=>{const legacy=await setup(':memory:',false);try{await legacy.act({type:'inspect',target_id:legacy.f.location_a});expect((await legacy.context()).state.time).toBeUndefined();await expect(legacy.core.call('rpg_game_time_configure',legacy.user,{game_id:legacy.f.game_id,expected_revision:1,idempotency_key:'late'})).rejects.toMatchObject({code:'RULE_VIOLATION'});}finally{legacy.memory.close();}
 const c=await setup();try{const hash=(await c.context()).state_hash;await c.plan('search',300);for(let i=0;i<5;i++){await c.context();await c.get();await c.core.call('rpg_game_recall',c.user,{game_id:c.f.game_id,query:'time'});}await c.core.call('rpg_game_turn_commit',c.user,{game_id:c.f.game_id,turn_seq:0,client_message_id:'text',narration:'장면 설명'});expect((await c.context()).state_hash).toBe(hash);expect((await c.get()).seconds).toBe(0);}finally{c.memory.close();}});
it('many dialogue/search inputs consume one disclosed activity duration, while a one-input long task consumes all its time',async()=>{const c=await setup();try{
 const q=await c.plan('conversation',300,{target_ids:[c.f.enemy],max_actions:20});for(let i=0;i<20;i++)await c.act({type:'speak',target_id:c.f.enemy,params:{message:`상세 대화 ${i}`},time_quote_id:q.quote.id});expect((await c.get()).seconds).toBe(300);expect((await c.context()).turn_seq).toBe(20);
 const search=await c.plan('search',600,{max_actions:10});for(let i=0;i<10;i++)await c.act({type:'inspect',target_id:c.f.location_a,time_quote_id:search.quote.id});expect((await c.get()).seconds).toBe(900);
 const work=await c.plan('work',7200);await c.act({type:'activity',time_quote_id:work.quote.id});expect((await c.get()).seconds).toBe(8100);
 await expect(c.act({type:'activity',time_quote_id:work.quote.id})).rejects.toMatchObject({code:'RULE_VIOLATION'});
 }finally{c.memory.close();}});
it('free reads/quick looks do not imply long work; speech requires a quote and defaults charge movement and combat explicitly',async()=>{const c=await setup();try{
 for(let i=0;i<30;i++)await c.act({type:'inspect',target_id:c.f.location_a});expect((await c.get()).seconds).toBe(0);
 await expect(c.act({type:'speak',target_id:c.f.enemy,params:{message:'긴 대화'}})).rejects.toMatchObject({code:'RULE_VIOLATION'});
 await c.act({type:'attack',target_id:c.f.enemy,params:{weapon_id:c.f.sword}});expect((await c.get()).seconds).toBe(6);
 await c.act({type:'move',target_id:c.f.location_b});expect((await c.get()).seconds).toBe(66);
 }finally{c.memory.close();}});
it('a quote cannot be shared, stretched to another target, or resumed after a different activity or an away/back trip',async()=>{const c=await setup();try{
 const a=await c.plan('search',100,{max_actions:20});await c.act({type:'inspect',target_id:c.f.location_a,time_quote_id:a.quote.id});await expect(c.act({type:'inspect',target_id:c.f.enemy,time_quote_id:a.quote.id})).rejects.toMatchObject({code:'RULE_VIOLATION'});
 const b=await c.plan('conversation',100,{target_ids:[c.f.enemy]});await c.act({type:'speak',target_id:c.f.enemy,params:{message:'별도 활동'},time_quote_id:b.quote.id});await expect(c.act({type:'inspect',target_id:c.f.location_a,time_quote_id:a.quote.id})).rejects.toMatchObject({code:'RULE_VIOLATION'});
 const search=await c.plan('search',100);await c.act({type:'inspect',target_id:c.f.location_a,time_quote_id:search.quote.id});await c.act({type:'move',target_id:c.f.location_b});await c.act({type:'move',target_id:c.f.location_a});await expect(c.act({type:'inspect',target_id:c.f.location_a,time_quote_id:search.quote.id})).rejects.toMatchObject({code:'RULE_VIOLATION'});expect((await c.get()).seconds).toBe(420);
 }finally{c.memory.close();}});
it('expiry changes private truth in order, without player response/context/entity/event/memory/timeline leakage',async()=>{const c=await setup();try{
 await c.install();await c.schedule(rescueClock(c.f.enemy,'rescue-event'));const player=c.core.user('time-test','player');c.core.db.prepare('INSERT INTO game_members VALUES(?,?,?,?)').run(c.f.game_id,player,'player',c.f.hero);
 const result=await c.spend(1300);const actual=await c.get();expect(actual.incidents[0].truth_values[0].value).toBe('lost');expect(actual.incidents[0].processed.map((p:any)=>p.id)).toEqual(['injury','loss']);
 const outputs:any[]=[result];for(const name of ['rpg_game_get_context','rpg_game_entities','rpg_game_get_events','rpg_game_timeline','rpg_game_time_get'] as const)outputs.push(await c.core.call(name,player,{game_id:c.f.game_id}));outputs.push(await c.core.call('rpg_game_recall',player,{game_id:c.f.game_id,query:'PRIVATE_HOSTAGE_CLOCK lost hostage_condition'}));
 const text=JSON.stringify(outputs);expect(text).not.toContain('PRIVATE_HOSTAGE_CLOCK');expect(text).not.toContain('hostage_condition');expect(text).not.toContain('"lost"');expect(text).not.toContain('"incidents"');expect(text).not.toContain('truth_values');
 expect(new WorldTime(c.core.db).verify(c.f.game_id).verified).toBe(true);
 }finally{c.memory.close();}});
it.each([[599,'rescued_safe'],[600,'rescued_injured'],[1199,'rescued_injured']])('rescue completed at %i has the planned result and cancels later deadlines',async(time,expected)=>{const c=await setup();try{
 await c.install();await c.schedule(rescueClock(c.f.enemy,'rescue-event'));const q=await c.plan('decision',time,{story_event_id:'rescue-event'});const r=await c.act({type:'choose',params:{event_id:'rescue-event',choice_id:'rescue'},time_quote_id:q.quote.id});expect(r.outcome.status).not.toBe('attempt_failed');expect((await c.get()).incidents[0].truth_values[0].value).toBe(expected);await c.spend(2000);expect((await c.get()).incidents[0].truth_values[0].value).toBe(expected);expect((await c.get()).incidents[0].resolved).toBe(true);
 }finally{c.memory.close();}});
it('a deadline at the exact completion time wins; failed rescue persists elapsed time, no reward, and replay does not advance twice',async()=>{const c=await setup();try{
 await c.install();await c.schedule(rescueClock(c.f.enemy,'rescue-event'));const quote=await c.plan('decision',1200,{story_event_id:'rescue-event'});const revision=c.core.game(c.user,c.f.game_id).revision;
 const input={game_id:c.f.game_id,expected_revision:revision,idempotency_key:'attempt',action:{type:'choose',actor_id:c.f.hero,params:{event_id:'rescue-event',choice_id:'rescue'},time_quote_id:quote.quote.id}};
 const r=await c.core.call('rpg_game_act',c.user,input);expect(r.outcome.status).toBe('attempt_failed');expect((await c.get()).seconds).toBe(1200);const state=(await c.context()).state;expect(state.flags.rescued).toBeUndefined();expect(state.characters[c.f.hero].inventory.find((x:any)=>x.item_id===c.f.potion).quantity).toBe(2);
 const replay=await c.core.call('rpg_game_act',c.user,input);expect(replay.event_id).toBe(r.event_id);expect((await c.get()).seconds).toBe(1200);expect((await c.get()).incidents[0].processed).toHaveLength(2);
 }finally{c.memory.close();}});
it('party observation is explicit and stays stale when actual facts later change',async()=>{const c=await setup();try{
 await c.install();await c.schedule(rescueClock(c.f.enemy,'rescue-event'));await c.spend(650);
 await c.core.call('rpg_game_time_reveal',c.user,{game_id:c.f.game_id,expected_revision:c.core.game(c.user,c.f.game_id).revision,idempotency_key:'observe',facts:[{subject_id:c.f.enemy,predicate:'hostage_condition'}],reason:'현장 목격자가 부상 소식을 전했다.'});
 let facts=await c.core.call('rpg_game_entities',c.user,{game_id:c.f.game_id,query:'hostage_condition'});expect(facts.facts[0]).toMatchObject({value:'injured',observed_at_seconds:650});
 await c.spend(600);expect((await c.get()).incidents[0].truth_values[0].value).toBe('lost');facts=await c.core.call('rpg_game_entities',c.user,{game_id:c.f.game_id,query:'hostage_condition'});expect(facts.facts[0].value).toBe('injured');
 }finally{c.memory.close();}});
it('owner ACL, stale revisions, malformed schedules, and player quote sharing fail without changes',async()=>{const c=await setup();try{
 await c.install();const p=c.core.user('time-test','player');c.core.db.prepare('INSERT INTO game_members VALUES(?,?,?,?)').run(c.f.game_id,p,'player',c.f.hero);
 const incident=rescueClock(c.f.enemy,'rescue-event');await expect(c.core.call('rpg_game_time_schedule',p,{game_id:c.f.game_id,expected_time_revision:1,idempotency_key:'hack',incident})).rejects.toMatchObject({code:'FORBIDDEN'});
 const bad=structuredClone(incident);bad.transitions[1].at_seconds=bad.transitions[0].at_seconds;await expect(c.schedule(bad)).rejects.toMatchObject({code:'VALIDATION_ERROR'});expect((await c.get()).incidents).toHaveLength(0);
 await c.schedule(incident);await expect(c.core.call('rpg_game_time_plan',c.user,{game_id:c.f.game_id,expected_time_revision:1,idempotency_key:'stale',activity:{actor_id:c.f.hero,kind:'work',label:'작업',duration_seconds:10}})).rejects.toMatchObject({code:'REVISION_CONFLICT'});
 }finally{c.memory.close();}});
it('Memory failure rolls back physical time, private truth, activity use, public Event, and idempotency atomically',async()=>{const c=await setup();try{
 await c.install();await c.schedule(rescueClock(c.f.enemy,'rescue-event'));const q=await c.plan('wait',1300);const oldBook=(await c.get()),oldContext=await c.context();const original=c.memory.record.bind(c.memory);c.memory.record=(input:any)=>{original(input);throw Error('injected failure');};
 await expect(c.act({type:'activity',time_quote_id:q.quote.id})).rejects.toThrow('injected');c.memory.record=original;
 expect(await c.get()).toEqual(oldBook);expect((await c.context()).state_hash).toBe(oldContext.state_hash);expect(new WorldTime(c.core.db).verify(c.f.game_id).verified).toBe(true);
 }finally{c.memory.close();}});
it('restart and backup audits preserve partially consumed activities and exact hidden transitions',async()=>{const dir=mkdtempSync(join(tmpdir(),'time-'));const c=await setup(join(dir,'game.db'));try{
 await c.install();await c.schedule(rescueClock(c.f.enemy,'rescue-event'));const q=await c.plan('search',650);await c.act({type:'inspect',target_id:c.f.location_a,time_quote_id:q.quote.id});const before=await c.get();c.memory.close();const m=new Memory(join(dir,'game.db'));try{const core=new RpgCore(m);expect(await core.call('rpg_game_time_get',c.user,{game_id:c.f.game_id})).toEqual(before);expect(new WorldTime(core.db).verify(c.f.game_id).verified).toBe(true);const continued=await core.call('rpg_game_act',c.user,{game_id:c.f.game_id,expected_revision:core.game(c.user,c.f.game_id).revision,idempotency_key:'continue',action:{type:'inspect',actor_id:c.f.hero,target_id:c.f.location_a,time_quote_id:q.quote.id}});expect(continued.outcome.time.elapsed_seconds).toBe(0);}finally{m.close();}
 }finally{try{c.memory.close();}catch{}rmSync(dir,{recursive:true,force:true});}});

it('issued decision/travel costs cannot be bypassed by omitting the quote, and replacement quotes revoke older prices',async()=>{const c=await setup();try{
 await c.install();await c.schedule(rescueClock(c.f.enemy,'rescue-event'));
 const older=await c.plan('decision',500,{story_event_id:'rescue-event',choice_id:'rescue'});const latest=await c.plan('decision',1200,{story_event_id:'rescue-event',choice_id:'rescue'});
 await expect(c.act({type:'choose',params:{event_id:'rescue-event',choice_id:'rescue'}})).rejects.toMatchObject({code:'RULE_VIOLATION'});
 await expect(c.act({type:'choose',params:{event_id:'rescue-event',choice_id:'rescue'},time_quote_id:older.quote.id})).rejects.toMatchObject({code:'RULE_VIOLATION'});
 expect((await c.get()).seconds).toBe(0);
 const r=await c.act({type:'choose',params:{event_id:'rescue-event',choice_id:'rescue'},time_quote_id:latest.quote.id});expect(r.outcome.status).toBe('attempt_failed');expect((await c.get()).seconds).toBe(1200);
 const travel=await c.plan('travel',3600,{target_ids:[c.f.location_b]});await expect(c.act({type:'move',target_id:c.f.location_b})).rejects.toMatchObject({code:'RULE_VIOLATION'});
 await c.act({type:'move',target_id:c.f.location_b,time_quote_id:travel.quote.id});expect((await c.get()).seconds).toBe(4800);
 }finally{c.memory.close();}});
it('another assigned actor cannot consume someone else’s quote, and only owner sees hidden time metadata',async()=>{const c=await setup();try{
 const q=await c.plan('search',100);const player=c.core.user('time-test','another');c.core.db.prepare('INSERT INTO game_members VALUES(?,?,?,?)').run(c.f.game_id,player,'player',c.f.enemy);
 const v=await c.core.call('rpg_game_time_get',player,{game_id:c.f.game_id});expect(v.time_revision).toBeUndefined();expect(v.quotes).toHaveLength(0);
 await expect(c.core.call('rpg_game_act',player,{game_id:c.f.game_id,expected_revision:1,idempotency_key:'stolen',action:{actor_id:c.f.enemy,type:'inspect',target_id:c.f.location_a,time_quote_id:q.quote.id}})).rejects.toMatchObject({code:'RULE_VIOLATION'});
 expect((await c.get()).seconds).toBe(0);
 }finally{c.memory.close();}});
it('same-time incidents use publication order and an unmet or stale expected condition is consumed once without stalling time',async()=>{const c=await setup();try{
 const build=(id:string,predicate:string,conditions:any[],expected:string)=>({id,title:id,truths:[{subject_id:c.f.enemy,predicate,value:'initial'}],transitions:[{id:'step',at_seconds:10,conditions,effects:[{subject_id:c.f.enemy,predicate,expected,value:'changed'}]}]});
 await c.schedule(build('first','first',[],'initial'));await c.schedule(build('second','second',[{type:'flag',key:'absent',value:true}],'initial'));await c.schedule(build('third','third',[],'wrong'));
 await c.spend(20);const book=await c.get();expect(book.incidents.map((i:any)=>i.processed[0].status)).toEqual(['fired','skipped','skipped']);expect(book.incidents[0].truth_values[0].value).toBe('changed');
 await c.spend(20);expect((await c.get()).incidents.every((i:any)=>i.processed.length===1)).toBe(true);expect((await c.get()).seconds).toBe(40);
 }finally{c.memory.close();}});
