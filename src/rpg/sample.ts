import { RpgCore } from './core.js';
export async function seedSample(core: RpgCore, user: string) {
    const key = `sample-${Date.now()}-${Math.random()}`;
    const w = await core.call('rpg_world_create', user, { name: '중립 샘플 월드', idempotency_key: key });
    const suffix = w.world_id;
    const hero = `hero-${suffix}`, enemy = `enemy-${suffix}`, a = `a-${suffix}`, b = `b-${suffix}`, sword = `sword-${suffix}`, potion = `potion-${suffix}`;
    const state = { scene_id: a, world_tick: 0, characters: { [hero]: { hp: 12, max_hp: 20, position_id: a, inventory: [{ item_id: sword, quantity: 1 }, { item_id: potion, quantity: 2 }], conditions: [], attack_bonus: 3, damage_bonus: 0, defense: 1 }, [enemy]: { hp: 30, max_hp: 30, position_id: a, inventory: [], conditions: [], attack_bonus: 1, damage_bonus: 0, defense: 2 } }, flags: {}, combat: null };
    const config = { state, player_character_id: hero, adjacency: { [a]: [b], [b]: [a] }, weapons: { [sword]: { damage_bonus: 0 } }, healing_items: [potion], skill_checks: { persuade: { dc: 12, bonus: 2 } } };
    await core.call('rpg_world_edit', user, { world_id: w.world_id, expected_revision: 0, idempotency_key: key + '-edit', operations: [{ op: 'upsert_schema', type_name: 'object', schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false } }, ...[hero, enemy, a, b, sword, potion].map(e => ({ op: 'upsert_entity', id: e, type_name: 'object', data: { name: e } })), { op: 'set_start_config', config }, { op: 'set_gm_policy', policy: { private_notes: 'SECRET_FIXTURE_DO_NOT_EXPOSE' } }] });
    const r = await core.call('rpg_world_publish', user, { world_id: w.world_id, expected_revision: 1, version: '1.0.0', idempotency_key: key + '-publish' });
    const g = await core.call('rpg_game_start', user, { release_id: r.release_id, idempotency_key: key + '-start' });
    return { ...w, ...r, ...g, hero, enemy, location_a: a, location_b: b, sword, potion };
}
