export type Lifecycle = 'pending' | 'active' | 'stale' | 'deleted';
export type Resolution = 'unresolved' | 'resolved';
export type Support = 'asserted' | 'supported' | 'disputed';
export type RecordType = 'memory' | 'entity' | 'evidence';
export interface Ref { id: string; type: RecordType }
export interface LinkInput { from: Ref; relation: string; to: Ref; metadata?: Record<string, unknown> }
export interface EvidenceInput { source_type: string; content: string; metadata?: Record<string, unknown> }
export interface EntityInput { id?: string; name: string; metadata?: Record<string, unknown> }
export interface MemoryInput {
  id?: string; kind: string; content: string; data?: Record<string, unknown>;
  occurred_at?: string; valid_from?: string; valid_to?: string;
  lifecycle?: 'pending' | 'active'; resolution?: Resolution; support?: Support;
  entity_ids?: string[];
}
export interface RecordInput {
  space_id: string; evidence: EvidenceInput; memories: MemoryInput[];
  entities?: EntityInput[]; links?: LinkInput[]; idempotency_key?: string;
}
export interface MemoryItem {
  id: string; space_id: string; kind: string; content: string; data: Record<string, unknown>;
  source_id: string; occurred_at: string | null; valid_from: string | null; valid_to: string | null;
  lifecycle: Lifecycle; resolution: Resolution; support: Support; created_at: string; updated_at: string;
}
export interface RecordResult { accepted: true; evidence_id: string; memory_ids: string[]; entity_ids: string[]; missing: Record<string, string[]>; replayed: boolean }
export interface QueryInput {
  space_id: string; query?: string; kind?: string; entity_id?: string;
  candidate_ids?: string[];
  from?: string; to?: string; at?: string; limit?: number; max_chars?: number; recent_since?: string;
}
export interface Trace { memory_id: string; matched_by: string[]; score: number; source_id: string; links: string[]; components: Record<string, number> }
export interface RecallResult {
  items: MemoryItem[]; current: string[]; recent: string[]; related: string[]; unresolved: string[];
  sources: { id: string; source_type: string; content: string; metadata: Record<string, unknown> }[];
  traces: Trace[]; truncated: boolean;
  retrieval?: { requested: RetrievalMode; used: RetrievalMode; warnings: string[]; embedding_model?: string; decision_model?: string };
}
export type RetrievalMode = 'lexical' | 'hybrid' | 'decision';
export interface RuntimeQueryInput extends QueryInput { mode?: RetrievalMode }
export interface IndexResult { queued: number; processed: number; failed: number }
export interface SuggestMentionInput { space_id: string; memory_id: string; entity_ids?: string[] }
export interface SuggestMentionResult { memory_id: string; suggestions: DecisionSuggestion[]; unresolved: true; warnings: string[] }
export interface CorrectInput { space_id: string; memory_id: string; replacement: MemoryInput; evidence: EvidenceInput; expected_updated_at?: string }
export interface ForgetInput { space_id: string; memory_id: string }
export interface TimelineInput { space_id: string; entity_id?: string; from?: string; to?: string; limit?: number; offset?: number; include_stale?: boolean }
export interface TimelineResult { items: (MemoryItem & { time_basis: 'occurred_at' | 'created_at' })[]; next_offset: number | null }
export interface EmbeddingProvider { readonly model: string; readonly dimensions: number; embed(texts: string[]): Promise<number[][]> }
export interface VectorIndex { add(memory_id: string, vector: number[], metadata: { model: string; hash: string }): void; search(vector: number[], input: { space_id: string; model: string; limit: number; filters?: QueryInput }): { memory_id: string; score: number }[]; remove(memory_id: string): void }
export interface DecisionCandidate { id: string; content: string }
export interface DecisionSuggestion { id: string; score: number; reason: string }
export interface DecisionProvider { suggest(question: string, candidates: DecisionCandidate[]): Promise<DecisionSuggestion[]> }
