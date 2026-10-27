import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Memory } from '../src/memory.js';
import { RpgCore } from '../src/rpg/core.js';
import { seedSample } from '../src/rpg/sample.js';
import { GMNotes, GM_ATTENTION_POLICY } from '../src/rpg/gm-notes.js';
import { hash } from '../src/rpg/contracts.js';
const runId=`gm-attention-${new Date().toISOString().replaceAll(/[:.]/g,'-')}`;
const dir=resolve('evaluation/gm-attention',runId);mkdirSync(dir,{recursive:true});const db=join(dir,'game.db');
const report:any={run_id:runId,started_at:new Date().toISOString(),mode:'deterministic-actual-mcp',policy:GM_ATTENTION_POLICY,checks:[],sessions:[],reviews:[],errors:[],limits:['No human or model enjoyment evaluation','No autonomous note extraction','Voluntary review exposure is not proof of resolving a foreshadow']};
function check(name:string,passed:boolean,detail?:unknown){report.checks.push({name,passed,detail});if(!passed)report.errors.push({name,detail});}
function save(){writeFileSync(join(dir,'result.json'),JSON.stringify(report,null,2)+'\n');writeFileSync('docs/gm-attention-results.json',JSON.stringify(report,null,2)+'\n');}
const m=new Memory(db),core=new RpgCore(m),user=core.user('longplay-evaluation','gm-attention-owner');const f=await seedSample(core,user);m.close();report.fixture=f;
let notesRevision=0,gameRevision=0,lastHash:string|null=null;
async function connect(){const env={...process.env,RPG_DB:db,RPG_EVAL_SUBJECT:'gm-attention-owner'} as Record<string,string>;delete env.OPENROUTER_API_KEY;const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx','scripts/rpg-longplay-worker.ts'],env,stderr:'pipe'});transport.stderr?.on('data',()=>undefined);const client=new Client({name:'gm-attention-evaluation',version:'1'});await client.connect(transport);const call=async(name:string,args:any)=>{const r=await client.callTool({name,arguments:args});if(r.isError)throw Error(`${name}: ${(r.content as any)[0]?.text}`);return (r.structuredContent??JSON.parse((r.content as any)[0].text)) as any;};return{client,call,pid:transport.pid};}
try{
 for(let session=0;session<8;session++){
  const conn=await connect();try{
   const start=await conn.call('rpg_game_get_context',{game_id:f.game_id});check(`restart.${session}`,lastHash===null||start.state_hash===lastHash);const row:any={session:session+1,pid:conn.pid,start_hash:start.state_hash,turns:10};report.sessions.push(row);
   if(session===0){for(let i=0;i<24;i++){const kind=i<12?'foreshadow':['todo','promise','consequence'][(i-12)%3];const created=await conn.call('rpg_game_gm_note_write',{game_id:f.game_id,expected_notes_revision:notesRevision,idempotency_key:`create-${i}`,operation:{op:'create',note:{kind,title:`미해결 기록 ${i}`,body:'지금 해결하지 않아도 되는 선택적 세계관 소재',importance:kind==='foreshadow'?3:2,due_turn:0,labels:['평가','미해결'],entity_ids:[i%2?f.location_b:f.location_a]}}});notesRevision=created.notes_revision;}report.created_notes=24;}
   for(let i=0;i<10;i++){
    const turn=session*10+i+1;const action=await conn.call('rpg_game_act',{game_id:f.game_id,expected_revision:gameRevision,idempotency_key:`act-${turn}`,action:{type:'inspect',actor_id:f.hero,target_id:f.location_a}});gameRevision=action.revision;const authoritativeHash=hash(action.changes[0].after);
    const reviewArgs={game_id:f.game_id,expected_notes_revision:notesRevision,idempotency_key:`review-${turn}`,focus_entity_ids:[f.location_a]};const r=await conn.call('rpg_game_gm_review',reviewArgs);notesRevision=r.notes_revision;
    const items=r.suggestions??[];report.reviews.push({turn,status:r.status,reason:r.reason??null,items:items.map((x:any)=>({id:x.note.id,kind:x.note.kind,score:x.score,shown_count:x.note.shown_count}))});
    check(`batch_limit.${turn}`,items.length<=2);check(`kind_diversity.${turn}`,new Set(items.map((x:any)=>x.note.kind)).size===items.length);
    if(i===0){const replay=await conn.call('rpg_game_gm_review',reviewArgs);check(`review_replay.${turn}`,replay.notes_revision===r.notes_revision&&JSON.stringify(replay.suggestions)===JSON.stringify(r.suggestions));}
    const context=await conn.call('rpg_game_get_context',{game_id:f.game_id});check(`canon_unchanged.${turn}`,context.state_hash===authoritativeHash&&context.revision===gameRevision&&context.turn_seq===turn);
    const events=await conn.call('rpg_game_get_events',{game_id:f.game_id});check(`no_forced_events.${turn}`,events.events.length===0);lastHash=context.state_hash;
   }row.end_hash=lastHash;save();
  }finally{await conn.client.close();}
 }
 const memory=new Memory(db);try{
  const c=new RpgCore(memory),book=new GMNotes(c.db).load(f.game_id);const exposures=report.reviews.flatMap((r:any)=>r.items.map((x:any)=>({...x,turn:r.turn})));
  for(let turn=1;turn<=80;turn++){const recent=exposures.filter((x:any)=>x.turn>turn-20&&x.turn<=turn);check(`rolling_total.${turn}`,recent.length<=4);check(`rolling_foreshadow.${turn}`,recent.filter((x:any)=>x.kind==='foreshadow').length<=2);}
  let lastReview=-Infinity;const lastSeen=new Map<string,number>();for(const r of report.reviews.filter((r:any)=>r.items.length)){check(`review_gap.${r.turn}`,r.turn-lastReview>=5);lastReview=r.turn;for(const item of r.items){check(`note_gap.${r.turn}.${item.id}`,r.turn-(lastSeen.get(item.id)??-Infinity)>=12);lastSeen.set(item.id,r.turn);}}
  const publicEvents=c.rows('SELECT * FROM game_events WHERE game_id=?',f.game_id);check('only_player_actions',publicEvents.length===80&&publicEvents.every(e=>JSON.parse(e.action_json).type==='inspect'));
  const memories=c.rows('SELECT content FROM memories WHERE space_id=?',`game:${f.game_id}`);check('private_text_not_in_memory',!JSON.stringify(memories).includes('미해결 기록'));
  check('all_notes_still_open',book.state.notes.length===24&&book.state.notes.every(n=>n.status==='open'));
  check('verify_game',c.verify(user,f.game_id).verified);check('verify_notebook',new GMNotes(c.db).verify(f.game_id).verified);check('new_processes',new Set(report.sessions.map((s:any)=>s.pid)).size===8);
  let previous:any={notes:[],exposures:[],last_review_turn:null};const journal=c.rows('SELECT * FROM gm_note_events WHERE game_id=? ORDER BY seq',f.game_id);
  for(const event of journal){check(`journal.${event.seq}`,hash(previous)===event.before_hash&&hash(JSON.parse(event.state_json))===event.after_hash);previous=JSON.parse(event.state_json);}check('journal_current',hash(previous)===hash(book.state)&&journal.length===book.revision);
  const foreshadows=exposures.filter((x:any)=>x.kind==='foreshadow');check('fresh_foreshadows_prioritized',new Set(foreshadows.map((x:any)=>x.id)).size===foreshadows.length);
  report.summary={sessions:8,player_turns:80,created_notes:24,new_review_requests:80,idempotent_replay_requests:8,total_review_tool_calls:88,nonempty_reviews:report.reviews.filter((r:any)=>r.items.length).length,exposures:exposures.length,foreshadow_exposures:foreshadows.length,unique_exposed_notes:new Set(exposures.map((x:any)=>x.id)).size,unexposed_notes:book.state.notes.filter(n=>n.shown_count===0).length,public_events:publicEvents.length,private_journal_events:journal.length,checks:report.checks.length,passed:report.checks.filter((x:any)=>x.passed).length,failed:report.errors.length,model_calls:0,cost_usd:0};
 }finally{memory.close();}
 report.finished_at=new Date().toISOString();save();console.log(JSON.stringify({run_id:runId,...report.summary,errors:report.errors},null,2));if(report.errors.length)process.exitCode=1;
}catch(e){report.errors.push({fatal:String(e)});save();throw e;}
