import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPENROUTER_DECISION_MODEL,
  DEFAULT_OPENROUTER_EMBEDDING_MODEL,
  OpenRouterDecisionProvider,
  OpenRouterEmbeddingProvider,
} from '../src/openrouter.js';

const key = 'sk-test-secret-never-report';
function reply(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...Object.fromEntries(new Headers(headers)) } });
}
function fakeFetch(handler: (index: number, input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
  const run = async (input: RequestInfo | URL, init?: RequestInit) => { calls.push([input, init]); return handler(calls.length - 1, input, init); };
  return { fetch: run as typeof globalThis.fetch, calls };
}
function embeddingFetch(body: unknown, status = 200) {
  return fakeFetch(() => reply(body, status));
}

describe('OpenRouter providers', () => {
  it('sends batch embeddings and restores order from response indices', async () => {
    const vectors = [[1, 0], [0, 1]];
    const { fetch, calls } = fakeFetch(() => reply({ data: [
      { index: 1, embedding: vectors[1] }, { index: 0, embedding: vectors[0] },
    ] }));
    const provider = new OpenRouterEmbeddingProvider({ apiKey: key, dimensions: 2, fetch });
    expect(provider.model).toBe(DEFAULT_OPENROUTER_EMBEDDING_MODEL);
    expect(await provider.embed(['first', 'second'])).toEqual(vectors);
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0]!;
    expect(String(url)).toBe('https://openrouter.ai/api/v1/embeddings');
    expect((init as RequestInit).headers).toMatchObject({ authorization: `Bearer ${key}` });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ model: DEFAULT_OPENROUTER_EMBEDDING_MODEL, input: ['first', 'second'] });
  });

  it('rejects empty batches, incomplete, duplicate-index, wrong-size and invalid vectors', async () => {
    const unused = fakeFetch(() => reply({}));
    const noInputs = new OpenRouterEmbeddingProvider({ apiKey: key, dimensions: 2, fetch: unused.fetch });
    await expect(noInputs.embed([])).rejects.toThrow(/non-empty/);
    expect(unused.calls).toHaveLength(0);
    for (const data of [
      [{ index: 0, embedding: [1, 0] }],
      [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [0, 1] }],
      [{ index: 0, embedding: [1] }, { index: 1, embedding: [0, 1] }],
      [{ index: 0, embedding: [Number.NaN, 0] }, { index: 1, embedding: [0, 1] }],
      [{ index: 0, embedding: [0, 0] }, { index: 1, embedding: [0, 1] }],
    ]) {
      const provider = new OpenRouterEmbeddingProvider({ apiKey: key, dimensions: 2, fetch: embeddingFetch({ data }).fetch });
      await expect(provider.embed(['a', 'b'])).rejects.toThrow();
    }
  });

  it('retries a 429 within a bounded retry delay and then succeeds', async () => {
    const { fetch, calls } = fakeFetch(index => index === 0 ? reply({ error: { message: key } }, 429, { 'retry-after': '0' }) : reply({ data: [{ index: 0, embedding: [1, 0] }] }));
    const provider = new OpenRouterEmbeddingProvider({ apiKey: key, dimensions: 2, fetch });
    await expect(provider.embed(['hello'])).resolves.toEqual([[1, 0]]);
    expect(calls).toHaveLength(2);
  });

  it('retries 5xx and does not expose arbitrary fetch error text', async () => {
    const { fetch, calls } = fakeFetch(index => index === 0 ? reply({ error: { message: key } }, 503, { 'retry-after': '0' }) : reply({ data: [{ index: 0, embedding: [1, 0] }] }));
    const provider = new OpenRouterEmbeddingProvider({ apiKey: key, dimensions: 2, fetch });
    await expect(provider.embed(['hello'])).resolves.toEqual([[1, 0]]);
    expect(calls).toHaveLength(2);
    const failing = new OpenRouterEmbeddingProvider({ apiKey: key, dimensions: 2, fetch: (async () => { throw new Error(`connection leaked ${key} other-secret`); }) as typeof globalThis.fetch });
    await expect(failing.embed(['hello'])).rejects.toThrow('OpenRouter network request failed or timed out');
    await expect(failing.embed(['hello'])).rejects.not.toThrow(key);
    await expect(failing.embed(['hello'])).rejects.not.toThrow('other-secret');
  });

  it('reports safe status and code on authorization errors without response contents or key', async () => {
    const provider = new OpenRouterEmbeddingProvider({
      apiKey: key,
      dimensions: 2,
      fetch: embeddingFetch({ error: { code: 'invalid_api_key', message: key, secret: key } }, 401).fetch,
    });
    let error: unknown;
    try { await provider.embed(['hello']); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('HTTP 401');
    expect((error as Error).message).toContain('invalid_api_key');
    expect((error as Error).message).not.toContain(key);
    expect((error as Error).message).not.toContain('secret');
  });

  it('requires an API key and keeps explicit configured model identity', () => {
    expect(() => new OpenRouterEmbeddingProvider({ apiKey: '' })).toThrow(/API key/);
    expect(() => new OpenRouterDecisionProvider({ apiKey: '' })).toThrow(/API key/);
    const embeddings = new OpenRouterEmbeddingProvider({ apiKey: key, model: 'provider/configured-id', dimensions: 2, fetch: embeddingFetch({ data: [] }).fetch });
    expect(embeddings.model).toBe('provider/configured-id');
    const decision = new OpenRouterDecisionProvider({ apiKey: key, fetch: embeddingFetch({}).fetch });
    expect(decision.model).toBe(DEFAULT_OPENROUTER_DECISION_MODEL);
  });

  it('validates typed noul, choice, and score answers and returns the requested distributions', async () => {
    const { fetch, calls } = fakeFetch(() => reply({ model:'inception/mercury-decide:free', answers:{
      relevance: { type: 'noul', noul: 0.998 },
      choose: { type: 'choice', choice: 'lia', probabilities: { lia: 0.998, unknown: 0.002 }, confidence: 0.99 },
      strength: { type: 'score', score: 1.9876487122222, legend: { '0':'unrelated','1':'partly related','2':'clearly related' }, probabilities: { '0':0.00357,'1':0.0052,'2':0.99123 }, confidence:0.98147 },
    }, usage:{}, id:'decision-id', provider:'openrouter' }));
    const provider = new OpenRouterDecisionProvider({ apiKey: key, fetch });
    const answers = await provider.decide('state text', [
      { key: 'relevance', type: 'noul', instructions:'Is it relevant?', criteria:{true:'explicitly relevant',false:'irrelevant or unknown'} },
      { key: 'choose', type: 'choice', instructions:'Choose a supported entity.', options: ['lia', 'unknown'], criteria:{lia:'Lia',unknown:'insufficient evidence'} },
      { key: 'strength', type: 'score', instructions:'Rate relation.', criteria:['unrelated','partly related','clearly related'] },
    ]);
    expect(answers).toEqual({
      relevance: { type: 'noul', noul: 0.998 },
      choose: { type: 'choice', choice: 'lia', probabilities: { lia: 0.998, unknown: 0.002 }, confidence: 0.99 },
      strength: { type: 'score', score: 1.9876487122222, legend: { '0':'unrelated','1':'partly related','2':'clearly related' }, probabilities: { '0':0.00357,'1':0.0052,'2':0.99123 }, confidence:0.98147 },
    });
    expect(JSON.parse(String((calls[0]![1] as RequestInit).body))).toEqual({
      model: DEFAULT_OPENROUTER_DECISION_MODEL,
      state: 'state text',
      questions: {
        relevance:{type:'noul',instructions:'Is it relevant?',criteria:{true:'explicitly relevant',false:'irrelevant or unknown'}},
        choose:{type:'choice',instructions:'Choose a supported entity.',criteria:{lia:'Lia',unknown:'insufficient evidence'}},
        strength:{type:'score',instructions:'Rate relation.',criteria:['unrelated','partly related','clearly related']},
      },
    });
  });

  it('rejects missing answers, unrequested IDs, invalid choices, and incomplete distributions', async () => {
    const invalid = [
      { answers:{} },
      { answers:{ q: { type: 'noul', noul: 0.5 }, injected: { type: 'noul', noul: 0.5 } } },
      { answers:{ q: { type: 'choice', choice: 'outside', probabilities: { a: 0.5, b: 0.5 }, confidence: 1 } } },
      { answers:{ q: { type: 'choice', choice: 'a', probabilities: { a: 1 }, confidence: 1 } } },
      { answers:{ q: { type: 'choice', choice: 'a', probabilities: { a: 0.6, b: 0.6 }, confidence: 1 } } },
      { answers:{ q: { type: 'noul', noul: Number.NaN } } },
      { answers:{ q: { type: 'score', score: 1.01 } } },
      { answers:{ q: { type:'score', score:3, legend:{'0':'x','1':'y','2':'z'}, probabilities:{'0':0,'1':0,'2':1}, confidence:1 } } },
      { answers:{ q: { type:'score', score:1, legend:{'0':'bad','1':'y','2':'z'}, probabilities:{'0':0,'1':0,'2':1}, confidence:1 } } },
      { answers:{ q: { type:'score', score:1.2, legend:{'0':'x','1':'y','2':'z'}, probabilities:{'0':0.2,'1':0.2,'2':0.2}, confidence:1 } } },
    ];
    for (const body of invalid) {
      const provider = new OpenRouterDecisionProvider({ apiKey: key, fetch: embeddingFetch(body).fetch });
      const qtype = body && typeof body === 'object' && 'answers' in body && (body as {answers?:Record<string,{type?:string}>}).answers?.q?.type;
      const question = qtype === 'choice'
        ? [{ key: 'q', type: 'choice' as const, instructions:'Choose', options: ['a', 'b'] }]
        : qtype==='score'
          ? [{key:'q',type:'score' as const,instructions:'Rate',criteria:['x','y','z']}]
          : [{ key: 'q', type: 'noul' as const, instructions:'Relevant?', criteria:{true:'relevant',false:'not relevant'} }];
      await expect(provider.decide('state', question)).rejects.toThrow();
    }
  });

  it('chooses only from bounded candidates and safely represents unknown', async () => {
    const { fetch, calls } = fakeFetch(() => reply({ answers:{
      choice: { type: 'choice', choice: 'unknown', probabilities: { c0: 0.1, c1: 0.2, unknown: 0.7 }, confidence: 0.7 },
    } }));
    const provider = new OpenRouterDecisionProvider({ apiKey: key, fetch });
    const picked = await provider.choose('Who received the key?', [{ id: 'unknown', content: 'candidate one' }, { id: 'lia', content: 'candidate two' }]);
    expect(picked).toEqual({ choice: null, probabilities: { unknown: 0.1, lia: 0.2 }, unknownProbability: 0.7, confidence: 0.7 });
    const body = JSON.parse(String((calls[0]![1] as RequestInit).body));
    expect(body.questions).toEqual({ choice:{ type: 'choice', instructions: expect.any(String), criteria:{c0:'candidate one',c1:'candidate two',unknown:'Insufficient evidence to select any listed candidate.'} } });
    expect(JSON.parse(body.state).candidates).toEqual([{ option: 'c0', content: 'candidate one' }, { option: 'c1', content: 'candidate two' }]);
    await expect(provider.choose('q', Array.from({ length: 21 }, (_, i) => ({ id: `${i}`, content: 'candidate' })))).rejects.toThrow(/at most/);
    expect(calls).toHaveLength(1);
  });

  it('suggests one bounded noul question per candidate and uses transparent reasons', async () => {
    const { fetch, calls } = fakeFetch(() => reply({ answers:{ c0: { type: 'noul', noul: 0.2 }, c1: { type: 'noul', noul: 0.9 } } }));
    const provider = new OpenRouterDecisionProvider({ apiKey: key, fetch });
    const suggestions = await provider.suggest('Which mentions the key?', [{ id: 'first', content: 'unrelated' }, { id: 'second', content: 'the key' }]);
    expect(suggestions).toEqual([
      { id: 'second', score: 0.9, reason: 'OpenRouter noul relevance' },
      { id: 'first', score: 0.2, reason: 'OpenRouter noul relevance' },
    ]);
    const body = JSON.parse(String((calls[0]![1] as RequestInit).body));
    expect(body.questions).toEqual({
      c0:{type:'noul',instructions:expect.stringContaining('candidate c0'),criteria:{true:expect.any(String),false:expect.any(String)}},
      c1:{type:'noul',instructions:expect.stringContaining('candidate c1'),criteria:{true:expect.any(String),false:expect.any(String)}},
    });
    expect(JSON.parse(body.state).instruction).toContain('untrusted');
    expect(await provider.suggest('q', [])).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('rejects duplicate candidate IDs and malformed choice question definitions before calling fetch', async () => {
    const { fetch, calls } = fakeFetch(() => reply({}));
    const provider = new OpenRouterDecisionProvider({ apiKey: key, fetch });
    await expect(provider.suggest('q', [{ id: 'same', content: 'a' }, { id: 'same', content: 'b' }])).rejects.toThrow(/unique/);
    await expect(provider.decide('s', [{ key: 'choice', type: 'choice', instructions:'Choose', options: ['a', 'a'] }])).rejects.toThrow(/options/);
    expect(calls).toHaveLength(0);
  });
});
