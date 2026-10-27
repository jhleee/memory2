import { z } from 'zod';
import { seconds, publicTime, timeCosts, activityInput, timeIncident } from './time-contracts.js';
import { gmNoteOperation } from './gm-notes-contracts.js';
import { campaignStateSchema, expansionSchema } from './campaign-contracts.js';
import { createHash, randomUUID } from 'node:crypto';
export class RpgError extends Error {
    constructor(public code: string, message: string) { super(message); }
}
export function requireThat(ok: unknown, code = 'VALIDATION_ERROR', message = '입력 또는 게임 상태가 유효하지 않습니다.'): asserts ok {
    if (!ok)
        throw new RpgError(code, message);
}
export const id = (prefix: string) => `${prefix}_${randomUUID()}`;
export const now = () => new Date().toISOString();
export function canonical(v: unknown): string {
    if (v === null)
        return 'null';
    if (typeof v === 'number') {
        requireThat(Number.isFinite(v));
        return JSON.stringify(v);
    }
    if (typeof v === 'string' || typeof v === 'boolean')
        return JSON.stringify(v);
    if (Array.isArray(v))
        return `[${v.map(canonical).join(',')}]`;
    requireThat(v && typeof v === 'object');
    return `{${Object.keys(v).sort((a, b) => {
        const x = Array.from(a, c => c.codePointAt(0)!);
        const y = Array.from(b, c => c.codePointAt(0)!);
        for (let i = 0; i < Math.min(x.length, y.length); i++)
            if (x[i] !== y[i])
                return x[i] - y[i];
        return x.length - y.length;
    }).map(k => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(',')}}`;
}
export const hash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
const s = z.string().trim().min(1).max(200);
const rev = z.number().int().nonnegative();
const obj = z.record(z.string(), z.unknown());
export const actionSchema = z.object({ type: z.enum(['move', 'inspect', 'speak', 'attack', 'use_item', 'skill_check', 'choose', 'activity']), time_quote_id:s.optional(), actor_id: s, target_id: s.optional(), params: obj.optional() }).strict();
const op = z.discriminatedUnion('op', [
    z.object({ op: z.literal('upsert_schema'), type_name: s, schema: obj }).strict(),
    z.object({ op: z.literal('upsert_entity'), id: s, type_name: s, data: obj }).strict(),
    z.object({ op: z.literal('delete_entity'), id: s }).strict(),
    z.object({ op: z.literal('set_gm_policy'), policy: obj }).strict(),
    z.object({ op: z.literal('set_start_config'), config: obj }).strict(),
]);
const page = { page_size: z.number().int().min(1).max(100).default(20), cursor: rev.default(0) };
export const contracts = {
    rpg_game_time_get: z.object({game_id:s}).strict(),
    rpg_game_time_configure: z.object({game_id:s,expected_revision:rev,idempotency_key:s,initial_seconds:seconds.default(0),action_seconds:timeCosts.prefault({})}).strict(),
    rpg_game_time_plan: z.object({game_id:s,expected_time_revision:rev,idempotency_key:s,activity:activityInput}).strict(),
    rpg_game_time_schedule: z.object({game_id:s,expected_time_revision:rev,idempotency_key:s,incident:timeIncident}).strict(),
    rpg_game_time_reveal: z.object({game_id:s,expected_revision:rev,idempotency_key:s,facts:z.array(z.object({subject_id:s,predicate:s}).strict()).min(1).max(20),reason:z.string().trim().min(1).max(2000)}).strict(),
    rpg_game_gm_notes: z.object({game_id:s,status:z.enum(['open','snoozed','resolved','dropped']).optional(),query:z.string().max(200).default(''),...page}).strict(),
    rpg_game_gm_note_write: z.object({game_id:s,expected_notes_revision:rev,idempotency_key:s,operation:gmNoteOperation}).strict(),
    rpg_game_gm_review: z.object({game_id:s,expected_notes_revision:rev,idempotency_key:s,focus_entity_ids:z.array(s).max(20).default([])}).strict(),
    rpg_game_propose_expansion: z.object({ game_id: s, expected_revision: rev, idempotency_key: s, proposal: expansionSchema }).strict(),
    rpg_game_review_expansion: z.object({ game_id: s, proposal_id: s }).strict(),
    rpg_game_commit_expansion: z.object({ game_id: s, proposal_id: s, expected_revision: rev, idempotency_key: s, acknowledge_semantic_limits: z.literal(true) }).strict(),
    rpg_game_entities: z.object({ game_id: s, query: z.string().max(200).default('') }).strict(),
    rpg_game_get_events: z.object({ game_id: s }).strict(),
    rpg_world_list: z.object(page).strict(), rpg_world_get: z.object({ world_id: s }).strict(),
    rpg_world_create: z.object({ name: s, idempotency_key: s }).strict(),
    rpg_world_edit: z.object({ world_id: s, expected_revision: rev, operations: z.array(op).min(1).max(50), idempotency_key: s }).strict(),
    rpg_world_publish: z.object({ world_id: s, version: z.string().regex(/^\d+\.\d+\.\d+$/), expected_revision: rev, idempotency_key: s }).strict(),
    rpg_game_list: z.object(page).strict(), rpg_game_start: z.object({ release_id: s, idempotency_key: s }).strict(),
    rpg_game_get_context: z.object({ game_id: s, max_chars: z.number().int().min(1).max(100000).default(16000) }).strict(),
    rpg_game_act: z.object({ game_id: s, action: actionSchema, expected_revision: rev, idempotency_key: s }).strict(),
    rpg_game_recall: z.object({ game_id: s, query: z.string().max(4000), entity_ids: z.array(s).max(50).optional(), strategy: z.enum(['lexical', 'hybrid', 'decision', 'causal']).default('lexical'), max_depth: z.number().int().min(1).max(12).default(4), max_chars: z.number().int().min(1).max(64000).default(8000) }).strict(),
    rpg_game_turn_commit: z.object({ game_id: s, turn_seq: rev, narration: z.string().min(1).max(32000), client_message_id: s, confirmed_event_id: s.optional() }).strict(),
    rpg_game_timeline: z.object({ game_id: s, ...page }).strict(),
};
export type ToolName = keyof typeof contracts;
export const characterSchema = z.object({ hp: rev, max_hp: z.number().int().positive(), position_id: s, inventory: z.array(z.object({ item_id: s, quantity: rev }).strict()), conditions: z.array(s), attack_bonus: z.number().int().default(0), damage_bonus: z.number().int().default(0), defense: rev.default(0) }).strict().refine(c => c.hp <= c.max_hp);
export const stateSchema = z.object({ scene_id: s, world_tick: rev, characters: z.record(z.string(), characterSchema), flags: obj, combat: z.null(), campaign: campaignStateSchema.optional(), time:publicTime.optional() }).strict();
export const startSchema = z.object({ state: stateSchema, player_character_id: s, adjacency: z.record(z.string(), z.array(s)), weapons: z.record(z.string(), z.object({ damage_bonus: z.number().int().min(0).max(20) }).strict()), healing_items: z.array(s), skill_checks: z.record(z.string(), z.object({ dc: z.number().int().min(1).max(40), bonus: z.number().int().min(-20).max(20) }).strict()).default({}) }).strict();
export type State = z.infer<typeof stateSchema>;
export type Action = z.infer<typeof actionSchema>;
