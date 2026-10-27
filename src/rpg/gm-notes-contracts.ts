import { z } from 'zod';
const id = z.string().trim().min(1).max(200);
const turn = z.number().int().nonnegative();
const scalar = z.union([z.string().max(2000),z.number().finite(),z.boolean(),z.null()]);
export const gmNoteInput = z.object({
 kind: z.enum(['foreshadow','promise','todo','consequence']),
 title: z.string().trim().min(1).max(160), body: z.string().trim().min(1).max(2000),
 entity_ids: z.array(id).max(20).default([]), source_event_ids: z.array(id).max(10).default([]),
 labels: z.array(z.string().trim().min(1).max(60)).max(8).default([]), importance: z.number().int().min(0).max(3).default(1),
 not_before_turn: turn.optional(), due_turn: turn.nullable().optional(),
 gate_flag: z.object({key:id,value:scalar}).strict().nullable().optional()
}).strict();
export const gmNoteOperation = z.discriminatedUnion('op',[
 z.object({op:z.literal('create'),note:gmNoteInput}).strict(),
 z.object({op:z.literal('update'),note_id:id,patch:gmNoteInput.partial()}).strict(),
 z.object({op:z.literal('status'),note_id:id,status:z.enum(['open','snoozed','resolved','dropped']),reason:z.string().trim().min(1).max(2000),until_turn:turn.optional(),evidence_event_id:id.optional()}).strict()
]);
export type GMNoteInput = z.infer<typeof gmNoteInput>;
export interface GMNote extends GMNoteInput {
 id:string; status:'open'|'snoozed'|'resolved'|'dropped'; created_turn:number; updated_turn:number;
 not_before_turn:number; snoozed_until:number|null; last_shown_turn:number|null; shown_count:number;
 resolution:{reason:string;event_id:string|null}|null;
}
export interface GMNotebook {notes:GMNote[]; exposures:Array<{note_id:string;kind:GMNote['kind'];turn:number}>; last_review_turn:number|null;}
