import { z } from 'zod';
const key = z.string().min(1).max(180).refine(s => /^[\p{L}\p{N}][\p{L}\p{N}_.:-]*$/u.test(s)).refine(s => !['__proto__', 'constructor', 'prototype'].includes(s));
const text = z.string().trim().min(1).max(2000);
const value = z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()]);
export const entityKind = z.enum(['world', 'region', 'location', 'city', 'dungeon', 'person', 'npc', 'monster', 'religion', 'group', 'faction', 'item']);
export const campaignEntitySchema = z.object({ id: key, kind: entityKind, name: z.string().trim().min(1).max(120), aliases: z.array(z.string().trim().min(1).max(120)).max(10).default([]), description: text, parent_id: key.optional(), position_id: key.optional(), connections: z.array(key).max(12).default([]), affiliations: z.array(key).max(12).default([]), hp: z.number().int().min(1).max(1000).default(10) }).strict();
export const factSchema = z.object({ subject_id: key, predicate: key, value, status: z.enum(['confirmed', 'unknown', 'rumor', 'belief']), perspective_id: key.optional() }).strict();
export const relationSchema = z.object({ from_id: key, to_id: key, kind: z.enum(['member_of', 'worships', 'ally_of', 'enemy_of', 'trust', 'hostility', 'influence']), value: z.number().int().min(-100).max(100).default(1) }).strict();
export const conditionSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('flag'), key, value }).strict(),
    z.object({ type: z.literal('item'), character_id: key, item_id: key, minimum: z.number().int().min(0).max(1000) }).strict(),
    z.object({ type: z.literal('hp'), character_id: key, maximum: z.number().int().min(0).max(1000) }).strict(),
    z.object({ type: z.literal('position'), character_id: key, location_id: key }).strict(),
    z.object({ type: z.literal('fact'), subject_id: key, predicate: key, value }).strict(),
    z.object({ type: z.literal('relation'), from_id: key, to_id: key, kind: z.enum(['trust', 'hostility', 'influence']), minimum: z.number().int().min(-100).max(100) }).strict(),
    z.object({ type: z.literal('event_resolved'), event_id: key }).strict(),
]);
export const effectSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('flag'), key, value }).strict(),
    z.object({ type: z.literal('item'), character_id: key, item_id: key, delta: z.number().int().min(-20).max(20).refine(n => n !== 0) }).strict(),
    z.object({ type: z.literal('hp'), character_id: key, delta: z.number().int().min(-20).max(20).refine(n => n !== 0) }).strict(),
    z.object({ type: z.literal('relation'), from_id: key, to_id: key, kind: z.enum(['trust', 'hostility', 'influence']), delta: z.number().int().min(-20).max(20).refine(n => n !== 0) }).strict(),
    z.object({ type: z.literal('thread'), thread_id: key, status: z.enum(['open', 'completed', 'failed']) }).strict(),
    z.object({ type: z.literal('fact'), subject_id: key, predicate: key, expected: value.optional(), value }).strict(),
    z.object({ type: z.literal('route'), from_id: key, to_id: key }).strict(),
]);
export const storyEventSchema = z.object({ id: key, title: z.string().trim().min(1).max(160), description: text, category: z.enum(['discovery', 'opportunity', 'dilemma', 'threat', 'consequence']), thread_id: key, parent_event_id: key.optional(), conditions: z.array(conditionSchema).max(12).default([]), priority: z.number().int().min(0).max(10).default(5), cooldown_turns: z.number().int().min(0).max(50).default(0), max_uses: z.number().int().min(1).max(3).default(1), choices: z.array(z.object({ id: key, label: z.string().trim().min(1).max(200), description: text, conditions: z.array(conditionSchema).max(12).default([]), effects: z.array(effectSchema).min(1).max(12) }).strict()).min(2).max(4) }).strict();
export const expansionSchema = z.object({ title: z.string().trim().min(1).max(160), rationale: text, entities: z.array(campaignEntitySchema).max(20).default([]), facts: z.array(factSchema).max(40).default([]), relations: z.array(relationSchema).max(40).default([]), threads: z.array(z.object({ id: key, title: z.string().trim().min(1).max(160), goal: text, entity_ids: z.array(key).min(1).max(12) }).strict()).max(10).default([]), events: z.array(storyEventSchema).max(20).default([]) }).strict();
export type Expansion = z.infer<typeof expansionSchema>;
export type CampaignEntity = z.infer<typeof campaignEntitySchema>;
export type StoryEvent = z.infer<typeof storyEventSchema>;
export type Condition = z.infer<typeof conditionSchema>;
export type Effect = z.infer<typeof effectSchema>;
export interface Campaign {
    version: 1;
    entities: Record<string, CampaignEntity & {
        source_event_id: string;
    }>;
    facts: Array<z.infer<typeof factSchema> & {
        source_event_id: string;
        valid_from: number;
        valid_to: number | null;
        observed_at_seconds?: number;
    }>;
    relations: Array<z.infer<typeof relationSchema> & {
        source_event_id: string;
    }>;
    threads: Record<string, {
        id: string;
        title: string;
        goal: string;
        entity_ids: string[];
        status: 'open' | 'completed' | 'failed';
        source_event_id: string;
    }>;
    events: Record<string, StoryEvent & {
        source_event_id: string;
    }>;
    routes: Record<string, string[]>;
    uses: Record<string, {
        count: number;
        last_turn: number;
        choice_id: string;
    }>;
    history: Array<{
        event_id: string;
        category: string;
        turn: number;
        choice_id: string;
        source_event_id: string;
    }>;
}
// A revisioned expansion owns canonical creation; client narration remains outside this state.
export const campaignStateSchema = z.object({ version: z.literal(1), entities: z.record(z.string(), campaignEntitySchema.extend({ source_event_id: z.string() })), facts: z.array(factSchema.extend({ source_event_id: z.string(), valid_from: z.number().int().nonnegative(), valid_to: z.number().int().nonnegative().nullable(), observed_at_seconds:z.number().int().safe().nonnegative().optional() })), relations: z.array(relationSchema.extend({ source_event_id: z.string() })), threads: z.record(z.string(), z.object({ id: key, title: text, goal: text, entity_ids: z.array(key), status: z.enum(['open', 'completed', 'failed']), source_event_id: z.string() })), events: z.record(z.string(), storyEventSchema.extend({ source_event_id: z.string() })), routes: z.record(z.string(), z.array(key)), uses: z.record(z.string(), z.object({ count: z.number().int().nonnegative(), last_turn: z.number().int().nonnegative(), choice_id: key })), history: z.array(z.object({ event_id: key, category: z.string(), turn: z.number().int().nonnegative(), choice_id: key, source_event_id: z.string() })) }).strict();
