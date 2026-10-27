import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Memory } from '../src/memory.js';
import { RpgCore } from '../src/rpg/core.js';
import { campaignChapter } from '../src/rpg/campaign-sample.js';
import { hash } from '../src/rpg/contracts.js';
import { OpenRouterDecisionProvider } from '../src/openrouter.js';
import { LongplayOpenRouter, LONGPLAY_GM, LONGPLAY_DECISION } from './lib/longplay-openrouter.js';
const offline = process.argv.includes('--offline'), key = process.env.OPENROUTER_API_KEY;
if (!offline && !key)
    throw new Error('OPENROUTER_API_KEY required');
const prior = JSON.parse(readFileSync('docs/longplay-results.json', 'utf8'));
const runId = `campaign-v2-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`;
const dir = resolve('evaluation/campaign-v2', runId);
mkdirSync(dir, { recursive: true });
const report: any = { run_id: runId, started_at: new Date().toISOString(), mode: offline ? 'offline' : 'live', design: { conditions: ['narration-only', 'campaign-overlay'], personas: 2, sessions: 4, actions_per_session: 12, total_expected_actions: 192, same_game_same_release: true, initial_state: 'copied exhausted final longplay state', selection: 'scripted routes; root/reward choices come from previous persona feedback when valid; first session predefined opposing choices', not_controlled: 'choice actions replace two control speak actions; new NPCs, goals and actual effects are the combined intervention' }, models: { gm: LONGPLAY_GM, decision: LONGPLAY_DECISION }, calls: [], sessions: [], errors: [] };
function save() { writeFileSync(join(dir, 'result.json'), JSON.stringify(report, null, 2) + '\n'); writeFileSync('docs/campaign-v2-progress.json', JSON.stringify({ run_id: runId, path: join(dir, 'result.json'), completed: report.sessions.filter((s: any) => s.done).length, rated: report.sessions.filter((s: any) => s.rating).length, calls: report.calls.length, errors: report.errors }, null, 2) + '\n'); }
const remote = offline ? undefined : new LongplayOpenRouter(key!, call => { report.calls.push(call); save(); console.error(JSON.stringify({ kind: 'model-call', model: call.model, status: call.http_status, ms: call.duration_ms })); }, 28);
async function json(role: string, input: any) { if (!remote)
    return null; for (let n = 0; n < 2; n++) {
    try {
        return await remote.json(role, input);
    }
    catch (e) {
        report.errors.push({ kind: 'model', attempt: n + 1, error: String(e) });
        save();
    }
} return null; }
async function connect(db: string, persona: string) { const env = { ...process.env, RPG_DB: db, RPG_EVAL_SUBJECT: persona } as Record<string, string>; delete env.OPENROUTER_API_KEY; const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'scripts/rpg-longplay-worker.ts'], env, stderr: 'pipe' }); transport.stderr?.on('data', () => undefined); const client = new Client({ name: 'campaign-v2-evaluation', version: '1' }); await client.connect(transport); const call = async (name: string, args: any) => { const r = await client.callTool({ name, arguments: args }); return { isError: r.isError ?? false, data: r.structuredContent ?? JSON.parse((r.content as any)[0].text) }; }; return { client, call, pid: transport.pid }; }
async function ctx(c: any, gid: string) { const r = await c.call('rpg_game_get_context', { game_id: gid, max_chars: 64000 }); if (r.isError)
    throw new Error(`context ${r.data.error?.code}`); return r.data; }
const namingDefaults = Array.from({ length: 4 }, (_, i) => ({ city: `변경 도시 ${i + 1}`, npc: `안내인 ${i + 1}`, religion: `새벽 신앙 ${i + 1}`, group: `교역 조합 ${i + 1}`, dungeon: `봉인 갱도 ${i + 1}` }));
function stateSummary(s: any, f: any) { return { hero_hp: s.characters[f.hero].hp, potions: s.characters[f.hero].inventory.find((i: any) => i.item_id === f.potion)?.quantity ?? 0, enemy_hp: s.characters[f.enemy].hp, location_id: s.characters[f.hero].position_id, flags: s.flags }; }
async function session(db: string, persona: any, mode: string, n: number, names: any, policy: any) {
    const f = persona.fixture, gid = f.game_id;
    const row: any = { persona: persona.persona, condition: mode, session: n, game_id: gid, actions: [], probes: [], choice_source: policy.source };
    report.sessions.push(row);
    save();
    let conn = await connect(db, persona.persona);
    try {
        const before = await ctx(conn, gid);
        row.start = stateSummary(before.state, f);
        row.release_id = before.release_id;
        const raw = campaignChapter(f, n, names);
        const narration = `${raw.title}. ${raw.rationale} ${raw.events[0].description}`;
        row.narration = narration;
        row.template = 'campaignChapter v1, same mechanics reused each session';
        if (mode === 'campaign-overlay') {
            const p = await conn.call('rpg_game_propose_expansion', { game_id: gid, expected_revision: before.revision, idempotency_key: `p-${n}`, proposal: raw });
            if (p.isError || !p.data.validation.valid)
                throw new Error(`proposal failed ${JSON.stringify(p.data)}`);
            row.proposal = p.data;
            const commitArgs = { game_id: gid, proposal_id: p.data.proposal_id, expected_revision: before.revision, idempotency_key: `commit-${n}`, acknowledge_semantic_limits: true };
            const done = await conn.call('rpg_game_commit_expansion', commitArgs);
            if (done.isError)
                throw new Error(`commit ${done.data.error?.code}`);
            row.commit = { event_id: done.data.event_id, revision: done.data.revision, turn_seq: done.data.turn_seq };
            const replay = await conn.call('rpg_game_commit_expansion', commitArgs);
            row.probes.push({ kind: 'expansion-replay', passed: !replay.isError && replay.data.event_id === done.data.event_id });
        }
        await conn.call('rpg_game_turn_commit', { game_id: gid, turn_seq: (await ctx(conn, gid)).turn_seq, client_message_id: `story-${n}`, narration });
        const city = `chapter${n}-city`, guide = `chapter${n}-guide`;
        const probe = await conn.call('rpg_game_entities', { game_id: gid, query: names.city });
        row.entity_lookup = { found: probe.data.entities.some((e: any) => e.id === city) };
        const direct = async (action: any, k: string) => { const c = await ctx(conn, gid); const args = { game_id: gid, expected_revision: c.revision, idempotency_key: `${n}-${k}`, action: { actor_id: f.hero, ...action } }; const r = await conn.call('rpg_game_act', args); if (r.isError)
            throw new Error(`act ${action.type} ${r.data.error?.code}`); const after = await ctx(conn, gid); row.actions.push({ type: action.type, source: action.type === 'choose' ? policy.source : 'scripted-route', outcome: r.data.outcome, before: stateSummary(c.state, f), after: stateSummary(after.state, f), state_hash: after.state_hash, event_id: r.data.event_id }); const replay = await conn.call('rpg_game_act', args); row.probes.push({ kind: 'action-replay', passed: !replay.isError && replay.data.event_id === r.data.event_id }); return after; };
        if (mode === 'narration-only') {
            const probeMove = await conn.call('rpg_game_act', { game_id: gid, expected_revision: before.revision, idempotency_key: `probe-${n}`, action: { type: 'move', actor_id: f.hero, target_id: city } });
            row.probes.push({ kind: 'unconfirmed-place', passed: probeMove.isError && probeMove.data.error?.code === 'RULE_VIOLATION' });
        }
        const destination = mode === 'campaign-overlay' ? city : f.location_b, origin = f.location_a;
        await direct({ type: 'move', target_id: destination }, 'move');
        await direct({ type: 'inspect', target_id: destination }, 'inspect');
        await direct({ type: 'speak', target_id: mode === 'campaign-overlay' ? guide : f.hero, params: { message: '현재의 선택과 의무를 확인한다.' } }, 'speak');
        if (mode === 'campaign-overlay') {
            const offered = await conn.call('rpg_game_get_events', { game_id: gid });
            row.offered = offered.data.events.map((e: any) => ({ id: e.id, category: e.category, score: e.score }));
            await direct({ type: 'choose', params: { event_id: `chapter${n}-decision`, choice_id: policy.root } }, 'choose');
            const next = await conn.call('rpg_game_get_events', { game_id: gid });
            row.followups = next.data.events.map((e: any) => e.id);
            await direct({ type: 'choose', params: { event_id: `chapter${n}-${policy.root}`, choice_id: policy.reward } }, 'follow');
            const c = await ctx(conn, gid);
            const farm = await conn.call('rpg_game_act', { game_id: gid, expected_revision: c.revision, idempotency_key: `farm-${n}`, action: { actor_id: f.hero, type: 'choose', params: { event_id: `chapter${n}-${policy.root}`, choice_id: policy.reward } } });
            row.probes.push({ kind: 'repeat-reward-fresh-key', passed: farm.isError && farm.data.error?.code === 'RULE_VIOLATION' });
        }
        else {
            await direct({ type: 'speak', target_id: f.hero, params: { message: '상단과 성소 중 하나를 돕겠다고 말한다.' } }, 'choice-intent');
            await direct({ type: 'speak', target_id: f.hero, params: { message: '성과를 나누거나 보급을 받겠다고 말한다.' } }, 'reward-intent');
        }
        await direct({ type: 'inspect', target_id: destination }, 'look');
        await direct({ type: 'move', target_id: origin }, 'return');
        await direct({ type: 'inspect', target_id: origin }, 'origin');
        await direct({ type: 'move', target_id: destination }, 'visit');
        await direct({ type: 'inspect', target_id: mode === 'campaign-overlay' ? guide : destination }, 'look-again');
        await direct({ type: 'move', target_id: origin }, 'return2');
        await direct({ type: 'speak', target_id: f.hero, params: { message: '이번 사건의 결과를 돌아본다.' } }, 'reflect');
        const end = await ctx(conn, gid);
        row.end = stateSummary(end.state, f);
        row.end_hash = end.state_hash;
        row.end_revision = end.revision;
        row.unresolved_goals = end.campaign_guidance?.unresolved_threads ?? [];
        for (let i = 0; i < 12; i++)
            await conn.call('rpg_game_turn_commit', { game_id: gid, turn_seq: end.turn_seq, client_message_id: `gap-${n}-${i}`, narration: '[계측용 서술 간격] 현재의 행동 기록을 정리한다.' });
        await conn.client.close();
        const pid = conn.pid;
        conn = await connect(db, persona.persona);
        const resumed = await ctx(conn, gid);
        row.restart = { different_process: pid !== conn.pid, hash_matches: resumed.state_hash === end.state_hash, release_matches: resumed.release_id === row.release_id };
        const recalled = await conn.call('rpg_game_recall', { game_id: gid, query: names.city, strategy: 'causal', max_chars: 16000, max_depth: 8 });
        row.memory = { facts: recalled.data.facts.length, paths: recalled.data.paths.length, supported_paths: recalled.data.paths.filter((p: any) => p.complete).length, retrieval: recalled.data.retrieval };
        const m = new Memory(db);
        try {
            const core = new RpgCore(m);
            const user = core.user('longplay-evaluation', persona.persona);
            const state = JSON.parse(core.game(user, gid).state_json);
            row.audit = { ...core.verify(user, gid), new_entities: Object.keys(state.campaign?.entities ?? {}).length, new_locations: Object.values(state.campaign?.entities ?? {}).filter((e: any) => ['city', 'location', 'region', 'dungeon'].includes(e.kind)).length, completed_threads: Object.values(state.campaign?.threads ?? {}).filter((t: any) => t.status === 'completed').length, open_threads: Object.values(state.campaign?.threads ?? {}).filter((t: any) => t.status === 'open').length, relations: state.campaign?.relations ?? [], canon_facts: state.campaign?.facts ?? [] };
        }
        finally {
            m.close();
        }
        row.done = true;
        save();
        return row;
    }
    catch (e) {
        row.error = String(e);
        report.errors.push({ condition: mode, session: n, error: String(e) });
        save();
        throw e;
    }
    finally {
        await conn.client.close();
        console.error(JSON.stringify({ kind: 'session', persona: persona.persona, mode, n, actions: row.actions.length, done: !!row.done }));
    }
}
try {
    if (remote)
        report.price_check = await remote.verifyFreeModel();
    const generated = await json('RPG 세계관 편집자', { task: '4개의 연결 가능한 변경 지역 이름과 안내인·신앙·상단·갱도 이름을 짧고 구체적인 한국어로 작성. 지역별 이름은 서로 달라야 한다. 실제 게임 규칙은 서버 템플릿이 담당한다. 반환 {chapters:[{city,npc,religion,group,dungeon},...4개]}. 모호한 물체나 새로운 초능력을 추가하지 말라.' });
    const valid = generated?.chapters?.length === 4 && generated.chapters.every((x: any) => ['city', 'npc', 'religion', 'group', 'dungeon'].every(k => typeof x[k] === 'string' && x[k].length > 0 && x[k].length < 100)) && new Set(generated.chapters.map((x: any) => x.city)).size === 4;
    report.names = valid ? generated.chapters : namingDefaults;
    report.name_source = valid ? 'live-flint' : 'fixed-fallback';
    const dbs: Record<string, string> = {};
    for (const mode of report.design.conditions) {
        dbs[mode] = join(dir, `${mode}.db`);
        const m = new Memory(resolve('evaluation/longplay', prior.run_id, 'campaigns.db'));
        await m.db.backup(dbs[mode]);
        m.close();
    }
    const policies: any = {};
    for (const p of prior.campaigns)
        policies[p.persona] = { root: p.tag === 'designer' ? 'guild' : 'faith', reward: 'share', source: 'predefined-first-session' };
    for (let n = 1; n <= 4; n++) {
        await Promise.all(prior.campaigns.map(async (p: any) => { const rows = []; for (const mode of report.design.conditions)
            rows.push(await session(dbs[mode], p, mode, n, report.names[n - 1], policies[p.persona])); const ordered = (n + (p.tag === 'designer' ? 0 : 1)) % 2 ? rows.slice().reverse() : rows; const samples = ordered.map((r: any, i: number) => ({ clip: `sample-${i + 1}`, narration: r.narration, actions: r.actions.map((a: any) => ({ type: a.type, outcome: a.type === 'choose' ? a.outcome : null })), actual: { state: r.end, completed_threads: r.audit.completed_threads, new_entities: r.audit.new_entities, available_followup_events: r.followups ?? [], restarted: r.restart.hash_matches, recall: r.memory, goals: r.unresolved_goals } })); const rating = await json(p.role, { task: '서버 실제 결과를 근거로 두 플레이 샘플을 평가. 조건명은 숨겼지만 기능 결과는 볼 수 있다. 모델 주관 점수이며 인간 재미 보장 아님. 장기 재미를 확정하지 말 것. 반환 {ratings:[{clip,boredom_1_to_5,text_interest_1_to_5,play_interest_1_to_5,agency_1_to_5,causal_consistency_1_to_5,reason}],next_root_choice:"guild|faith",next_reward_choice:"share|supplies",limitations:[]}. boredom만 높을수록 지루함. 다음 선택은 이전 결과와 비용을 참고.', session: n, samples }); for (let i = 0; i < ordered.length; i++) {
            ordered[i].rating = rating?.ratings?.find((x: any) => x.clip === `sample-${i + 1}`) ?? null;
            ordered[i].rating_limitations = rating?.limitations ?? [];
        } if (['guild', 'faith'].includes(rating?.next_root_choice) && ['share', 'supplies'].includes(rating?.next_reward_choice))
            policies[p.persona] = { root: rating.next_root_choice, reward: rating.next_reward_choice, source: 'model-previous-session-feedback' }; save(); }));
    }
    if (remote) {
        const decision = new OpenRouterDecisionProvider({ model: LONGPLAY_DECISION, fetch: remote.fetch, timeoutMs: 90000 });
        report.decision = await decision.suggest('어느 후보가 실제 선택 효과·관계 변화·조건부 후속 사건·완료한 목표의 근거를 제공하는가?', report.design.conditions.map((condition: string) => ({ id: condition, content: JSON.stringify(report.sessions.filter((s: any) => s.condition === condition && s.session === 4).map((s: any) => ({ flags: s.end.flags, completed: s.audit.completed_threads, relations: s.audit.relations, followups: s.followups ?? [] }))) })));
    }
    report.summary = report.design.conditions.map((condition: string) => { const rows = report.sessions.filter((r: any) => r.condition === condition); const avg = (k: string) => { const xs = rows.map((r: any) => r.rating?.[k]).filter((x: any) => typeof x === 'number'); return { n: xs.length, mean: xs.length ? xs.reduce((a: number, b: number) => a + b, 0) / xs.length : null }; }; return { condition, sessions: rows.length, actions: rows.reduce((n: number, r: any) => n + r.actions.length, 0), same_game_ids: prior.campaigns.every((p: any) => rows.filter((r: any) => r.persona === p.persona).every((r: any) => r.game_id === p.fixture.game_id)), same_release_ids: prior.campaigns.every((p: any) => rows.filter((r: any) => r.persona === p.persona).every((r: any) => r.release_id === p.fixture.release_id)), completed_threads: rows.filter((r: any) => r.session === 4).reduce((n: number, r: any) => n + r.audit.completed_threads, 0), restart_matches: rows.filter((r: any) => r.restart.hash_matches).length, probes_passed: rows.flatMap((r: any) => r.probes).filter((p: any) => p.passed).length, probes: rows.flatMap((r: any) => r.probes).length, boredom: avg('boredom_1_to_5'), play_interest: avg('play_interest_1_to_5'), agency: avg('agency_1_to_5'), causality: avg('causal_consistency_1_to_5') }; });
    report.finished_at = new Date().toISOString();
    report.total_reported_cost = report.calls.reduce((a: number, c: any) => a + (Number(c.usage?.cost) || 0), 0);
    save();
    copyFileSync(join(dir, 'result.json'), 'docs/campaign-v2-results.json');
    console.log(JSON.stringify({ run_id: runId, summary: report.summary, calls: report.calls.length, cost: report.total_reported_cost, errors: report.errors }, null, 2));
}
catch (e) {
    report.errors.push({ fatal: String(e) });
    save();
    throw e;
}
