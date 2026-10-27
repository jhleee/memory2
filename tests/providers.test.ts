import { describe,it,expect,afterEach } from 'vitest';
import { Memory } from '../src/memory.js';
import { SQLiteVectorIndex,EmbeddingWorker,hybridRecall,suggestSafely,OllamaEmbeddingProvider } from '../src/providers.js';
import { createServer } from 'node:http';
import type { EmbeddingProvider } from '../src/types.js';

const opened:Memory[]=[];
afterEach(()=>{for(const m of opened.splice(0))m.close();});
function setup() {
  const memory=new Memory(':memory:');opened.push(memory);
  const provider:EmbeddingProvider={model:'test-only',dimensions:2,async embed(texts){return texts.map(t=>t.includes('key')||t.includes('열쇠')?[1,0]:[0,1]);}};
  const index=new SQLiteVectorIndex(memory,2);
  const worker=new EmbeddingWorker(memory,provider,index);
  return {memory,provider,index,worker};
}
function record(m:Memory,space:string,content:string,extra:object={}) {
  return m.record({space_id:space,evidence:{source_type:'test',content},memories:[{kind:'note',content,...extra}]}).memory_ids[0];
}
describe('optional semantic providers',()=>{
  it('uses the Ollama embed HTTP contract and validates model dimensions',async()=>{
    let body:unknown;
    const server=createServer(async(req,res)=> {
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
      body=JSON.parse(Buffer.concat(chunks).toString());
      expect(req.url).toBe('/api/embed');
      res.setHeader('content-type','application/json');res.end(JSON.stringify({embeddings:[[1,0]]}));
    });
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    try {
      const address=server.address();if(!address||typeof address==='string')throw new Error('No test port');
      const endpoint=`http://127.0.0.1:${address.port}`;
      expect(await new OllamaEmbeddingProvider('test-model',2,endpoint).embed(['열쇠'])).toEqual([[1,0]]);
      expect(body).toEqual({model:'test-model',input:['열쇠']});
      await expect(new OllamaEmbeddingProvider('test-model',3,endpoint).embed(['열쇠'])).rejects.toThrow('Invalid embedding vector');
    } finally {await new Promise<void>((resolve,reject)=>server.close(err=>err?reject(err):resolve()));}
  });
  it('retrieves paraphrases, isolates spaces, and keeps hybrid recall read-only',async()=>{
    const {memory,provider,index,worker}=setup();
    const target=record(memory,'a','리아가 열쇠를 전달했다');record(memory,'b','secret key');
    worker.enqueue();await worker.runOnce();
    const before=memory.db.prepare('SELECT total_changes() n').get();
    const result=await hybridRecall(memory,{space_id:'a',query:'key',limit:1},provider,index);
    expect(result.items.map(i=>i.id)).toEqual([target]);expect(result.traces[0].matched_by).toContain('vector');
    expect(memory.db.prepare('SELECT total_changes() n').get()).toEqual(before);
  });
  it('reapplies entity and time filters to vector hits',async()=>{
    const {memory,provider,index,worker}=setup();
    memory.record({space_id:'a',evidence:{source_type:'test',content:'init'},entities:[{id:'lia',name:'리아'}],memories:[{kind:'note',content:'init'}]});
    const target=record(memory,'a','열쇠 transfer',{entity_ids:['lia'],occurred_at:'2025-01-01'});
    record(memory,'a','열쇠 irrelevant',{occurred_at:'2025-01-01'});
    record(memory,'a','열쇠 future',{entity_ids:['lia'],occurred_at:'2030-01-01'});
    worker.enqueue();await worker.runOnce();
    const result=await hybridRecall(memory,{space_id:'a',query:'key',entity_id:'lia',from:'2024-01-01',to:'2026-01-01'},provider,index);
    expect(result.items.map(i=>i.id)).toEqual([target]);
  });
  it('does not resurrect a memory deleted during embedding',async()=>{
    const {memory,index}=setup();const target=record(memory,'a','열쇠');
    const provider:EmbeddingProvider={model:'race',dimensions:2,async embed(){memory.forget({space_id:'a',memory_id:target});return [[1,0]];}};
    const worker=new EmbeddingWorker(memory,provider,index);worker.enqueue();await worker.runOnce();
    expect(index.search([1,0],{space_id:'a',model:'race',limit:10})).toEqual([]);
    expect(memory.db.prepare('SELECT COUNT(*) n FROM embeddings').get()).toEqual({n:0});
  });
  it('removes vectors on correction and deletion',async()=>{
    const {memory,index,worker}=setup();const target=record(memory,'a','열쇠');worker.enqueue();await worker.runOnce();
    memory.correct({space_id:'a',memory_id:target,evidence:{source_type:'test',content:'correction'},replacement:{kind:'note',content:'new 열쇠'}});
    expect(memory.db.prepare('SELECT COUNT(*) n FROM embeddings WHERE memory_id=?').get(target)).toEqual({n:0});
    const next=record(memory,'a','another key');worker.enqueue();await worker.runOnce();memory.forget({space_id:'a',memory_id:next});
    expect(memory.db.prepare('SELECT COUNT(*) n FROM embeddings WHERE memory_id=?').get(next)).toEqual({n:0});
  });
  it('retries failed jobs and falls back when provider is unavailable',async()=>{
    const {memory,index}=setup();record(memory,'a','keyword');let fail=true;
    const provider:EmbeddingProvider={model:'flaky',dimensions:2,async embed(){if(fail)throw new Error('offline');return [[1,0]];}};
    const worker=new EmbeddingWorker(memory,provider,index);worker.enqueue();await worker.runOnce();
    expect(memory.db.prepare("SELECT state FROM jobs").get()).toEqual({state:'failed'});
    expect(await hybridRecall(memory,{space_id:'a',query:'keyword'},provider,index)).toEqual(memory.recall({space_id:'a',query:'keyword'}));
    fail=false;expect(worker.retryFailed()).toBe(1);await worker.runOnce();
    expect(memory.db.prepare('SELECT state,attempts FROM jobs').get()).toEqual({state:'done',attempts:2});
  });
  it('validates decision suggestions without writing facts',async()=>{
    const candidates=[{id:'a',content:'candidate'}];
    expect(await suggestSafely({async suggest(){return [{id:'a',score:.8,reason:'match'},{id:'a',score:.9,reason:'duplicate'},{id:'unknown',score:1,reason:'made up'}];}},'who?',candidates)).toEqual([{id:'a',score:.8,reason:'match'}]);
    expect(await suggestSafely({async suggest(){throw new Error('offline');}},'who?',candidates)).toEqual([]);
  });
});
