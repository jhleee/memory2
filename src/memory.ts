import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { openDatabase } from './database.js';
import { traverse, searchEntityCandidates, type TraverseInput, type EntityCandidateInput } from './graph.js';
import type { CorrectInput, EvidenceInput, ForgetInput, LinkInput, MemoryInput, MemoryItem, QueryInput, RecallResult, RecordInput, RecordResult, Ref, TimelineInput, TimelineResult, Trace } from './types.js';

type Row = Record<string, any>;
const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${randomUUID()}`;
const json = (v: unknown) => {
  let out:string | undefined;
  try { out=JSON.stringify(v ?? {},(_key,value)=>{if(typeof value==='number'&&!Number.isFinite(value))throw new TypeError('JSON numbers must be finite');if(typeof value==='undefined'||typeof value==='function'||typeof value==='symbol'||typeof value==='bigint')throw new TypeError('value is not JSON serializable');return value;}); }
  catch(e){throw new TypeError(`value is not JSON serializable: ${e instanceof Error?e.message:String(e)}`);}
  if(out===undefined)throw new TypeError('value is not JSON serializable');return out;
};
function str(v: unknown, name: string): string { if (typeof v !== 'string' || !v.trim()) throw new TypeError(`${name} must be a non-empty string`); return v; }
function date(v: string | undefined, name: string): string | undefined {
  if (v === undefined) return;
  const day=/^(\d{4})-(\d\d)-(\d\d)$/.exec(v);
  const dt=/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d)(?:\.(\d{1,3}))?)?(Z|[+-]\d\d:\d\d)$/.exec(v);
  const parts=day ?? dt;
  if(!parts)throw new TypeError(`${name} must be an ISO date or timezone-qualified datetime`);
  const y=Number(parts[1]),mo=Number(parts[2]),d=Number(parts[3]);
  const roundTrip=new Date(Date.UTC(y,mo-1,d));
  if(roundTrip.getUTCFullYear()!==y||roundTrip.getUTCMonth()!==mo-1||roundTrip.getUTCDate()!==d)throw new TypeError(`${name} has an invalid calendar date`);
  if(day)return `${v}T00:00:00.000Z`;
  if(Number(parts[4])>23||Number(parts[5])>59||Number(parts[6]??0)>59||Number(parts[8].slice(1,3))>23||Number(parts[8].slice(4,6))>59)throw new TypeError(`${name} has an invalid time`);
  const ms=Date.parse(v);if(Number.isNaN(ms))throw new TypeError(`${name} must be valid ISO date/time`);
  return new Date(ms).toISOString();
}
function object(v: unknown, name: string): Record<string, unknown> { if (v === undefined) return {}; if (!v || typeof v !== 'object' || Array.isArray(v)) throw new TypeError(`${name} must be an object`); return v as Record<string, unknown>; }
function findUnknown(v: unknown, path = ''): string[] {
  const out: string[] = [];
  if (Array.isArray(v)) v.forEach((x, i) => out.push(...findUnknown(x, `${path}[${i}]`)));
  else if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.state === 'unknown') {
      if ('value' in o && o.value === false) throw new TypeError(`unknown cannot be false at ${path || '$'}`);
      out.push(path || '$');
    }
    for (const [k, x] of Object.entries(o)) if (k !== 'state') out.push(...findUnknown(x, path ? `${path}.${k}` : k));
  }
  return out;
}
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v as object).sort(([a],[b]) => a.localeCompare(b)).map(([k,x]) => `${JSON.stringify(k)}:${stable(x)}`).join(',')}}`;
  return JSON.stringify(v);
}
function item(r: Row): MemoryItem {
  return { id:r.id, space_id:r.space_id, kind:r.kind, content:r.content, data:JSON.parse(r.data), source_id:r.source_id,
    occurred_at:r.occurred_at, valid_from:r.valid_from, valid_to:r.valid_to, lifecycle:r.lifecycle,
    resolution:r.resolution, support:r.support, created_at:r.created_at, updated_at:r.updated_at };
}
function checkEvidence(e: EvidenceInput): void { str(e?.source_type,'evidence.source_type'); str(e?.content,'evidence.content'); json(object(e?.metadata,'evidence.metadata')); }
function checkMemory(m: MemoryInput): void {
  str(m?.kind,'memory.kind'); str(m?.content,'memory.content'); json(object(m?.data,'memory.data'));
  const occurred=date(m.occurred_at,'occurred_at'), validFrom=date(m.valid_from,'valid_from'), validTo=date(m.valid_to,'valid_to');
  if (validFrom && validTo && Date.parse(validTo) < Date.parse(validFrom)) throw new TypeError('valid_to precedes valid_from');
  if (m.lifecycle && !['pending','active'].includes(m.lifecycle)) throw new TypeError('invalid lifecycle');
  if (m.resolution && !['unresolved','resolved'].includes(m.resolution)) throw new TypeError('invalid resolution');
  if (m.support && !['asserted','supported','disputed'].includes(m.support)) throw new TypeError('invalid support');
  if (m.entity_ids && (!Array.isArray(m.entity_ids) || m.entity_ids.some(x => typeof x !== 'string' || !x))) throw new TypeError('entity_ids must be strings');
}

export class Memory {
  public readonly db: Database.Database;
  constructor(path: string) { this.db = openDatabase(str(path,'path')); }
  close(): void { this.db.close(); }
  traverse(input: TraverseInput) { return traverse(this.db,input); }
  findPath(input: TraverseInput & {end: Ref}) { const result=this.traverse(input); return {...result,paths:result.paths.filter(p=>{const end=p.nodes.at(-1);return end?.id===input.end.id&&end.type===input.end.type;})}; }
  searchEntityCandidates(input: EntityCandidateInput) { return searchEntityCandidates(this.db,input); }

  record(input: RecordInput): RecordResult {
    str(input?.space_id,'space_id'); checkEvidence(input.evidence);
    if (!Array.isArray(input.memories) || !input.memories.length) throw new TypeError('memories must contain at least one item');
    input.memories.forEach(checkMemory);
    const entities = input.entities ?? []; if (!Array.isArray(entities)) throw new TypeError('entities must be an array');
    entities.forEach(e => { str(e.name,'entity.name'); object(e.metadata,'entity.metadata'); if (e.id) str(e.id,'entity.id'); });
    const links = input.links ?? []; if (!Array.isArray(links)) throw new TypeError('links must be an array');
    links.forEach(l => { str(l.relation,'link.relation'); object(l.metadata,'link.metadata'); this.checkRef(l.from); this.checkRef(l.to); });
    const hash = createHash('sha256').update(stable(input)).digest('hex');
    return this.db.transaction(() => {
      this.ensureSpace(input.space_id);
      if (input.idempotency_key) {
        str(input.idempotency_key,'idempotency_key');
        const previous = this.db.prepare('SELECT payload_hash,result FROM idempotency WHERE space_id=? AND key=?').get(input.space_id,input.idempotency_key) as Row | undefined;
        if (previous) { if (previous.payload_hash !== hash) throw new Error('idempotency key reused with different payload'); return { ...JSON.parse(previous.result), replayed:true }; }
      }
      const entitiesResult: string[] = [];
      for (const e of entities) {
        const eid = e.id ?? id('ent');
        const existing = this.db.prepare('SELECT space_id FROM entities WHERE id=?').get(eid) as Row | undefined;
        if (existing && existing.space_id !== input.space_id) throw new Error(`entity ${eid} belongs to another space`);
        this.db.prepare('INSERT INTO entities(id,space_id,name,metadata,created_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,metadata=excluded.metadata').run(eid,input.space_id,e.name,json(e.metadata),now());
        entitiesResult.push(eid);
      }
      const evidenceId = id('ev'), timestamp = now();
      this.db.prepare('INSERT INTO evidence VALUES(?,?,?,?,?,?)').run(evidenceId,input.space_id,input.evidence.source_type,input.evidence.content,json(input.evidence.metadata),timestamp);
      const memoryIds: string[] = [], missing: Record<string,string[]> = {};
      for (const m of input.memories) {
        const mid=m.id ?? id('mem'), absent=findUnknown(m.data);
        const resolution = absent.length ? 'unresolved' : (m.resolution ?? (m.kind==='mention'?'unresolved':'resolved'));
        if (this.db.prepare('SELECT 1 FROM memories WHERE id=?').get(mid)) throw new Error(`memory id already exists: ${mid}`);
        this.db.prepare('INSERT INTO memories(id,space_id,kind,content,data,source_id,occurred_at,valid_from,valid_to,lifecycle,resolution,support,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(mid,input.space_id,m.kind,m.content,json(m.data),evidenceId,date(m.occurred_at,'occurred_at') ?? null,date(m.valid_from,'valid_from') ?? null,date(m.valid_to,'valid_to') ?? null,m.lifecycle ?? 'active',resolution,m.support ?? 'asserted',timestamp,timestamp);
        this.db.prepare('INSERT INTO memory_fts(memory_id,space_id,content) VALUES(?,?,?)').run(mid,input.space_id,m.content);
        memoryIds.push(mid); if (absent.length) missing[mid]=absent;
        for (const eid of m.entity_ids ?? []) this.addLink(input.space_id,{from:{type:'memory',id:mid},relation:'about',to:{type:'entity',id:eid}});
      }
      for (const l of links) this.addLink(input.space_id,l);
      const result: RecordResult={accepted:true,evidence_id:evidenceId,memory_ids:memoryIds,entity_ids:entitiesResult,missing,replayed:false};
      if (input.idempotency_key) this.db.prepare('INSERT INTO idempotency VALUES(?,?,?,?)').run(input.space_id,input.idempotency_key,hash,json(result));
      return result;
    }).immediate();
  }

  recall(input: QueryInput): RecallResult {
    str(input?.space_id,'space_id');
    for (const [k,v] of Object.entries({from:input.from,to:input.to,at:input.at,recent_since:input.recent_since})) date(v,k);
    if (input.from && input.to && Date.parse(input.from)>Date.parse(input.to)) throw new TypeError('from is after to');
    const limit=input.limit ?? 20, maxChars=input.max_chars ?? 12000;
    if (!Number.isInteger(limit)||limit<1||limit>200) throw new TypeError('limit must be 1..200');
    if (!Number.isInteger(maxChars)||maxChars<1) throw new TypeError('max_chars must be positive');
    const at=date(input.at,'at'), from=date(input.from,'from'), to=date(input.to,'to'), recentSince=date(input.recent_since,'recent_since');
    const filters:string[]=["m.space_id=?","m.lifecycle='active'"], args:unknown[]=[input.space_id];
    if(input.candidate_ids){if(input.candidate_ids.length>200||input.candidate_ids.some(x=>typeof x!=='string'||!x))throw new TypeError('candidate_ids must contain at most 200 IDs');if(!input.candidate_ids.length)return {items:[],current:[],recent:[],related:[],unresolved:[],sources:[],traces:[],truncated:false};filters.push(`m.id IN (${input.candidate_ids.map(()=>'?').join(',')})`);args.push(...input.candidate_ids);}
    if(input.kind){filters.push('m.kind=?');args.push(str(input.kind,'kind'));}
    if(at){filters.push('(m.valid_from IS NULL OR m.valid_from<=?) AND (m.valid_to IS NULL OR m.valid_to>=?)');args.push(at,at);}
    if(from){filters.push('(COALESCE(m.occurred_at,m.created_at)>=?)');args.push(from);}if(to){filters.push('(COALESCE(m.occurred_at,m.created_at)<=?)');args.push(to);}
    if(input.entity_id){str(input.entity_id,'entity_id');filters.push(`(EXISTS(SELECT 1 FROM links ef WHERE ef.space_id=m.space_id AND ef.active=1 AND ef.from_type='memory' AND ef.from_id=m.id AND ef.to_type='entity' AND ef.to_id=?) OR EXISTS(SELECT 1 FROM links et WHERE et.space_id=m.space_id AND et.active=1 AND et.to_type='memory' AND et.to_id=m.id AND et.from_type='entity' AND et.from_id=?))`);args.push(input.entity_id,input.entity_id);}
    const allowed=(mid:string):boolean=>!!this.db.prepare(`SELECT 1 FROM memories m WHERE ${filters.join(' AND ')} AND m.id=?`).get(...args,mid);
    const candidate=new Map<string,{score:number;by:string[];links:string[]}>();
    const add=(mid:string,score:number,by:string,link='')=>{if(!allowed(mid))return;const c=candidate.get(mid)??{score:0,by:[],links:[]};c.score+=score;if(!c.by.includes(by))c.by.push(by);if(link&&!c.links.includes(link))c.links.push(link);candidate.set(mid,c);};
    const words=(input.query??'').normalize('NFKC').match(/[\p{L}\p{N}_]+/gu) ?? [];
    if(words.length){const query=words.slice(0,12).map(w=>`"${w.replaceAll('"','""')}"`).join(' OR ');
      const rows=this.db.prepare(`SELECT memory_fts.memory_id,bm25(memory_fts) rank FROM memory_fts JOIN memories m ON m.id=memory_fts.memory_id WHERE memory_fts MATCH ? AND memory_fts.space_id=? AND ${filters.join(' AND ')} ORDER BY rank,m.id LIMIT ?`).all(query,input.space_id,...args,limit*4) as Row[];
      rows.forEach((r,index)=>add(r.memory_id,1/(index+1),'fts'));}
    if(input.entity_id){str(input.entity_id,'entity_id');
      const direct=this.db.prepare(`SELECT from_id mid,relation FROM links WHERE space_id=? AND active=1 AND from_type='memory' AND to_type='entity' AND to_id=? UNION SELECT to_id,relation FROM links WHERE space_id=? AND active=1 AND to_type='memory' AND from_type='entity' AND from_id=?`).all(input.space_id,input.entity_id,input.space_id,input.entity_id) as Row[];
      for(const r of direct)add(r.mid,0.75,'entity',r.relation);
    }
    // Expand one hop from initial lexical/entity hits only; filters apply again to all candidates.
    const seeds=[...candidate.keys()];
    for(const mid of seeds){const rels=this.db.prepare(`SELECT l.from_type,l.from_id,l.to_type,l.to_id,l.relation FROM links l WHERE l.space_id=? AND l.active=1 AND ((l.from_type='memory' AND l.from_id=?) OR (l.to_type='memory' AND l.to_id=?)) LIMIT 40`).all(input.space_id,mid,mid) as Row[];
      for(const l of rels){const other=l.from_type==='memory'&&l.from_id===mid? (l.to_type==='memory'?l.to_id:null) : (l.from_type==='memory'?l.from_id:null);if(other&&other!==mid)add(other,0.25,'link',l.relation);}}
    if(!words.length&&!input.entity_id) {
      const rows=this.db.prepare(`SELECT m.id FROM memories m WHERE ${filters.join(' AND ')} ORDER BY COALESCE(m.occurred_at,m.created_at) DESC,m.id LIMIT ?`).all(...args,limit) as Row[];
      rows.forEach((r,index)=>add(r.id,0.1/(index+1),'recent'));
    }
    const ordered=[...candidate.entries()].sort((a,b)=>b[1].score-a[1].score||a[0].localeCompare(b[0])).slice(0,limit);
    const items:MemoryItem[]=[], traces:Trace[]=[], sourceById=new Map<string,Row>(), countedSources=new Set<string>(); let chars=0,truncated=false;
    for(const [mid,c] of ordered){const row=this.db.prepare('SELECT * FROM memories WHERE id=? AND space_id=?').get(mid,input.space_id) as Row;const m=item(row);const cost=m.content.length+JSON.stringify(m.data).length;
      const source=(sourceById.get(m.source_id)??this.db.prepare('SELECT id,source_type,content,metadata FROM evidence WHERE id=? AND space_id=?').get(m.source_id,input.space_id)) as Row|undefined;
      const sourceCost=source&&!countedSources.has(m.source_id)?source.content.length+JSON.stringify(JSON.parse(source.metadata)).length:0;
      if(chars+cost+sourceCost>maxChars){truncated=true;continue;} chars+=cost+sourceCost;items.push(m);if(source){sourceById.set(m.source_id,source);countedSources.add(m.source_id);}traces.push({memory_id:mid,matched_by:c.by.sort(),score:Number(c.score.toFixed(6)),source_id:m.source_id,links:c.links.sort(),components:{fts:c.by.includes('fts')?1:0,entity:c.by.includes('entity')?1:0,link:c.by.includes('link')?1:0}});}
    const validAt=Date.parse(at ?? now());
    const current=items.filter(x=>x.lifecycle==='active'&&(!x.valid_from||Date.parse(x.valid_from)<=validAt)&&(!x.valid_to||Date.parse(x.valid_to)>=validAt)).map(x=>x.id);
    const recent=items.filter(x=>!!recentSince&&Date.parse(x.occurred_at??x.created_at)>=Date.parse(recentSince)).map(x=>x.id);
    const related=items.filter(x=>traces.find(t=>t.memory_id===x.id)?.matched_by.some(y=>y==='fts'||y==='entity'||y==='link')).map(x=>x.id);
    const unresolved=items.filter(x=>x.resolution==='unresolved').map(x=>x.id);
    const sourceIds=[...new Set(items.map(x=>x.source_id))];
    const sources=sourceIds.map(s=>sourceById.get(s)).filter((s):s is Row=>!!s).map(s=>({id:s.id,source_type:s.source_type,content:s.content,metadata:JSON.parse(s.metadata)}));
    return {items,current,recent,related,unresolved,sources,traces,truncated};
  }

  correct(input: CorrectInput): RecordResult {
    str(input?.space_id,'space_id');str(input.memory_id,'memory_id');checkMemory(input.replacement);checkEvidence(input.evidence);date(input.expected_updated_at,'expected_updated_at');
    return this.db.transaction(()=>{
      const old=this.db.prepare('SELECT * FROM memories WHERE id=? AND space_id=?').get(input.memory_id,input.space_id) as Row|undefined;
      if(!old||old.lifecycle==='deleted')throw new Error('memory not found');
      if(input.expected_updated_at&&old.updated_at!==input.expected_updated_at)throw new Error('memory changed since it was read');
      if(old.lifecycle!=='active')throw new Error('only active memories can be corrected');
      let replacement=input.replacement;
      if(replacement.entity_ids===undefined){
        const refs=this.db.prepare("SELECT to_id FROM links WHERE space_id=? AND from_type='memory' AND from_id=? AND to_type='entity' AND relation='about' AND active=1 ORDER BY to_id").all(input.space_id,input.memory_id) as Row[];
        replacement={...replacement,entity_ids:refs.map(r=>r.to_id)};
      }
      const result=this.record({space_id:input.space_id,evidence:input.evidence,memories:[{...replacement,lifecycle:'active'}]});
      const newId=result.memory_ids[0];
      this.addLink(input.space_id,{from:{type:'memory',id:input.memory_id},relation:'corrected_by',to:{type:'memory',id:newId}});
      this.db.prepare("UPDATE memories SET lifecycle='stale',corrected_by=?,updated_at=? WHERE id=?").run(newId,now(),input.memory_id);
      this.db.prepare('DELETE FROM memory_fts WHERE memory_id=?').run(input.memory_id);
      this.db.prepare("UPDATE links SET active=0 WHERE space_id=? AND ((from_type='memory' AND from_id=? AND relation<>'corrected_by') OR (to_type='memory' AND to_id=?))").run(input.space_id,input.memory_id,input.memory_id);
      this.removeAuxiliary(input.memory_id);
      return result;
    }).immediate();
  }

  forget(input: ForgetInput): {deleted:boolean} {
    str(input?.space_id,'space_id');str(input.memory_id,'memory_id');
    return this.db.transaction(()=>{const row=this.db.prepare('SELECT lifecycle FROM memories WHERE id=? AND space_id=?').get(input.memory_id,input.space_id) as Row|undefined;if(!row||row.lifecycle==='deleted')return {deleted:false};
      this.db.prepare("UPDATE memories SET lifecycle='deleted',updated_at=? WHERE id=? AND space_id=?").run(now(),input.memory_id,input.space_id);
      this.db.prepare('DELETE FROM memory_fts WHERE memory_id=?').run(input.memory_id);
      this.db.prepare('UPDATE links SET active=0 WHERE space_id=? AND ((from_type=\'memory\' AND from_id=?) OR (to_type=\'memory\' AND to_id=?))').run(input.space_id,input.memory_id,input.memory_id);this.removeAuxiliary(input.memory_id);return {deleted:true};}).immediate();
  }

  explain(result: RecallResult, memory_id?: string): Trace[] { return result.traces.filter(t=>!memory_id||t.memory_id===memory_id); }

  timeline(input: TimelineInput): TimelineResult {
    str(input?.space_id,'space_id');const from=date(input.from,'from'),to=date(input.to,'to');if(from&&to&&Date.parse(from)>Date.parse(to))throw new TypeError('from is after to');
    const limit=input.limit??50,offset=input.offset??0;if(!Number.isInteger(limit)||limit<1||limit>500||!Number.isInteger(offset)||offset<0)throw new TypeError('invalid pagination');
    const clauses=["m.space_id=?","m.lifecycle IN ('active','stale')"],args:unknown[]=[input.space_id];if(!input.include_stale)clauses.push("m.lifecycle='active'");
    if(from){clauses.push('COALESCE(m.occurred_at,m.created_at)>=?');args.push(from);}if(to){clauses.push('COALESCE(m.occurred_at,m.created_at)<=?');args.push(to);}
    if(input.entity_id){clauses.push(`(EXISTS(SELECT 1 FROM links l WHERE l.space_id=m.space_id AND l.active=1 AND l.from_type='memory' AND l.from_id=m.id AND l.to_type='entity' AND l.to_id=?) OR EXISTS(SELECT 1 FROM links l WHERE l.space_id=m.space_id AND l.active=1 AND l.to_type='memory' AND l.to_id=m.id AND l.from_type='entity' AND l.from_id=?))`);args.push(input.entity_id,input.entity_id);}
    const rows=this.db.prepare(`SELECT m.* FROM memories m WHERE ${clauses.join(' AND ')} ORDER BY COALESCE(m.occurred_at,m.created_at),m.id LIMIT ? OFFSET ?`).all(...args,limit+1,offset) as Row[];
    const more=rows.length>limit;return {items:rows.slice(0,limit).map(r=>({...item(r),time_basis:r.occurred_at?'occurred_at' as const:'created_at' as const})),next_offset:more?offset+limit:null};
  }

  resolveMention(input:{space_id:string;mention_id:string;entity_id:string}):void {
    str(input.space_id,'space_id');str(input.mention_id,'mention_id');str(input.entity_id,'entity_id');
    this.db.transaction(()=>{const m=this.db.prepare('SELECT kind,space_id FROM memories WHERE id=? AND space_id=?').get(input.mention_id,input.space_id) as Row|undefined;
      if(!m||m.kind!=='mention')throw new Error('mention not found');if(!this.db.prepare("SELECT 1 FROM memories WHERE id=? AND space_id=? AND lifecycle='active'").get(input.mention_id,input.space_id))throw new Error('mention is not active');if(!this.db.prepare('SELECT 1 FROM entities WHERE id=? AND space_id=?').get(input.entity_id,input.space_id))throw new Error('entity not found in space');
      this.addLink(input.space_id,{from:{type:'memory',id:input.mention_id},relation:'mentions',to:{type:'entity',id:input.entity_id}});
      const data=JSON.parse((this.db.prepare('SELECT data FROM memories WHERE id=? AND space_id=?').get(input.mention_id,input.space_id) as Row).data);
      const resolution=findUnknown(data).length?'unresolved':'resolved';
      this.db.prepare('UPDATE memories SET resolution=?,updated_at=? WHERE id=? AND space_id=?').run(resolution,now(),input.mention_id,input.space_id);
    }).immediate();
  }

  private ensureSpace(space:string):void { this.db.prepare('INSERT OR IGNORE INTO spaces(id,created_at) VALUES(?,?)').run(space,now()); }
  private removeAuxiliary(memoryId:string):void {
    const tables=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('embeddings','jobs')").all() as Row[];
    for(const {name} of tables){
      const cols=this.db.prepare(`PRAGMA table_info(${name})`).all() as Row[];const names=new Set(cols.map(c=>c.name));
      if(name==='embeddings'&&names.has('memory_id'))this.db.prepare('DELETE FROM embeddings WHERE memory_id=?').run(memoryId);
      if(name==='jobs'&&names.has('memory_id')) {
        const stateColumn=names.has('state')?'state':names.has('status')?'status':undefined;
        if(stateColumn)this.db.prepare(`UPDATE jobs SET ${stateColumn}='done' WHERE memory_id=? AND ${stateColumn} IN ('pending','queued','running')`).run(memoryId);
      }
    }
  }
  private checkRef(r:Ref):void { if(!r||!['memory','entity','evidence'].includes(r.type))throw new TypeError('invalid link endpoint');str(r.id,'link endpoint id'); }
  private endpointExists(space:string,r:Ref):boolean {
    const table=r.type==='memory'?'memories':r.type==='entity'?'entities':'evidence';
    return !!this.db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND space_id=?`).get(r.id,space);
  }
  private addLink(space:string,l:LinkInput):void {
    this.checkRef(l.from);this.checkRef(l.to);str(l.relation,'link.relation');
    if(!this.endpointExists(space,l.from))throw new Error(`link source ${l.from.id} not found in space`);
    if(!this.endpointExists(space,l.to))throw new Error(`link target ${l.to.id} not found in space`);
    this.db.prepare('INSERT INTO links(space_id,from_type,from_id,relation,to_type,to_id,metadata,active) VALUES(?,?,?,?,?,?,?,1) ON CONFLICT(space_id,from_type,from_id,relation,to_type,to_id) DO UPDATE SET metadata=excluded.metadata,active=1')
      .run(space,l.from.type,l.from.id,l.relation,l.to.type,l.to.id,json(l.metadata));
  }
}
