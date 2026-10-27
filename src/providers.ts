import { createHash } from 'node:crypto';
import type { Memory } from './memory.js';
import type { EmbeddingProvider, VectorIndex, DecisionProvider, DecisionCandidate, DecisionSuggestion, QueryInput, RecallResult } from './types.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function validateVector(vector: number[], dimensions: number) {
  if (vector.length !== dimensions || vector.some(v => !Number.isFinite(v)) || !vector.some(v => v !== 0)) throw new Error('Invalid embedding vector');
}

/** Exact local cosine search; intended for small databases, replaceable with sqlite-vec. */
export class SQLiteVectorIndex implements VectorIndex {
  constructor(private memory: Memory, readonly dimensions: number) {
    if (!Number.isInteger(dimensions)||dimensions<1) throw new Error('Invalid embedding dimensions');
    memory.db.exec(`CREATE TABLE IF NOT EXISTS embeddings (
      memory_id TEXT NOT NULL REFERENCES memories(id), model TEXT NOT NULL,
      dimensions INTEGER NOT NULL, hash TEXT NOT NULL, vector TEXT NOT NULL,
      PRIMARY KEY(memory_id,model)
    ) STRICT;`);
  }
  add(memory_id: string, vector: number[], metadata: { model: string; hash: string }) {
    validateVector(vector, this.dimensions);
    const row = this.memory.db.prepare("SELECT content FROM memories WHERE id=? AND lifecycle='active'").get(memory_id) as {content:string}|undefined;
    if (!row || hash(row.content) !== metadata.hash) return;
    this.memory.db.prepare('INSERT OR REPLACE INTO embeddings VALUES (?,?,?,?,?)').run(memory_id, metadata.model, this.dimensions, metadata.hash, JSON.stringify(vector));
  }
  search(vector: number[], input: { space_id: string; model: string; limit: number; filters?: QueryInput }) {
    validateVector(vector, this.dimensions);
    if (!Number.isInteger(input.limit)||input.limit<1) throw new Error('Invalid vector search limit');
    const clauses=["m.space_id=?","m.lifecycle='active'","e.model=?","e.dimensions=?"];
    const args:unknown[]=[input.space_id,input.model,this.dimensions];
    const filters=input.filters;
    if(filters?.kind){clauses.push('m.kind=?');args.push(filters.kind);}
    if(filters?.from){clauses.push('COALESCE(m.occurred_at,m.created_at)>=?');args.push(new Date(filters.from).toISOString());}
    if(filters?.to){clauses.push('COALESCE(m.occurred_at,m.created_at)<=?');args.push(new Date(filters.to).toISOString());}
    if(filters?.at){clauses.push('(m.valid_from IS NULL OR m.valid_from<=?) AND (m.valid_to IS NULL OR m.valid_to>=?)');const at=new Date(filters.at).toISOString();args.push(at,at);}
    if(filters?.entity_id){clauses.push(`EXISTS(SELECT 1 FROM links l WHERE l.space_id=m.space_id AND l.active=1 AND ((l.from_type='memory' AND l.from_id=m.id AND l.to_type='entity' AND l.to_id=?) OR (l.to_type='memory' AND l.to_id=m.id AND l.from_type='entity' AND l.from_id=?)))`);args.push(filters.entity_id,filters.entity_id);}
    if(filters?.candidate_ids){if(!filters.candidate_ids.length)return [];clauses.push(`m.id IN (${filters.candidate_ids.map(()=>'?').join(',')})`);args.push(...filters.candidate_ids);}
    const rows = this.memory.db.prepare(`SELECT e.memory_id,e.vector,e.hash,m.content FROM embeddings e JOIN memories m ON m.id=e.memory_id
      WHERE ${clauses.join(' AND ')}`).all(...args) as {memory_id:string;vector:string;hash:string;content:string}[];
    const norm = Math.hypot(...vector);
    return rows.filter(row => row.hash === hash(row.content)).map(row => {
      const stored = JSON.parse(row.vector) as number[];
      validateVector(stored, this.dimensions);
      return { memory_id:row.memory_id, score:stored.reduce((sum,v,i)=>sum+v*vector[i],0)/(Math.hypot(...stored)*norm) };
    }).sort((a,b)=>b.score-a.score || a.memory_id.localeCompare(b.memory_id)).slice(0,input.limit);
  }
  remove(memory_id: string) { this.memory.db.prepare('DELETE FROM embeddings WHERE memory_id=?').run(memory_id); }
}

export class EmbeddingWorker {
  private busy = false;
  constructor(private memory: Memory, private provider: EmbeddingProvider, private index: VectorIndex) {
    memory.db.exec(`CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES memories(id), model TEXT NOT NULL,
      hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','done','failed')),
      attempts INTEGER NOT NULL DEFAULT 0, error TEXT,
      UNIQUE(memory_id,model,hash)
    ) STRICT;`);
  }
  /** Explicit write operation; recall never enqueues work. */
  enqueue(input: { space_id?: string; memory_ids?: string[] } = {}) {
    const clauses=["lifecycle='active'"],args:unknown[]=[];
    if(input.space_id){clauses.push('space_id=?');args.push(input.space_id);}
    if(input.memory_ids){if(!input.memory_ids.length)return 0;clauses.push(`id IN (${input.memory_ids.map(()=>'?').join(',')})`);args.push(...input.memory_ids);}
    const rows = this.memory.db.prepare(`SELECT id,content FROM memories WHERE ${clauses.join(' AND ')}`).all(...args) as {id:string;content:string}[];
    return this.memory.db.transaction(()=> {
      let added=0;
      for (const row of rows) {
        const fingerprint=hash(row.content);
        const hasEmbeddings=!!this.memory.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='embeddings'").get();
        const existing=hasEmbeddings?this.memory.db.prepare('SELECT hash,dimensions FROM embeddings WHERE memory_id=? AND model=?').get(row.id,this.provider.model) as {hash:string;dimensions:number}|undefined:undefined;
        if(existing?.hash===fingerprint&&existing.dimensions===this.provider.dimensions)continue;
        added+=this.memory.db.prepare("INSERT INTO jobs(memory_id,model,hash,state) VALUES(?,?,?,'pending') ON CONFLICT(memory_id,model,hash) DO UPDATE SET state='pending',error=NULL WHERE jobs.state='done'").run(row.id,this.provider.model,fingerprint).changes;
      }
      return added;
    })();
  }
  retryFailed(space_id?:string) { return this.memory.db.prepare(`UPDATE jobs SET state='pending',error=NULL WHERE model=? AND state='failed'${space_id?' AND memory_id IN (SELECT id FROM memories WHERE space_id=?)':''}`).run(this.provider.model,...(space_id?[space_id]:[])).changes; }
  async runOnce(limit=16,space_id?:string) {
    if (!Number.isInteger(limit)||limit<1||limit>1000) throw new Error('Invalid worker batch limit');
    if (this.busy) throw new Error('Worker is already running');
    this.busy=true;
    try {
      const jobs=this.memory.db.prepare(`SELECT * FROM jobs WHERE model=? AND state='pending'${space_id?' AND memory_id IN (SELECT id FROM memories WHERE space_id=?)':''} ORDER BY id LIMIT ?`).all(this.provider.model,...(space_id?[space_id]:[]),limit) as {id:number;memory_id:string;hash:string}[];
      const valid:{job:typeof jobs[number];content:string}[]=[];
      for (const job of jobs) {
        const row=this.memory.db.prepare("SELECT content FROM memories WHERE id=? AND lifecycle='active'").get(job.memory_id) as {content:string}|undefined;
        if (!row || hash(row.content)!==job.hash) { this.memory.db.prepare("UPDATE jobs SET state='done' WHERE id=?").run(job.id); continue; }
        valid.push({job,content:row.content});
      }
      if(valid.length)try {
        const vectors=await this.provider.embed(valid.map(row=>row.content));
        if(vectors.length!==valid.length)throw new Error('Embedding batch size mismatch');
        vectors.forEach(vector=>validateVector(vector,this.provider.dimensions));
        this.memory.db.transaction(()=> {
          valid.forEach(({job},i)=>{
            this.index.add(job.memory_id,vectors[i],{model:this.provider.model,hash:job.hash});
            this.memory.db.prepare("UPDATE jobs SET state='done',attempts=attempts+1,error=NULL WHERE id=?").run(job.id);
          });
        })();
      } catch {
        // Provider messages may include credentials; persisted failures use a fixed safe message.
        this.memory.db.transaction(()=>{for(const {job} of valid)this.memory.db.prepare("UPDATE jobs SET state='failed',attempts=attempts+1,error=? WHERE id=?").run('Embedding provider request failed',job.id);})();
      }
      return jobs.length;
    } finally { this.busy=false; }
  }
}

/** Connects to a locally running Ollama embedding model; model installation is explicit. */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  constructor(readonly model: string, readonly dimensions: number, private baseUrl='http://127.0.0.1:11434') {
    const url=new URL(baseUrl);
    if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw new Error('Ollama must use a loopback endpoint');
    if (!Number.isInteger(dimensions)||dimensions<1) throw new Error('Invalid embedding dimensions');
  }
  async embed(texts: string[]) {
    const response=await fetch(new URL('/api/embed',this.baseUrl),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:this.model,input:texts}),signal:AbortSignal.timeout(30_000)});
    if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
    const result=await response.json() as {embeddings?:number[][]};
    if (!Array.isArray(result.embeddings)||result.embeddings.length!==texts.length) throw new Error('Invalid Ollama response');
    for (const vector of result.embeddings) validateVector(vector,this.dimensions);
    return result.embeddings;
  }
}

/** Validates provider suggestions; never resolves mentions or changes stored facts. */
export async function suggestSafely(provider:DecisionProvider,question:string,candidates:DecisionCandidate[]):Promise<DecisionSuggestion[]> {
  try {
    const allowed=new Set(candidates.map(c=>c.id));
    const seen=new Set<string>();
    return (await provider.suggest(question,candidates)).filter(s=> {
      if (!allowed.has(s.id)||seen.has(s.id)||!Number.isFinite(s.score)||s.score<0||s.score>1||typeof s.reason!=='string') return false;
      seen.add(s.id);return true;
    }).sort((a,b)=>b.score-a.score);
  } catch { return []; }
}

/** Opt-in semantic recall. Provider failures fall back to the read-only core. */
export async function hybridRecall(memory:Memory,input:QueryInput,provider:EmbeddingProvider,index:VectorIndex,options?:{onError?:(error:unknown)=>void}):Promise<RecallResult> {
  const lexical=memory.recall(input);
  if (!input.query) return lexical;
  try {
    const [vector]=await provider.embed([input.query]);
    const hits=index.search(vector,{space_id:input.space_id,model:provider.model,limit:200,filters:input});
    // Core revalidates all filters before a vector candidate can enter the result.
    const eligible=memory.recall({...input,query:undefined,candidate_ids:hits.map(hit=>hit.memory_id),limit:200,max_chars:1_000_000});
    const eligibleMap=new Map(eligible.items.map(item=>[item.id,item]));
    const scores=new Map<string,number>();
    lexical.items.forEach((item,i)=>scores.set(item.id,1/(60+i+1)));
    hits.forEach((hit,i)=> {if(eligibleMap.has(hit.memory_id))scores.set(hit.memory_id,(scores.get(hit.memory_id)||0)+1/(60+i+1));});
    const itemMap=new Map([...eligible.items,...lexical.items].map(item=>[item.id,item]));
    const ranked=[...scores].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,input.limit??20);
    const sourceMap=new Map([...eligible.sources,...lexical.sources].map(source=>[source.id,source]));
    const countedSources=new Set<string>();
    let remaining=input.max_chars??12_000;
    const items=ranked.flatMap(([id])=> {
      const item=itemMap.get(id)!;
      const source=sourceMap.get(item.source_id);
      const cost=item.content.length+JSON.stringify(item.data).length+(source&&!countedSources.has(source.id)?source.content.length+JSON.stringify(source.metadata).length:0);
      if(cost>remaining)return [];
      remaining-=cost;countedSources.add(item.source_id);return [item];
    });
    const ids=new Set(items.map(item=>item.id));
    const traces=items.map(item=> {
      const trace=lexical.traces.find(t=>t.memory_id===item.id);
      const hit=hits.find(h=>h.memory_id===item.id);
      return {memory_id:item.id,matched_by:[...new Set([...(trace?.matched_by??[]),...(hit?['vector']:[])])],score:scores.get(item.id)!,source_id:item.source_id,links:trace?.links??[],components:{...(trace?.components??{}),...(hit?{cosine:hit.score}:{}),rrf:scores.get(item.id)!}};
    });
    const sources=[...sourceMap.values()].filter(source=>countedSources.has(source.id));
    return {items,current:[...new Set([...lexical.current,...eligible.current])].filter(id=>ids.has(id)),recent:[...new Set([...lexical.recent,...eligible.recent])].filter(id=>ids.has(id)),related:items.map(i=>i.id),unresolved:items.filter(i=>i.resolution==='unresolved').map(i=>i.id),sources,traces,truncated:ranked.length>items.length};
  } catch(error) {options?.onError?.(error);return lexical;}
}
