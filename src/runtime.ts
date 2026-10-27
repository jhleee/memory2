import type { Memory } from './memory.js';
import type { EmbeddingProvider, VectorIndex, DecisionProvider, RuntimeQueryInput, RecallResult, RecordInput, CorrectInput, ForgetInput, IndexResult, SuggestMentionInput, SuggestMentionResult } from './types.js';
import { EmbeddingWorker, SQLiteVectorIndex, OllamaEmbeddingProvider, hybridRecall } from './providers.js';
import { OpenRouterEmbeddingProvider, OpenRouterDecisionProvider } from './openrouter.js';

export interface RuntimeOptions { embedding?: EmbeddingProvider; index?: VectorIndex; decision?: DecisionProvider }
export interface RuntimeEnvOptions { provider?: 'none' | 'ollama' | 'openrouter'; embeddingModel?: string; decisionModel?: string; dimensions?: number }

/** Optional orchestration of providers; core remains offline and independently usable. */
export class MemoryRuntime {
  readonly embedding?: EmbeddingProvider;
  readonly decision?: DecisionProvider;
  readonly vectorIndex?: VectorIndex;
  readonly worker?: EmbeddingWorker;
  private indexing = false;
  constructor(readonly memory: Memory, options: RuntimeOptions = {}) {
    this.embedding=options.embedding;this.decision=options.decision;
    if(options.embedding){
      this.vectorIndex=options.index??new SQLiteVectorIndex(memory,options.embedding.dimensions);
      this.worker=new EmbeddingWorker(memory,options.embedding,this.vectorIndex);
    } else if(options.index)throw new Error('A vector index requires an embedding provider');
  }
  record(input:RecordInput) {
    return this.memory.db.transaction(()=>{const result=this.memory.record(input);if(!result.replayed)this.worker?.enqueue({space_id:input.space_id,memory_ids:result.memory_ids});return result;}).immediate();
  }
  correct(input:CorrectInput) {
    return this.memory.db.transaction(()=>{const result=this.memory.correct(input);this.vectorIndex?.remove(input.memory_id);this.worker?.enqueue({space_id:input.space_id,memory_ids:result.memory_ids});return result;}).immediate();
  }
  forget(input:ForgetInput) {
    return this.memory.db.transaction(()=>{const result=this.memory.forget(input);if(result.deleted)this.vectorIndex?.remove(input.memory_id);return result;}).immediate();
  }
  async recall(input:RuntimeQueryInput):Promise<RecallResult> {
    if(input.limit!==undefined&&(!Number.isInteger(input.limit)||input.limit<1||input.limit>200))throw new TypeError('limit must be 1..200');
    const mode=input.mode??'lexical';
    if(!['lexical','hybrid','decision'].includes(mode))throw new TypeError('Unknown retrieval mode');
    const warnings:string[]=[];
    const retrievalInput=mode==='decision'?{...input,limit:Math.max(input.limit??20,20)}:input;
    let used: 'lexical'|'hybrid'|'decision'='lexical';
    let result:RecallResult;
    if(mode!=='lexical'&&this.embedding&&this.vectorIndex) {
      let failed=false;
      result=await hybridRecall(this.memory,retrievalInput,this.embedding,this.vectorIndex,{onError:()=>{failed=true;warnings.push('Embedding request failed; lexical recall used.');}});
      if(!failed&&input.query)used='hybrid';
      if(this.vectorIndex instanceof SQLiteVectorIndex) {
        const indexed=this.memory.db.prepare("SELECT COUNT(*) n FROM embeddings e JOIN memories m ON m.id=e.memory_id WHERE m.space_id=? AND m.lifecycle='active' AND e.model=?").get(input.space_id,this.embedding.model) as {n:number};
        if(!indexed.n){warnings.push('No indexed memories in this space; run indexing first.');used='lexical';}
      }
    } else {
      result=this.memory.recall(retrievalInput);
      if(mode!=='lexical')warnings.push('Embedding provider is disabled; lexical recall used.');
    }
    if(mode==='decision') {
      if(!this.decision)warnings.push('Decision provider is disabled; available retrieval used.');
      else if(result.items.length&&input.query)try {
        const candidates=result.items.slice(0,20).map(item=>({id:item.id,content:item.content}));
        const raw=await this.decision.suggest(`Rate relevance to the query using only each candidate's content. Query: ${input.query}`,candidates);
        const allowed=new Set(candidates.map(item=>item.id));
        const suggestions=new Map(raw.filter(s=>allowed.has(s.id)&&Number.isFinite(s.score)&&s.score>=0&&s.score<=1&&typeof s.reason==='string').map(s=>[s.id,s]));
        if(suggestions.size!==candidates.length)throw new Error('Incomplete decision response');
        const order=new Map(result.items.map((item,i)=>[item.id,i]));
        const ranked=result.items.slice().sort((a,b)=>(suggestions.get(b.id)?.score??-1)-(suggestions.get(a.id)?.score??-1)||order.get(a.id)!-order.get(b.id)!);
        result={...result,items:ranked,traces:ranked.map(item=> {
          const trace=result.traces.find(t=>t.memory_id===item.id)!;
          const suggestion=suggestions.get(item.id);
          return suggestion?{...trace,matched_by:[...trace.matched_by,'decision'],score:suggestion.score,components:{...trace.components,decision:suggestion.score}}:trace;
        })};
        used='decision';
      } catch {warnings.push('Decision request failed; available retrieval order preserved.');}
    }
    // Network awaits permit another process to correct or delete records. Revalidate before returning.
    const alive=new Map((this.memory.db.prepare("SELECT id,updated_at FROM memories WHERE space_id=? AND lifecycle='active'").all(input.space_id) as {id:string;updated_at:string}[]).map(row=>[row.id,row.updated_at]));
    const items=result.items.filter(item=>alive.get(item.id)===item.updated_at).slice(0,input.limit??20);
    const ids=new Set(items.map(item=>item.id));
    return {...result,items,current:result.current.filter(id=>ids.has(id)),recent:result.recent.filter(id=>ids.has(id)),related:result.related.filter(id=>ids.has(id)),unresolved:result.unresolved.filter(id=>ids.has(id)),sources:result.sources.filter(source=>items.some(item=>item.source_id===source.id)),traces:result.traces.filter(trace=>ids.has(trace.memory_id)),retrieval:{requested:mode,used,warnings,embedding_model:this.embedding?.model,decision_model:(this.decision as {model?:string}|undefined)?.model}};
  }
  async index(input:{space_id?:string;retry?:boolean}={}):Promise<IndexResult> {
    if(!this.worker)throw new Error('Embedding provider is disabled');
    if(this.indexing)throw new Error('Indexing is already running');
    if(input.space_id!==undefined&&(typeof input.space_id!=='string'||!input.space_id.trim()))throw new TypeError('space_id must be non-empty');
    this.indexing=true;
    try {
      if(input.retry)this.worker.retryFailed(input.space_id);
      const queued=this.worker.enqueue({space_id:input.space_id});
      let processed=0,count:number;
      do {count=await this.worker.runOnce(16,input.space_id);processed+=count;}while(count>0);
      const failed=this.memory.db.prepare(`SELECT COUNT(*) n FROM jobs j JOIN memories m ON m.id=j.memory_id WHERE j.model=? AND j.state='failed'${input.space_id?' AND m.space_id=?':''}`).get(this.embedding!.model,...(input.space_id?[input.space_id]:[])) as {n:number};
      return {queued,processed,failed:failed.n};
    } finally {this.indexing=false;}
  }
  async suggestMention(input:SuggestMentionInput):Promise<SuggestMentionResult> {
    if(typeof input.space_id!=='string'||!input.space_id.trim()||typeof input.memory_id!=='string'||!input.memory_id.trim())throw new TypeError('space_id and memory_id are required');
    const mention=this.memory.db.prepare("SELECT content,data FROM memories WHERE id=? AND space_id=? AND kind='mention' AND lifecycle='active'").get(input.memory_id,input.space_id) as {content:string;data:string}|undefined;
    if(!mention)throw new Error('Active mention not found in this space');
    if(input.entity_ids&&(!Array.isArray(input.entity_ids)||input.entity_ids.length>20||input.entity_ids.some(id=>typeof id!=='string'||!id)||new Set(input.entity_ids).size!==input.entity_ids.length))throw new TypeError('entity_ids must contain at most 20 unique IDs');
    const entities=this.memory.db.prepare(`SELECT id,name,metadata FROM entities WHERE space_id=?${input.entity_ids?.length?` AND id IN (${input.entity_ids.map(()=>'?').join(',')})`:input.entity_ids?' AND 0':''} ORDER BY id LIMIT 20`).all(input.space_id,...(input.entity_ids??[])) as {id:string;name:string;metadata:string}[];
    if(input.entity_ids&&entities.length!==input.entity_ids.length)throw new Error('Entity candidate not found in this space');
    const result:SuggestMentionResult={memory_id:input.memory_id,suggestions:[],unresolved:true,warnings:[]};
    if(!this.decision){result.warnings.push('Decision provider is disabled.');return result;}
    if(!entities.length){result.warnings.push('No Entity candidates in this space.');return result;}
    try {
      const candidates=entities.map(entity=>({id:entity.id,content:`${entity.name}\n${entity.metadata}`}));
      const raw=await this.decision.suggest(`Suggest identity candidates based only on explicit supporting attributes. A candidate is not confirmed; unknown attributes are not evidence. Mention: ${mention.content}\nStructured data: ${mention.data}`,candidates);
      const allowed=new Set(entities.map(entity=>entity.id));
      result.suggestions=raw.filter(s=>allowed.has(s.id)&&Number.isFinite(s.score)&&s.score>=0&&s.score<=1&&typeof s.reason==='string').sort((a,b)=>b.score-a.score);
      if(!result.suggestions.length)result.warnings.push('No valid Decision suggestions.');
    }catch{result.warnings.push('Decision request failed; mention remains unresolved.');}
    return result;
  }
  status(space_id?:string) {
    const jobs=this.worker?this.memory.db.prepare(`SELECT j.state,COUNT(*) count FROM jobs j JOIN memories m ON m.id=j.memory_id WHERE j.model=?${space_id?' AND m.space_id=?':''} GROUP BY j.state`).all(this.embedding!.model,...(space_id?[space_id]:[])):[];
    return {embedding:{enabled:!!this.embedding,model:this.embedding?.model??null,dimensions:this.embedding?.dimensions??null},decision:{enabled:!!this.decision,model:(this.decision as {model?:string}|undefined)?.model??null},jobs,indexing:this.indexing};
  }
}

export function createRuntimeFromEnv(memory:Memory,options:RuntimeEnvOptions={}):MemoryRuntime {
  const provider=options.provider??'none';
  if(provider==='none')return new MemoryRuntime(memory);
  if(provider==='ollama')return new MemoryRuntime(memory,{embedding:new OllamaEmbeddingProvider(options.embeddingModel??'nomic-embed-text',options.dimensions??768)});
  if(provider==='openrouter')return new MemoryRuntime(memory,{embedding:new OpenRouterEmbeddingProvider({model:options.embeddingModel,dimensions:options.dimensions??2048}),decision:new OpenRouterDecisionProvider({model:options.decisionModel})});
  throw new Error('Unknown provider');
}
