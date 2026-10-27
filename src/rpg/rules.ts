import { randomInt } from 'node:crypto';
import { requireThat, stateSchema, type State, type Action } from './contracts.js';
export function execute(state: State, config: any, action: Action, dice = (s: number) => randomInt(1, s + 1)) {
    const next = structuredClone(state);
    const actor = next.characters[action.actor_id];
    requireThat(actor && actor.hp > 0, 'RULE_VIOLATION', '행동 가능한 캐릭터가 아닙니다.');
    const target = action.target_id ? next.characters[action.target_id] : undefined;
    const p = action.params ?? {};
    let outcome: any = { rule_version: 'RULE-SAMPLE-01' };
    const roll = (s: number) => { const value = dice(s); requireThat(Number.isInteger(value) && value >= 1 && value <= s, 'INTERNAL_ERROR'); return value; };
    switch (action.type) {
        case 'activity': requireThat(!!action.time_quote_id,'RULE_VIOLATION','활동 견적이 필요합니다.'); outcome.activity='completed'; break;
        case 'choose': requireThat(false, 'RULE_VIOLATION', '선택 행동은 캠페인 규칙 실행기를 통해 처리해야 합니다.');
        case 'move':
            requireThat(action.target_id && (config.adjacency[actor.position_id] ?? []).includes(action.target_id), 'RULE_VIOLATION', '인접 장소로만 이동할 수 있습니다.');
            actor.position_id = action.target_id;
            next.scene_id = action.target_id;
            outcome.destination = action.target_id;
            break;
        case 'attack': {
            requireThat(target && target.hp > 0 && target !== actor && target.position_id === actor.position_id, 'RULE_VIOLATION', '공격 대상 또는 사거리가 유효하지 않습니다.');
            const weapon = typeof p.weapon_id === 'string' ? config.weapons[p.weapon_id] : undefined;
            requireThat(weapon && actor.inventory.some(x => x.item_id === p.weapon_id && x.quantity > 0), 'RULE_VIOLATION', '보유한 유효 무기가 필요합니다.');
            const d20 = roll(20), hit = d20 + actor.attack_bonus >= 10 + target.defense;
            const d6 = hit ? roll(6) : 0;
            const damage = hit ? Math.max(0, d6 + actor.damage_bonus + weapon.damage_bonus) : 0;
            target.hp = Math.max(0, target.hp - damage);
            outcome = { ...outcome, d20, attack_bonus: actor.attack_bonus, defense: target.defense, hit, d6, damage };
            break;
        }
        case 'use_item': {
            requireThat(typeof p.item_id === 'string' && config.healing_items.includes(p.item_id), 'RULE_VIOLATION');
            const inv = actor.inventory.find(x => x.item_id === p.item_id);
            const receiver = target ?? (action.target_id ? undefined : actor);
            requireThat(inv && inv.quantity > 0 && receiver && receiver.hp > 0 && receiver.position_id === actor.position_id, 'RULE_VIOLATION');
            inv.quantity--;
            const d4 = roll(4);
            const before = receiver.hp;
            receiver.hp = Math.min(receiver.max_hp, receiver.hp + d4);
            outcome = { ...outcome, d4, healed: receiver.hp - before };
            break;
        }
        case 'skill_check': {
            const check = typeof p.check_id === 'string' ? config.skill_checks[p.check_id] : undefined;
            requireThat(check, 'RULE_VIOLATION', '서버에 등록된 판정만 허용합니다.');
            const d20 = roll(20);
            outcome = { ...outcome, d20, bonus: check.bonus, dc: check.dc, success: d20 + check.bonus >= check.dc };
            break;
        }
        case 'speak':
            requireThat(target && target.hp > 0 && target.position_id === actor.position_id, 'RULE_VIOLATION');
            requireThat(typeof p.message === 'string' && p.message.length <= 2000);
            outcome.intent = p.message;
            break;
        case 'inspect':
            requireThat(action.target_id === actor.position_id || target?.position_id === actor.position_id, 'RULE_VIOLATION');
            outcome.observed = action.target_id;
            break;
    }
    next.world_tick++;
    stateSchema.parse(next);
    return { state: next, outcome, changes: [{ path: '', before: state, after: next }] };
}
