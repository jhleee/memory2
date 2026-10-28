import { z } from 'zod';
const key=z.string().min(1).max(180).refine(s=>/^[\p{L}\p{N}][\p{L}\p{N}_.:-]*$/u.test(s)).refine(s=>!['__proto__','constructor','prototype'].includes(s));
export const seconds=z.number().int().safe().nonnegative();
const scalar=z.union([z.string().max(2000),z.number().finite(),z.boolean(),z.null()]);
export const privateFact=z.object({subject_id:key,predicate:key,value:scalar}).strict();
export const privateSet=privateFact.extend({expected:scalar.optional()}).strict();
export const timeCondition=z.discriminatedUnion('type',[
 z.object({type:z.literal('truth'),subject_id:key,predicate:key,value:scalar}).strict(),
 z.object({type:z.literal('flag'),key,value:scalar}).strict()
]);
export const timeIncident=z.object({id:key,title:z.string().trim().min(1).max(160),
 truths:z.array(privateFact).min(1).max(20),
 transitions:z.array(z.object({id:key,at_seconds:seconds,conditions:z.array(timeCondition).max(12).default([]),effects:z.array(privateSet).min(1).max(20)}).strict()).min(1).max(16),
 resolutions:z.array(z.object({story_event_id:key,choice_id:key,conditions:z.array(timeCondition).max(12).default([]),effects:z.array(privateSet).min(1).max(20),cancel_remaining:z.boolean().default(true)}).strict()).max(12).default([])
}).strict();
export const timeCosts=z.object({move:seconds.max(31536000).default(60),attack:seconds.max(3600).default(6),use_item:seconds.max(3600).default(6),skill_check:seconds.max(31536000).default(30),inspect:z.literal(0).default(0),choose:seconds.max(31536000).default(0)}).strict();
export const activityInput=z.object({actor_id:key,kind:z.enum(['conversation','search','travel','work','rest','wait','decision']),label:z.string().trim().min(1).max(200),duration_seconds:seconds.min(1).max(31536000),target_ids:z.array(key).max(20).default([]),story_event_id:key.optional(),choice_id:key.optional(),max_actions:z.number().int().min(1).max(10000).default(1000)}).strict();
export const publicTime=z.object({seconds,unit:z.literal('seconds')}).strict();
export type Scalar=z.infer<typeof scalar>;
export type TimeIncident=z.infer<typeof timeIncident>;
export type Truth=z.infer<typeof privateFact>;
export type Activity=z.infer<typeof activityInput>&{id:string;location_id:string;uses:number;issued_at_seconds:number;closed:boolean};
export interface Timeline {
 seconds:number;active_quote_id:string|null;costs:z.infer<typeof timeCosts>;activities:Activity[];
 decision_requirements:Array<{actor_id:string;story_event_id:string;choice_id?:string}>;
 travel_requirements:Array<{actor_id:string;from_id:string;to_id:string}>;
 incidents:Array<TimeIncident&{source_id:string;resolved:boolean;truth_values:Truth[];processed:Array<{id:string;at_seconds:number;status:'fired'|'skipped'|'cancelled';source_id:string}>}>;
}
