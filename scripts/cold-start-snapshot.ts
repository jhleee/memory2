import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Memory } from '../src/memory.js';
import { RpgCore } from '../src/rpg/core.js';
import { WorldTime } from '../src/rpg/time.js';
import { GMNotes } from '../src/rpg/gm-notes.js';
import { hash } from '../src/rpg/contracts.js';
const plan=JSON.parse(readFileSync('docs/cold-start-plan.json','utf8'));const s=plan.sessions.find((s:any)=>s.tag===process.argv[2]);const phase=Number(process.argv[3]);if(!s||!Number.isInteger(phase))throw Error('tag and phase required');
const m=new Memory(s.database);try{const c=new RpgCore(m),f=JSON.parse(readFileSync(join(s.directory,'fixture.json'),'utf8')),g=c.game(f.user,s.game_id),state=JSON.parse(g.state_json),release=c.row('SELECT * FROM releases WHERE id=?',s.release_id);const out={at:new Date().toISOString(),phase,game_id:g.id,release_id:g.release_id,revision:g.revision,turn_seq:g.turn_seq,state,release_content_hash:release.content_hash,release_hash:hash(release),verify:c.verify(f.user,g.id),time_verify:new WorldTime(c.db).verify(g.id),notes_verify:new GMNotes(c.db).verify(g.id),private_time:new WorldTime(c.db).load(g.id),private_notes:new GMNotes(c.db).load(g.id),proposals:c.rows('SELECT * FROM expansion_proposals WHERE game_id=?',g.id),transcripts:c.rows('SELECT * FROM game_transcript WHERE game_id=?',g.id)};writeFileSync(join(s.directory,`phase${phase}-snapshot.json`),JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify({tag:s.tag,phase,revision:g.revision,turn_seq:g.turn_seq,entities:Object.keys(state.campaign?.entities??{}).length,time:state.time??null}));}finally{m.close();}
