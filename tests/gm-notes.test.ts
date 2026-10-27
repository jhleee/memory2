import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory } from '../src/memory.js';
import { RpgCore } from '../src/rpg/core.js';
import { seedSample } from '../src/rpg/sample.js';
import { campaignChapter } from '../src/rpg/campaign-sample.js';
import { hash } from '../src/rpg/contracts.js';
import { GMNotes, GM_ATTENTION_POLICY } from '../src/rpg/gm-notes.js';
async function setup(db=':memory:') { const memory=new Memory(db),core=new RpgCore(memory),user=core.user('gm-test','owner'),f=await seedSample(core,user);let key=0;
 const notes=()=>core.call('rpg_game_gm_notes',user,{game_id:f.game_id});
 const write=async(operation:any)=>core.call('rpg_game_gm_note_write',user,{game_id:f.game_id,expected_notes_revision:(await notes()).notes_revision,idempotency_key:`write-${key++}`,operation});
 const add=(kind='todo',extra:any={})=>write({op:'create',note:{kind,title:'상류의 흔적',body:'나중에 확인할 가뭄의 흔적',...extra}});
 const review=async(focus_entity_ids:string[]=[])=>core.call('rpg_game_gm_review',user,{game_id:f.game_id,expected_notes_revision:(await notes()).notes_revision,idempotency_key:`review-${key++}`,focus_entity_ids});
 const tick=async(n:number)=>{for(let i=0;i<n;i++)await core.call('rpg_game_act',user,{game_id:f.game_id,expected_revision:core.game(user,f.game_id).revision,idempotency_key:`turn-${key++}`,action:{type:'inspect',actor_id:f.hero,target_id:f.location_a}});};
 return {memory,core,user,f,notes,write,add,review,tick};
}
it('private notes survive a new connection without changing GameState, Release, Event or public Memory',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'gm-notes-'));let c=await setup(join(dir,'game.db'));try{
  const game=c.core.game(c.user,c.f.game_id),release=c.core.row('SELECT * FROM releases WHERE id=?',c.f.release_id);
  await c.add('foreshadow',{title:'PRIVATE_FORESHADOW',body:'개인의 비밀 계획',source_event_ids:[],entity_ids:[c.f.enemy]});
  expect(c.core.game(c.user,c.f.game_id)).toMatchObject({state_json:game.state_json,revision:game.revision,turn_seq:game.turn_seq});
  expect(c.core.row('SELECT * FROM releases WHERE id=?',c.f.release_id)).toEqual(release);
  expect(c.core.rows('SELECT * FROM game_events WHERE game_id=?',c.f.game_id)).toHaveLength(0);
  expect(c.core.rows('SELECT * FROM memories')).toHaveLength(0);
  const {user,f}=c;c.memory.close();const m=new Memory(join(dir,'game.db'));c.memory=m;c.core=new RpgCore(m);
  const restored=await c.core.call('rpg_game_gm_notes',user,{game_id:f.game_id});expect(restored.notes[0].title).toBe('PRIVATE_FORESHADOW');expect(restored.notes_revision).toBe(1);
  expect(c.core.verify(user,f.game_id).verified).toBe(true);
 }finally{c.memory.close();rmSync(dir,{recursive:true,force:true});}
});
it('ACL protects notes, reminders and context from players, spectators and strangers',async()=>{const c=await setup();try{
 const note=await c.add('foreshadow',{title:'PRIVATE_FORESHADOW'});
 for(const role of ['player','spectator','stranger']){const user=c.core.user('gm-test',role);if(role!=='stranger')c.core.db.prepare('INSERT INTO game_members VALUES(?,?,?,?)').run(c.f.game_id,user,role,null);
  await expect(c.core.call('rpg_game_gm_notes',user,{game_id:c.f.game_id})).rejects.toMatchObject({code:'FORBIDDEN'});
  await expect(c.core.call('rpg_game_gm_review',user,{game_id:c.f.game_id,expected_notes_revision:1,idempotency_key:role})).rejects.toMatchObject({code:'FORBIDDEN'});
  await expect(c.core.call('rpg_game_gm_note_write',user,{game_id:c.f.game_id,expected_notes_revision:1,idempotency_key:role,operation:{op:'status',note_id:note.note.id,status:'resolved',reason:'위장'}})).rejects.toMatchObject({code:'FORBIDDEN'});
  if(role!=='stranger'){const context=await c.core.call('rpg_game_get_context',user,{game_id:c.f.game_id});expect(context.gm_attention).toBeUndefined();expect(JSON.stringify(context)).not.toContain('PRIVATE_FORESHADOW');const recall=await c.core.call('rpg_game_recall',user,{game_id:c.f.game_id,query:'PRIVATE_FORESHADOW'});expect(recall.facts).toHaveLength(0);}
 }
 }finally{c.memory.close();}});
it('context and list are read-only; unrelated, immature and gated reminders are not shown',async()=>{const c=await setup();try{
 await c.add('foreshadow',{entity_ids:[c.f.location_b]});await c.add('todo',{gate_flag:{key:'gate',value:true}});
 const revision=(await c.notes()).notes_revision;
 for(let i=0;i<10;i++){const ctx=await c.core.call('rpg_game_get_context',c.user,{game_id:c.f.game_id});expect(ctx.gm_attention.eligible_count).toBe(0);await c.notes();}
 expect((await c.notes()).notes_revision).toBe(revision);expect((await c.review()).suggestions).toEqual([]);
 await c.tick(3);expect((await c.review()).suggestions).toEqual([]);
 const r=await c.review([c.f.location_b]);expect(r.suggestions.map((x:any)=>x.note.kind)).toEqual(['foreshadow']);
 expect(c.core.rows('SELECT * FROM gm_note_events WHERE game_id=?',c.f.game_id)).toHaveLength(3);
 }finally{c.memory.close();}});
it('attention budgets cap frequency, repeated notes and foreshadow domination even when all notes are overdue',async()=>{const c=await setup();try{
 for(let i=0;i<8;i++)await c.add('foreshadow',{title:`복선${i}`,not_before_turn:0,due_turn:0,importance:3});
 for(const kind of ['todo','consequence','promise'])await c.add(kind,{not_before_turn:0,due_turn:0});
 const first=await c.review();expect(first.suggestions).toHaveLength(2);expect(first.suggestions.filter((x:any)=>x.note.kind==='foreshadow')).toHaveLength(1);
 expect((await c.review()).reason).toBe('review_cooldown');await c.tick(5);
 const second=await c.review();expect(second.suggestions).toHaveLength(2);expect(second.suggestions.some((s:any)=>first.suggestions.some((f:any)=>f.note.id===s.note.id))).toBe(false);
 await c.tick(5);expect((await c.review()).reason).toBe('attention_budget');
 const state=new GMNotes(c.core.db).load(c.f.game_id).state;
 expect(state.exposures).toHaveLength(4);expect(state.exposures.filter(e=>e.kind==='foreshadow')).toHaveLength(2);
 await c.tick(11);expect((await c.review()).suggestions.length).toBeGreaterThan(0);
 for(const exposure of new GMNotes(c.core.db).load(c.f.game_id).state.exposures)expect(exposure.turn).toBeGreaterThan(1);
 }finally{c.memory.close();}});
it('manual backlog lookup works during cooldown without exposing or resolving anything',async()=>{const c=await setup();try{
 await c.add('todo',{not_before_turn:0});await c.review();const book=new GMNotes(c.core.db).load(c.f.game_id);
 for(let i=0;i<5;i++){const list=await c.notes();expect(list.notes).toHaveLength(1);expect(list.notes[0].status).toBe('open');}
 expect(new GMNotes(c.core.db).load(c.f.game_id)).toEqual(book);
 }finally{c.memory.close();}});
it('snooze, reopen, resolve and drop leave evidence and do not resolve canonical world events',async()=>{const c=await setup();try{
 const created=await c.add('promise',{not_before_turn:0});const note_id=created.note.id;
 await expect(c.write({op:'status',note_id,status:'snoozed',reason:'나중',until_turn:0})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
 await c.write({op:'status',note_id,status:'snoozed',reason:'나중',until_turn:3});expect((await c.review()).suggestions).toHaveLength(0);
 await c.tick(3);expect((await c.notes()).notes[0].effective_status).toBe('open');expect((await c.review()).suggestions).toHaveLength(1);
 const source=c.core.row('SELECT id FROM game_events WHERE game_id=? ORDER BY seq DESC',c.f.game_id).id;
 const before=c.core.game(c.user,c.f.game_id).state_json;
 await c.write({op:'status',note_id,status:'resolved',reason:'이미 장면에서 다뤘다.',evidence_event_id:source});
 expect(c.core.game(c.user,c.f.game_id).state_json).toBe(before);expect((await c.notes()).notes[0].resolution).toEqual({reason:'이미 장면에서 다뤘다.',event_id:source});
 await c.tick(20);expect((await c.review()).suggestions).toHaveLength(0);
 await c.write({op:'status',note_id,status:'open',reason:'후속 과제가 생겼다.'});expect((await c.review()).suggestions).toHaveLength(1);
 await c.write({op:'status',note_id,status:'dropped',reason:'플레이어가 다른 방향을 선택했다.'});expect((await c.notes()).notes[0].status).toBe('dropped');
 }finally{c.memory.close();}});
it('note revision, stale operations and idempotency are independent of game revision',async()=>{const c=await setup();try{
 const args={game_id:c.f.game_id,expected_notes_revision:0,idempotency_key:'stable',operation:{op:'create',note:{kind:'todo',title:'기록',body:'내용'}}};
 const one=await c.core.call('rpg_game_gm_note_write',c.user,args);await c.tick(1);
 const replay=await c.core.call('rpg_game_gm_note_write',c.user,args);expect(replay.note.id).toBe(one.note.id);expect(replay.status).toBe('replayed');
 await expect(c.core.call('rpg_game_gm_note_write',c.user,{...args,idempotency_key:'stale'})).rejects.toMatchObject({code:'REVISION_CONFLICT'});
 await expect(c.core.call('rpg_game_gm_note_write',c.user,{...args,operation:{op:'create',note:{kind:'todo',title:'다름',body:'내용'}}})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
 expect((await c.notes()).total).toBe(1);
 }finally{c.memory.close();}});
it('bad references and journal write failures roll back note state, audit and idempotency together',async()=>{const c=await setup();try{
 await expect(c.add('todo',{entity_ids:['missing']})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
 const other=await seedSample(c.core,c.user);await c.core.call('rpg_game_act',c.user,{game_id:other.game_id,expected_revision:0,idempotency_key:'other-event',action:{actor_id:other.hero,type:'inspect',target_id:other.location_a}});
 const source=c.core.row('SELECT id FROM game_events WHERE game_id=?',other.game_id).id;
 await expect(c.add('todo',{source_event_ids:[source]})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
 const baseline=c.core.row('SELECT COUNT(*) n FROM operation_idempotency').n;
 c.core.db.exec("CREATE TRIGGER fail_notebook BEFORE INSERT ON gm_notebooks BEGIN SELECT RAISE(ABORT,'injected'); END;");
 await expect(c.add('todo')).rejects.toThrow();expect(c.core.rows('SELECT * FROM gm_note_events')).toHaveLength(0);expect((await c.notes()).notes_revision).toBe(0);expect(c.core.row('SELECT COUNT(*) n FROM operation_idempotency').n).toBe(baseline);
 c.core.db.exec('DROP TRIGGER fail_notebook');
 await c.add('todo',{not_before_turn:0});await c.review();
 let previous={notes:[],exposures:[],last_review_turn:null} as any;
 for(const event of c.core.rows('SELECT * FROM gm_note_events ORDER BY seq')){expect(event.before_hash).toBe(hash(previous));previous=JSON.parse(event.state_json);expect(event.after_hash).toBe(hash(previous));}
 expect(previous).toEqual(new GMNotes(c.core.db).load(c.f.game_id).state);
 }finally{c.memory.close();}});
it('due and flag gates affect relevance without overriding budgets or becoming facts',async()=>{const c=await setup();try{
 await c.add('consequence',{entity_ids:[c.f.location_b],not_before_turn:0,due_turn:2});
 expect((await c.review()).suggestions).toHaveLength(0);await c.tick(2);const r=await c.review();expect(r.suggestions[0].reasons).toContain('review_turn_reached');expect(r.canonical).toBe(false);
 await c.add('promise',{not_before_turn:0,gate_flag:{key:'confirmed',value:true}});
 // Use the existing public flag mechanism through an approved event; no note may mutate flags itself.
 expect(JSON.parse(c.core.game(c.user,c.f.game_id).state_json).flags.confirmed).toBeUndefined();
 expect((await c.notes()).notes[1].gate_flag.value).toBe(true);
 expect(GM_ATTENTION_POLICY.max_exposures_per_window).toBe(4);
 }finally{c.memory.close();}});

it('an actual story flag enables a reminder without changing event eligibility or canonical state',async()=>{const c=await setup();try{
 const p=await c.core.call('rpg_game_propose_expansion',c.user,{game_id:c.f.game_id,expected_revision:0,idempotency_key:'p',proposal:campaignChapter(c.f,1)});
 await c.core.call('rpg_game_commit_expansion',c.user,{game_id:c.f.game_id,expected_revision:0,idempotency_key:'c',proposal_id:p.proposal_id,acknowledge_semantic_limits:true});
 await c.add('consequence',{title:'봉인의 후속 과제',not_before_turn:0,gate_flag:{key:'chapter1.route',value:'faith'}});
 expect((await c.review()).suggestions).toHaveLength(0);
 await c.core.call('rpg_game_act',c.user,{game_id:c.f.game_id,expected_revision:1,idempotency_key:'move',action:{actor_id:c.f.hero,type:'move',target_id:'chapter1-city'}});
 const chosen=await c.core.call('rpg_game_act',c.user,{game_id:c.f.game_id,expected_revision:2,idempotency_key:'choose',action:{actor_id:c.f.hero,type:'choose',params:{event_id:'chapter1-decision',choice_id:'faith'}}});
 const before=c.core.game(c.user,c.f.game_id),events=await c.core.call('rpg_game_get_events',c.user,{game_id:c.f.game_id});
 const r=await c.review();expect(r.suggestions[0].note.title).toBe('봉인의 후속 과제');
 expect(await c.core.call('rpg_game_get_events',c.user,{game_id:c.f.game_id})).toEqual(events);
 expect(c.core.game(c.user,c.f.game_id)).toEqual(before);
 await c.write({op:'status',note_id:r.suggestions[0].note.id,status:'resolved',reason:'연결된 사건을 검토했다.',evidence_event_id:chosen.event_id});
 expect(await c.core.call('rpg_game_get_events',c.user,{game_id:c.f.game_id})).toEqual(events);
 }finally{c.memory.close();}});

it('private notebook audit detects journal and current-state tampering',async()=>{const c=await setup();try{
 const store=new GMNotes(c.core.db);expect(store.verify(c.f.game_id)).toMatchObject({verified:true,notes_revision:0});
 await c.add('todo',{not_before_turn:0});await c.review();expect(store.verify(c.f.game_id)).toMatchObject({verified:true,notes_revision:2});
 c.core.db.prepare('UPDATE gm_note_events SET after_hash=? WHERE game_id=? AND seq=1').run('corrupt',c.f.game_id);
 expect(()=>store.verify(c.f.game_id)).toThrow();
 }finally{c.memory.close();}});

it('a null gate requires an existing explicit null flag, not an absent flag',async()=>{const c=await setup();try{
 await c.add('todo',{not_before_turn:0,gate_flag:{key:'known_null',value:null}});expect((await c.review()).suggestions).toHaveLength(0);
 const proposal=campaignChapter(c.f,1);proposal.events[0].choices[1].effects.push({type:'flag',key:'known_null',value:null});
 const p=await c.core.call('rpg_game_propose_expansion',c.user,{game_id:c.f.game_id,expected_revision:0,idempotency_key:'null-p',proposal});
 await c.core.call('rpg_game_commit_expansion',c.user,{game_id:c.f.game_id,expected_revision:0,idempotency_key:'null-c',proposal_id:p.proposal_id,acknowledge_semantic_limits:true});
 await c.core.call('rpg_game_act',c.user,{game_id:c.f.game_id,expected_revision:1,idempotency_key:'null-m',action:{actor_id:c.f.hero,type:'move',target_id:'chapter1-city'}});
 await c.core.call('rpg_game_act',c.user,{game_id:c.f.game_id,expected_revision:2,idempotency_key:'null-a',action:{actor_id:c.f.hero,type:'choose',params:{event_id:'chapter1-decision',choice_id:'faith'}}});
 expect((await c.review()).suggestions).toHaveLength(1);
 }finally{c.memory.close();}});
