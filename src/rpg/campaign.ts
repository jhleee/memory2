import { canonical, hash, requireThat, type State } from './contracts.js';
import { expansionSchema, type Expansion, type Campaign, type CampaignEntity, type Condition, type Effect, type StoryEvent } from './campaign-contracts.js';
export const emptyCampaign = (): Campaign => ({ version: 1, entities: {}, facts: [], relations: [], threads: {}, events: {}, routes: {}, uses: {}, history: [] });
const norm = (s: string) => s.normalize('NFKC').toLowerCase().trim();
const spatial = new Set(['region', 'location', 'city', 'dungeon']);
const people = new Set(['person', 'npc', 'monster']);
const identityKind = (kind: string) => ['person', 'npc'].includes(kind) ? 'person' : kind;
const dynamicPredicates = new Set(['hp', 'max_hp', 'position_id', 'inventory', 'alive', 'life_state', 'conditions', 'source_event_id']);
export function canonicalEntities(state: State, manifest: any): Record<string, CampaignEntity & {
    source_event_id: string;
}> {
    const out: Record<string, any> = {};
    for (const e of manifest.entities) {
        const kind = state.characters[e.id] ? 'npc' : e.id in manifest.start_config.adjacency ? 'location' : manifest.start_config.healing_items.includes(e.id) || e.id in manifest.start_config.weapons ? 'item' : 'group';
        out[e.id] = { id: e.id, kind, name: e.data.name ?? e.id, aliases: [], description: 'Release entity', connections: [], affiliations: [], hp: state.characters[e.id]?.max_hp ?? 10, source_event_id: `release:${manifest.world.id}` };
    }
    out[manifest.world.id] = { id: manifest.world.id, kind: 'world', name: manifest.world.name, aliases: [], description: 'Pinned world', connections: [], affiliations: [], hp: 10, source_event_id: `release:${manifest.world.id}` };
    for (const [eid, ch] of Object.entries(state.characters))
        if (out[eid])
            Object.assign(out[eid], { position_id: ch.position_id, hp: ch.hp, max_hp: ch.max_hp, life_state: ch.hp > 0 ? 'alive' : 'dead' });
    for (const [eid, e] of Object.entries(state.campaign?.entities ?? {}))
        out[eid] = { ...e, ...(state.characters[eid] ? { position_id: state.characters[eid].position_id, hp: state.characters[eid].hp, max_hp: state.characters[eid].max_hp, life_state: state.characters[eid].hp > 0 ? 'alive' : 'dead' } : {}) };
    return out;
}
export function effectiveConfig(state: State, base: any) {
    const config = structuredClone(base);
    for (const [eid, e] of Object.entries(state.campaign?.entities ?? {})) {
        if (spatial.has(e.kind))
            config.adjacency[eid] ??= [];
    }
    for (const [from, tos] of Object.entries(state.campaign?.routes ?? {}))
        config.adjacency[from] = [...new Set([...(config.adjacency[from] ?? []), ...tos])];
    return config;
}
function activeFact(c: Campaign, subject: string, predicate: string) { return [...c.facts].reverse().find(f => f.subject_id === subject && f.predicate === predicate && f.status === 'confirmed' && f.valid_to === null); }
function relation(c: Campaign, from: string, to: string, kind: string) { return c.relations.find(r => r.from_id === from && r.to_id === to && r.kind === kind); }
export function conditionMet(state: State, c: Condition): boolean { const overlay = state.campaign ?? emptyCampaign(); switch (c.type) {
    case 'flag': return canonical(state.flags[c.key] ?? null) === canonical(c.value);
    case 'item': return (state.characters[c.character_id]?.inventory.find(i => i.item_id === c.item_id)?.quantity ?? 0) >= c.minimum;
    case 'hp': return !!state.characters[c.character_id] && state.characters[c.character_id].hp <= c.maximum;
    case 'position': return state.characters[c.character_id]?.position_id === c.location_id;
    case 'fact': return canonical(activeFact(overlay, c.subject_id, c.predicate)?.value ?? null) === canonical(c.value) && !!activeFact(overlay, c.subject_id, c.predicate);
    case 'relation': return (relation(overlay, c.from_id, c.to_id, c.kind)?.value ?? 0) >= c.minimum;
    case 'event_resolved': return (overlay.uses[c.event_id]?.count ?? 0) > 0;
} }
function checkReferences(input: Expansion, entities: Record<string, any>, campaign: Campaign) {
    const ref = (eid: string) => requireThat(Object.hasOwn(entities, eid), 'CANON_CONFLICT', `참조 대상이 없습니다: ${eid}`);
    const location = (eid: string) => { ref(eid); requireThat(spatial.has(entities[eid].kind), 'CANON_CONFLICT', '장소 참조 타입이 맞지 않습니다.'); };
    const char = (eid: string) => { ref(eid); requireThat(people.has(entities[eid].kind), 'CANON_CONFLICT', '캐릭터 참조 타입이 맞지 않습니다.'); };
    const threadIds = new Set([...Object.keys(campaign.threads), ...input.threads.map(t => t.id)]);
    const eventIds = new Set([...Object.keys(campaign.events), ...input.events.map(e => e.id)]);
    for (const e of input.entities) {
        requireThat(e.kind !== 'world', 'CANON_CONFLICT', 'World 자체는 생성할 수 없습니다.');
        if (e.parent_id)
            location(e.parent_id);
        if (people.has(e.kind)) {
            requireThat(e.position_id, 'CANON_CONFLICT', '새 인물·몬스터는 위치가 필요합니다.');
            location(e.position_id);
        }
        else
            requireThat(!e.position_id, 'CANON_CONFLICT', '비캐릭터의 position_id는 허용하지 않습니다.');
        for (const to of e.connections) {
            requireThat(spatial.has(e.kind), 'CANON_CONFLICT');
            location(to);
            requireThat(to !== e.id, 'CANON_CONFLICT');
        }
        for (const group of e.affiliations) {
            ref(group);
            requireThat(['religion', 'group', 'faction'].includes(entities[group].kind), 'CANON_CONFLICT', '소속 타입이 맞지 않습니다.');
        }
        if (spatial.has(e.kind))
            requireThat(e.parent_id || e.connections.length, 'CANON_CONFLICT', '새 장소는 기존 지리와 연결되어야 합니다.');
    }
    for (const f of input.facts) {
        ref(f.subject_id);
        if (f.perspective_id)
            ref(f.perspective_id);
        requireThat(!dynamicPredicates.has(norm(f.predicate)), 'CANON_CONFLICT', '운영 상태는 설정 문장으로 변경할 수 없습니다.');
        requireThat(f.status !== 'unknown' || f.value === null, 'CANON_CONFLICT', '미정 값은 null이어야 합니다.');
        requireThat(!['belief', 'rumor'].includes(f.status) || !!f.perspective_id, 'CANON_CONFLICT', '믿음과 소문에는 관점의 주체가 필요합니다.');
        requireThat(f.status !== 'confirmed' || !f.perspective_id, 'CANON_CONFLICT', '확정 사실은 관점과 구별합니다.');
    }
    for (const r of input.relations) {
        ref(r.from_id);
        ref(r.to_id);
        if (['member_of', 'worships'].includes(r.kind))
            requireThat(['religion', 'group', 'faction'].includes(entities[r.to_id].kind), 'CANON_CONFLICT', '관계 대상 타입이 맞지 않습니다.');
    }
    for (const t of input.threads)
        for (const eid of t.entity_ids)
            ref(eid);
    function condition(c: Condition) { switch (c.type) {
        case 'flag': break;
        case 'item':
            char(c.character_id);
            ref(c.item_id);
            requireThat(entities[c.item_id].kind === 'item', 'CANON_CONFLICT');
            break;
        case 'hp':
            char(c.character_id);
            break;
        case 'position':
            char(c.character_id);
            location(c.location_id);
            break;
        case 'fact':
            ref(c.subject_id);
            requireThat(!dynamicPredicates.has(norm(c.predicate)), 'CANON_CONFLICT');
            break;
        case 'relation':
            ref(c.from_id);
            ref(c.to_id);
            break;
        case 'event_resolved': requireThat(eventIds.has(c.event_id), 'CANON_CONFLICT', '선행 사건이 없습니다.');
    } }
    function effect(e: Effect) { switch (e.type) {
        case 'flag': break;
        case 'item':
            char(e.character_id);
            ref(e.item_id);
            requireThat(entities[e.item_id].kind === 'item', 'CANON_CONFLICT');
            break;
        case 'hp':
            char(e.character_id);
            break;
        case 'relation':
            ref(e.from_id);
            ref(e.to_id);
            break;
        case 'thread':
            requireThat(threadIds.has(e.thread_id), 'CANON_CONFLICT', '이야기 줄기가 없습니다.');
            break;
        case 'fact':
            ref(e.subject_id);
            requireThat(!dynamicPredicates.has(norm(e.predicate)), 'CANON_CONFLICT');
            break;
        case 'route':
            location(e.from_id);
            location(e.to_id);
            requireThat(e.from_id !== e.to_id, 'CANON_CONFLICT');
    } }
    for (const event of input.events) {
        requireThat(threadIds.has(event.thread_id), 'CANON_CONFLICT');
        if (event.parent_event_id)
            requireThat(eventIds.has(event.parent_event_id) && event.parent_event_id !== event.id, 'CANON_CONFLICT');
        event.conditions.forEach(condition);
        const choiceIds = new Set<string>();
        for (const choice of event.choices) {
            requireThat(!choiceIds.has(choice.id), 'CANON_CONFLICT', '선택 ID가 중복됩니다.');
            choiceIds.add(choice.id);
            choice.conditions.forEach(condition);
            requireThat(!choice.conditions.some(c => c.type === 'event_resolved' && c.event_id === event.id), 'CANON_CONFLICT', '자기 자신을 선행 조건으로 사용할 수 없습니다.');
            choice.effects.forEach(effect);
        }
        const signatures = event.choices.map(ch => ch.effects.map(canonical).sort().join('|'));
        requireThat(new Set(signatures).size === signatures.length, 'CANON_CONFLICT', '선택지에는 서로 다른 상태 효과가 필요합니다.');
    }
    const reachable = new Set(Object.keys(entities).filter(eid => spatial.has(entities[eid].kind) && !input.entities.some(e => e.id === eid)));
    let changed = true;
    while (changed) {
        changed = false;
        for (const e of Object.values(entities)) {
            if (!spatial.has(e.kind) || reachable.has(e.id))
                continue;
            const neighbors = [...(e.connections ?? []), ...(e.parent_id ? [e.parent_id] : [])];
            const reverse = Object.values(entities).some(other => reachable.has(other.id) && [...(other.connections ?? []), ...(other.parent_id ? [other.parent_id] : [])].includes(e.id));
            if (neighbors.some(id => reachable.has(id)) || reverse) {
                reachable.add(e.id);
                changed = true;
            }
        }
    }
    for (const e of input.entities)
        if (spatial.has(e.kind))
            requireThat(reachable.has(e.id), 'CANON_CONFLICT', '새 지리 묶음은 기존 세계에 연결되어야 합니다.');
    const parents = new Map(Object.values(entities).filter(e => e.parent_id).map(e => [e.id, e.parent_id as string]));
    for (const e of input.entities) {
        let p: string | undefined = e.id;
        const seen = new Set<string>();
        while (p) {
            requireThat(!seen.has(p), 'CANON_CONFLICT', '지리 포함 관계가 순환합니다.');
            seen.add(p);
            p = parents.get(p);
        }
    }
    const events = { ...campaign.events, ...Object.fromEntries(input.events.map(e => [e.id, e])) };
    for (const e of input.events) {
        const seen = new Set<string>();
        const visit = (eid: string) => { requireThat(!seen.has(eid), 'CANON_CONFLICT', '선행 사건 관계가 순환합니다.'); seen.add(eid); const definition = events[eid]; const dependencies = [...(definition?.parent_event_id ? [definition.parent_event_id] : []), ...(definition?.conditions.filter(c => c.type === 'event_resolved').map(c => c.type === 'event_resolved' ? c.event_id : '') ?? [])]; for (const p of dependencies)
            visit(p); seen.delete(eid); };
        visit(e.id);
    }
}
export function validateExpansion(state: State, manifest: any, raw: unknown) {
    const parsed = expansionSchema.safeParse(raw);
    if (!parsed.success)
        return { valid: false, errors: ['VALIDATION_ERROR: 확장 입력 스키마가 유효하지 않습니다.'], warnings: [], semantic_review: 'not_performed' as const };
    const input = parsed.data;
    try {
        requireThat(input.entities.length + input.facts.length + input.relations.length + input.threads.length + input.events.length > 0, 'VALIDATION_ERROR');
        const c = state.campaign ?? emptyCampaign();
        requireThat(Object.keys(c.entities).length + input.entities.length <= 200 && Object.keys(c.events).length + input.events.length <= 200 && c.facts.length + input.facts.length <= 2000 && Object.keys(c.threads).length + input.threads.length <= 200 && c.relations.length + input.relations.length + input.entities.reduce((n, e) => n + e.affiliations.length, 0) <= 2000, 'RESOURCE_LIMIT', '캠페인 확장 예산을 초과했습니다.');
        const entities = canonicalEntities(state, manifest);
        const names = new Map<string, string>();
        for (const e of Object.values(entities))
            for (const n of [e.name, ...e.aliases])
                names.set(`${identityKind(e.kind)}:${norm(n)}`, e.id);
        for (const e of input.entities) {
            requireThat(!Object.hasOwn(entities, e.id), 'CANON_CONFLICT', '기존 ID를 덮어쓰거나 사망 인물을 다시 생성할 수 없습니다.');
            for (const n of [e.name, ...e.aliases]) {
                const k = `${identityKind(e.kind)}:${norm(n)}`;
                requireThat(!names.has(k), 'CANON_CONFLICT', `동일 타입의 이름·별명 후보가 이미 있습니다: ${n}`);
                names.set(k, e.id);
            }
            entities[e.id] = { ...e, source_event_id: 'pending-validation' };
        }
        for (const t of input.threads)
            requireThat(!c.threads[t.id], 'CANON_CONFLICT', '이야기 줄기 ID가 중복됩니다.');
        requireThat(new Set(input.threads.map(t => t.id)).size === input.threads.length, 'CANON_CONFLICT');
        for (const e of input.events)
            requireThat(!c.events[e.id], 'CANON_CONFLICT', '사건 ID가 중복됩니다.');
        requireThat(new Set(input.events.map(e => e.id)).size === input.events.length, 'CANON_CONFLICT');
        checkReferences(input, entities, c);
        const facts = [...c.facts.filter(f => f.valid_to === null), ...input.facts];
        const confirmed = new Map<string, string>();
        for (const f of facts) {
            if (f.status !== 'confirmed')
                continue;
            const k = canonical([f.subject_id, f.predicate]);
            const v = canonical(f.value);
            requireThat(!confirmed.has(k) || confirmed.get(k) === v, 'CANON_CONFLICT', '기존 확정 사실과 충돌합니다.');
            confirmed.set(k, v);
        }
        for (const e of input.entities) {
            let at: string | undefined = e.parent_id;
            const seen = new Set<string>();
            while (at && !seen.has(at)) {
                seen.add(at);
                if (e.kind === 'city')
                    requireThat(confirmed.get(canonical([at, 'settlements'])) !== canonical('forbidden'), 'CANON_CONFLICT', '정착 금지 지역에 도시를 생성할 수 없습니다.');
                at = entities[at]?.parent_id;
            }
        }
        const rs = [...c.relations, ...input.relations];
        for (const r of input.relations) {
            const existing = rs.filter(x => x.from_id === r.from_id && x.to_id === r.to_id);
            requireThat(!existing.some(x => (r.kind === 'ally_of' && x.kind === 'enemy_of') || (r.kind === 'enemy_of' && x.kind === 'ally_of')), 'CANON_CONFLICT', '같은 관점의 적·동맹 관계가 충돌합니다.');
            const old = c.relations.find(x => x.from_id === r.from_id && x.to_id === r.to_id && x.kind === r.kind);
            requireThat(!old || old.value === r.value, 'CANON_CONFLICT', '기존 관계를 제안으로 덮어쓸 수 없습니다.');
        }
        return { valid: true, errors: [], warnings: ['STRUCTURAL_CHECK_ONLY: 자연어의 모든 의미 모순은 자동 판정하지 않습니다. 소유자가 설정과 인과를 검토해야 합니다.'], semantic_review: 'owner_required' as const };
    }
    catch (e) {
        return { valid: false, errors: [e instanceof Error ? e.message : '확장 검증 실패'], warnings: [], semantic_review: 'not_performed' as const };
    }
}
export function applyExpansion(before: State, manifest: any, input: Expansion, eventId: string) {
    const validation = validateExpansion(before, manifest, input);
    requireThat(validation.valid, 'CANON_CONFLICT', validation.errors.join(' '));
    const state = structuredClone(before);
    state.campaign ??= emptyCampaign();
    const c = state.campaign;
    const addRoute = (a: string, b: string) => { c.routes[a] = [...new Set([...(c.routes[a] ?? []), b])]; c.routes[b] = [...new Set([...(c.routes[b] ?? []), a])]; };
    for (const e of input.entities) {
        c.entities[e.id] = { ...e, source_event_id: eventId };
        if (spatial.has(e.kind))
            c.routes[e.id] ??= [];
        if (people.has(e.kind))
            state.characters[e.id] = { hp: e.hp, max_hp: e.hp, position_id: e.position_id!, inventory: [], conditions: [], attack_bonus: 0, damage_bonus: 0, defense: 0 };
        for (const to of e.connections)
            addRoute(e.id, to);
        for (const group of e.affiliations)
            c.relations.push({ from_id: e.id, to_id: group, kind: 'member_of', value: 1, source_event_id: eventId });
    }
    for (const f of input.facts)
        c.facts.push({ ...f, source_event_id: eventId, valid_from: state.time?.seconds ?? state.world_tick, valid_to: null });
    for (const r of input.relations)
        if (!relation(c, r.from_id, r.to_id, r.kind))
            c.relations.push({ ...r, source_event_id: eventId });
    for (const t of input.threads)
        c.threads[t.id] = { ...t, status: 'open', source_event_id: eventId };
    for (const e of input.events)
        c.events[e.id] = { ...e, source_event_id: eventId };
    return state;
}
function applyEffects(state: State, effects: Effect[], source: string) { const c = state.campaign!; for (const e of effects) {
    switch (e.type) {
        case 'flag':
            state.flags[e.key] = e.value;
            break;
        case 'item': {
            const ch = state.characters[e.character_id];
            requireThat(ch, 'RULE_VIOLATION');
            let item = ch.inventory.find(i => i.item_id === e.item_id);
            const quantity = (item?.quantity ?? 0) + e.delta;
            requireThat(quantity >= 0 && quantity <= 1000, 'RULE_VIOLATION', '자원이 부족하거나 재고 상한을 넘습니다.');
            if (item)
                item.quantity = quantity;
            else
                ch.inventory.push({ item_id: e.item_id, quantity });
            break;
        }
        case 'hp': {
            const ch = state.characters[e.character_id];
            requireThat(ch && ch.hp > 0, 'RULE_VIOLATION', '사망 인물은 회복 효과로 부활할 수 없습니다.');
            requireThat(ch.hp + e.delta >= 0, 'RULE_VIOLATION', '생존 비용을 감당할 수 없습니다.');
            ch.hp = Math.min(ch.max_hp, ch.hp + e.delta);
            break;
        }
        case 'relation': {
            let r = relation(c, e.from_id, e.to_id, e.kind);
            if (!r) {
                r = { from_id: e.from_id, to_id: e.to_id, kind: e.kind, value: 0, source_event_id: source };
                c.relations.push(r);
            }
            r.value = Math.max(-100, Math.min(100, r.value + e.delta));
            r.source_event_id = source;
            break;
        }
        case 'thread':
            c.threads[e.thread_id].status = e.status;
            break;
        case 'fact': {
            const old = activeFact(c, e.subject_id, e.predicate);
            if (e.expected !== undefined)
                requireThat(canonical(old?.value ?? null) === canonical(e.expected), 'RULE_VIOLATION', '사실 변경의 전제가 맞지 않습니다.');
            if (old && canonical(old.value) === canonical(e.value))
                break;
            if (old)
                old.valid_to = state.time?.seconds ?? state.world_tick;
            c.facts.push({ subject_id: e.subject_id, predicate: e.predicate, value: e.value, status: 'confirmed', source_event_id: source, valid_from: state.time?.seconds ?? state.world_tick, valid_to: null });
            break;
        }
        case 'route':
            c.routes[e.from_id] = [...new Set([...(c.routes[e.from_id] ?? []), e.to_id])];
            c.routes[e.to_id] = [...new Set([...(c.routes[e.to_id] ?? []), e.from_id])];
            break;
    }
} }
function possibleChoice(state: State, choice: StoryEvent['choices'][number]) { if (!choice.conditions.every(c => conditionMet(state, c)))
    return false; try {
    applyEffects(structuredClone(state), choice.effects, 'preview');
    return true;
}
catch {
    return false;
} }
export function availableEvents(state: State, turn: number) { const c = state.campaign ?? emptyCampaign(); const rows = []; for (const e of Object.values(c.events)) {
    const use = c.uses[e.id];
    if (c.threads[e.thread_id]?.status !== 'open' || (use?.count ?? 0) >= e.max_uses || use && turn - use.last_turn < e.cooldown_turns)
        continue;
    if (e.parent_event_id && !(c.uses[e.parent_event_id]?.count))
        continue;
    if (!e.conditions.every(x => conditionMet(state, x)))
        continue;
    const choices = e.choices.filter(x => possibleChoice(state, x));
    if (!choices.length)
        continue;
    const recent = c.history.slice(-5);
    const repeated = recent.filter(h => h.category === e.category).length;
    rows.push({ ...e, choices, score: e.priority + (e.parent_event_id ? 2 : 0) - repeated * 2, score_basis: { priority: e.priority, causal_followup: e.parent_event_id ? 2 : 0, recent_category_penalty: repeated * 2 } });
} rows.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)); return { events: rows, selected_event_id: rows[0]?.id ?? null, unresolved_threads: Object.values(c.threads).filter(t => t.status === 'open'), warnings: rows.length ? [] : ['NO_ELIGIBLE_EVENTS: 새로운 검증된 사건이나 조건 충족이 필요합니다.'] }; }
export function executeChoice(before: State, manifest: any, eventId: string, choiceId: string, turn: number, source: string) { const state = structuredClone(before); const eligible = availableEvents(state, turn).events.find(e => e.id === eventId); requireThat(eligible, 'RULE_VIOLATION', '사건 조건·횟수·쿨다운을 만족하지 않습니다.'); const choice = eligible.choices.find(c => c.id === choiceId); requireThat(choice, 'RULE_VIOLATION', '허용된 선택지가 아닙니다.'); const c = state.campaign!; state.world_tick++; applyEffects(state, choice.effects, source); const prev = c.uses[eventId]; c.uses[eventId] = { count: (prev?.count ?? 0) + 1, last_turn: turn + 1, choice_id: choiceId }; c.history.push({ event_id: eventId, category: eligible.category, turn: turn + 1, choice_id: choiceId, source_event_id: source }); return { state, outcome: { rule_version: 'CAMPAIGN-1', story_event_id: eventId, choice_id: choiceId, effects: choice.effects, source_event_id: source }, changes: [{ path: '', before, after: state }] }; }
export function enforceCampaignBounds(state: State) { const c = state.campaign; if (!c)
    return; requireThat(Object.keys(c.entities).length <= 200 && Object.keys(c.threads).length <= 200 && Object.keys(c.events).length <= 200 && c.facts.length <= 2000 && c.relations.length <= 2000 && c.history.length <= 600, 'RESOURCE_LIMIT', '캠페인 정사 기록 예산을 초과했습니다.'); }
export function entityCandidates(state: State, manifest: any, query: string) { const q = norm(query); return Object.values(canonicalEntities(state, manifest)).filter(e => [e.name, e.id, ...e.aliases].some(s => norm(s).includes(q))).slice(0, 50); }
