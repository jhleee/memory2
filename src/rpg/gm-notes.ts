import type Database from 'better-sqlite3';
import { canonical, hash, id, now, requireThat, type State } from './contracts.js';
import { canonicalEntities } from './campaign.js';
import type { GMNote, GMNotebook } from './gm-notes-contracts.js';

// Development defaults: advisory retrieval only, never a compulsory story action.
export const GM_ATTENTION_POLICY = Object.freeze({max_per_review:2,review_cooldown_turns:5,note_cooldown_turns:12,window_turns:20,max_exposures_per_window:4,max_foreshadows_per_window:2,default_min_age_turns:3,max_notes:200});
const empty = ():GMNotebook=>({notes:[],exposures:[],last_review_turn:null});
const norm=(v:string)=>v.normalize('NFKC').toLowerCase();
export class GMNotes {
 constructor(readonly db:Database.Database){}
 private row(sql:string,...args:any[]):any{return this.db.prepare(sql).get(...args);}
 private owner(game:any,user:string){requireThat(game.owner_user_id===user,'FORBIDDEN','GM 개인 기록은 Game 소유자만 접근할 수 있습니다.');}
 load(gameId:string):{revision:number;state:GMNotebook}{const row=this.row('SELECT * FROM gm_notebooks WHERE game_id=?',gameId);return row?{revision:row.revision,state:JSON.parse(row.state_json)}:{revision:0,state:empty()};}
 verify(gameId:string){
  const current=this.load(gameId);let state=empty(),revision=0;
  const events=this.db.prepare('SELECT * FROM gm_note_events WHERE game_id=? ORDER BY seq').all(gameId) as any[];
  for(const event of events){requireThat(event.seq===++revision&&event.before_hash===hash(state),'INTERNAL_ERROR','GM 기록 이력의 연속성 또는 이전 해시가 다릅니다.');state=JSON.parse(event.state_json);requireThat(event.after_hash===hash(state),'INTERNAL_ERROR','GM 기록 이력 해시가 다릅니다.');}
  requireThat(current.revision===revision&&hash(current.state)===hash(state),'INTERNAL_ERROR','GM 기록의 현재 상태와 이력이 다릅니다.');return {verified:true,notes_revision:revision,state_hash:hash(state)};
 }
 private effectiveStatus(n:GMNote,turn:number){return n.status==='snoozed'&&n.snoozed_until!==null&&turn>=n.snoozed_until?'open':n.status;}
 private candidates(state:GMNotebook,game:any,focus:string[]){
  const turn=game.turn_seq,world:State=JSON.parse(game.state_json);
  const relevant=new Set([...focus,world.scene_id,...Object.entries(world.characters).filter(([id])=>id===game.member?.character_id).map(([,ch])=>ch.position_id)]);
  // Owner membership may not carry the actor. The initial player is unambiguous in the pinned release.
  const manifest=JSON.parse(this.row('SELECT manifest_json FROM releases WHERE id=?',game.release_id).manifest_json);
  const actor=world.characters[manifest.start_config.player_character_id];if(actor)relevant.add(actor.position_id);
  return state.notes.filter(n=>this.effectiveStatus(n,turn)==='open'&&turn>=n.not_before_turn&&
   (n.last_shown_turn===null||turn-n.last_shown_turn>=GM_ATTENTION_POLICY.note_cooldown_turns)&&
   (!n.gate_flag||(Object.hasOwn(world.flags,n.gate_flag.key)&&canonical(world.flags[n.gate_flag.key])===canonical(n.gate_flag.value)))&&
   (!n.entity_ids.length||n.entity_ids.some(e=>relevant.has(e))||(n.due_turn!=null&&turn>=n.due_turn)))
  .map(note=>{const related=note.entity_ids.some(e=>relevant.has(e));const due=note.due_turn!=null&&turn>=note.due_turn;return {note,score:note.importance*2+(related?4:0)+(due?2:0)+Math.min(2,Math.floor((turn-note.created_turn)/10))-Math.min(8,note.shown_count*4),reasons:[...(related?['related_entities']:[]),...(due?['review_turn_reached']:[]),'optional_editorial_reminder']};})
  .sort((a,b)=>b.score-a.score||(a.note.last_shown_turn??-1)-(b.note.last_shown_turn??-1)||a.note.created_turn-b.note.created_turn||a.note.id.localeCompare(b.note.id));
 }
 private budget(state:GMNotebook,turn:number){
  const recent=state.exposures.filter(e=>e.turn>turn-GM_ATTENTION_POLICY.window_turns);
  const cooldown=state.last_review_turn===null?0:Math.max(0,state.last_review_turn+GM_ATTENTION_POLICY.review_cooldown_turns-turn);
  return {recent,cooldown,remaining:Math.max(0,GM_ATTENTION_POLICY.max_exposures_per_window-recent.length),foreshadows_remaining:Math.max(0,GM_ATTENTION_POLICY.max_foreshadows_per_window-recent.filter(e=>e.kind==='foreshadow').length)};
 }
 summary(game:any,user:string){this.owner(game,user);const book=this.load(game.id);const open=book.state.notes.filter(n=>this.effectiveStatus(n,game.turn_seq)==='open').length;const budget=this.budget(book.state,game.turn_seq);return {notes_revision:book.revision,open_count:open,eligible_count:this.candidates(book.state,game,[]).length,review_cooldown_remaining:budget.cooldown,remaining_exposures:budget.remaining,review_tool:'rpg_game_gm_review',instruction:'선택적인 GM 기록입니다. 해소를 강제하지 않고 현재 플레이를 우선하세요.'};}
 list(game:any,user:string,x:any){this.owner(game,user);const book=this.load(game.id);const q=norm(x.query);const rows=book.state.notes.filter(n=>(!x.status||this.effectiveStatus(n,game.turn_seq)===x.status)&&(!q||norm([n.title,n.body,...n.labels].join(' ')).includes(q))).map(n=>({...n,effective_status:this.effectiveStatus(n,game.turn_seq)}));return {notes_revision:book.revision,notes:rows.slice(x.cursor,x.cursor+x.page_size),next_cursor:rows.length>x.cursor+x.page_size?x.cursor+x.page_size:null,total:rows.length,policy:GM_ATTENTION_POLICY,canonical:false};}
 private validateRefs(game:any,note:GMNote,focus:string[]=[]){const world:State=JSON.parse(game.state_json);const manifest=JSON.parse(this.row('SELECT manifest_json FROM releases WHERE id=?',game.release_id).manifest_json);const entities=canonicalEntities(world,manifest);for(const eid of [...note.entity_ids,...focus])requireThat(Object.hasOwn(entities,eid),'VALIDATION_ERROR','연결할 정식 Entity가 없습니다.');for(const source of note.source_event_ids)requireThat(this.row('SELECT id FROM game_events WHERE id=? AND game_id=?',source,game.id),'VALIDATION_ERROR','출처 Event는 같은 Game에 있어야 합니다.');}
 mutate(name:string,game:any,user:string,x:any){
  this.owner(game,user);const stored=this.load(game.id);requireThat(stored.revision===x.expected_notes_revision,'REVISION_CONFLICT','최신 notes_revision을 조회하세요. 게임 revision과 별도입니다.');
  const state=structuredClone(stored.state),turn=game.turn_seq;let output:any;
  if(name==='rpg_game_gm_note_write'){
   const op=x.operation;
   if(op.op==='create'){
    requireThat(state.notes.length<GM_ATTENTION_POLICY.max_notes,'RESOURCE_LIMIT','GM 기록 보관 한도입니다.');
    const note:GMNote={...op.note,id:id('gmnote'),status:'open',created_turn:turn,updated_turn:turn,not_before_turn:op.note.not_before_turn??turn+GM_ATTENTION_POLICY.default_min_age_turns,snoozed_until:null,last_shown_turn:null,shown_count:0,resolution:null};
    this.validateRefs(game,note);state.notes.push(note);output={note};
   }else{
    const note=state.notes.find(n=>n.id===op.note_id);requireThat(note,'NOT_FOUND','GM 기록이 없습니다.');
    if(op.op==='update'){Object.assign(note,op.patch);this.validateRefs(game,note);}
    else{
     requireThat(op.status==='snoozed'?(op.until_turn!==undefined&&op.until_turn>turn):op.until_turn===undefined,'VALIDATION_ERROR','보류는 미래 until_turn이 필요합니다.');
     if(op.evidence_event_id)requireThat(this.row('SELECT id FROM game_events WHERE id=? AND game_id=?',op.evidence_event_id,game.id),'VALIDATION_ERROR','해소 근거는 같은 Game의 Event여야 합니다.');
     note.status=op.status;note.snoozed_until=op.status==='snoozed'?op.until_turn:null;note.resolution=['resolved','dropped'].includes(op.status)?{reason:op.reason,event_id:op.evidence_event_id??null}:null;
    }note.updated_turn=turn;output={note};
   }
  }else{
   const dummy:GMNote={id:'validation',kind:'todo',title:'validation',body:'validation',entity_ids:[],source_event_ids:[],labels:[],importance:0,not_before_turn:0,created_turn:turn,updated_turn:turn,status:'open',snoozed_until:null,last_shown_turn:null,shown_count:0,resolution:null};
   this.validateRefs(game,dummy,x.focus_entity_ids);
   const budget=this.budget(state,turn);const candidates=this.candidates(state,game,x.focus_entity_ids);const selected:typeof candidates=[];const kinds=new Set<string>();let foreshadows=budget.foreshadows_remaining;
   if(!budget.cooldown&&budget.remaining)for(const candidate of candidates){if(selected.length>=Math.min(GM_ATTENTION_POLICY.max_per_review,budget.remaining))break;if(kinds.has(candidate.note.kind))continue;if(candidate.note.kind==='foreshadow'&&!foreshadows)continue;selected.push(candidate);kinds.add(candidate.note.kind);if(candidate.note.kind==='foreshadow')foreshadows--;}
   // Empty reviews do not consume budget, and read-only context/list never change it.
   if(!selected.length)return {status:'no_suggestions',notes_revision:stored.revision,suggestions:[],reason:budget.cooldown?'review_cooldown':!budget.remaining?'attention_budget':candidates.length?'kind_budget':'no_relevant_notes',policy:GM_ATTENTION_POLICY,canonical:false};
   state.exposures=budget.recent;
   for(const {note} of selected){note.last_shown_turn=turn;note.shown_count++;state.exposures.push({note_id:note.id,kind:note.kind,turn});}
   state.last_review_turn=turn;output={suggestions:selected.map(({note,score,reasons})=>({note,score,reasons})),policy:GM_ATTENTION_POLICY,advice:'미해결 기록은 선택적 소재입니다. 현재 플레이·새로운 탐색을 우선하고 필요하면 보류·폐기하세요.'};
  }
  const revision=stored.revision+1,eid=id('gmnoteevt');
  this.db.prepare('INSERT INTO gm_note_events VALUES(?,?,?,?,?,?,?,?,?)').run(eid,game.id,revision,user,canonical({tool:name,...x}),hash(stored.state),hash(state),canonical(state),now());
  this.db.prepare('INSERT INTO gm_notebooks VALUES(?,?,?) ON CONFLICT(game_id) DO UPDATE SET revision=excluded.revision,state_json=excluded.state_json').run(game.id,revision,canonical(state));
  return {status:'recorded',notes_revision:revision,note_event_id:eid,...output,canonical:false};
 }
}
