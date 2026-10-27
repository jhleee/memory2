import type Database from 'better-sqlite3';
import type { Ref } from './types.js';
export interface TraverseInput {
    space_id: string;
    start: Ref;
    direction: 'outbound' | 'inbound' | 'both';
    relations?: string[];
    max_depth?: number;
    max_nodes?: number;
    max_paths?: number;
    at?: string;
}
export interface GraphEdge {
    from: Ref;
    relation: string;
    to: Ref;
    evidence_ids: string[];
    support: string;
}
export interface GraphPath {
    nodes: Ref[];
    edges: GraphEdge[];
}
export function traverse(db: Database.Database, input: TraverseInput) {
    const depth = input.max_depth ?? 4, maxNodes = input.max_nodes ?? 100, maxPaths = input.max_paths ?? 10;
    if (!Number.isInteger(depth) || depth < 1 || depth > 12 || !Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 500 || !Number.isInteger(maxPaths) || maxPaths < 1 || maxPaths > 100 || !['outbound', 'inbound', 'both'].includes(input.direction))
        throw new TypeError('invalid graph budget or direction');
    if (input.at && Number.isNaN(Date.parse(input.at)))
        throw new TypeError('invalid graph time');
    const exists = (r: Ref) => { if (!['memory', 'entity', 'evidence'].includes(r.type))
        return false; const table = { memory: 'memories', entity: 'entities', evidence: 'evidence' }[r.type]; const row = db.prepare(`SELECT * FROM ${table} WHERE space_id=? AND id=?`).get(input.space_id, r.id) as any; return !!row && (r.type !== 'memory' || row.lifecycle === 'active' && (!input.at || (!row.valid_from || row.valid_from <= input.at) && (!row.valid_to || row.valid_to > input.at))); };
    const key = (r: Ref) => `${r.type}:${r.id}`;
    const paths: GraphPath[] = [];
    const visited = new Set<string>();
    let truncated = false;
    if (!exists(input.start))
        return { paths, visited_count: 0, truncated };
    visited.add(key(input.start));
    const queue: GraphPath[] = [{ nodes: [input.start], edges: [] }];
    let expansions = 0;
    while (queue.length) {
        const path = queue.shift()!;
        const current = path.nodes.at(-1)!;
        const rows = db.prepare('SELECT * FROM links WHERE space_id=? AND active=1 AND ((from_type=? AND from_id=?) OR (to_type=? AND to_id=?)) ORDER BY id LIMIT 1001').all(input.space_id, current.type, current.id, current.type, current.id) as any[];
        if (rows.length > 1000)
            truncated = true;
        for (const row of rows.slice(0, 1000)) {
            if (input.relations && !input.relations.includes(row.relation))
                continue;
            const from: Ref = { type: row.from_type, id: row.from_id }, to: Ref = { type: row.to_type, id: row.to_id };
            const outbound = key(from) === key(current);
            if (input.direction === 'outbound' && !outbound || input.direction === 'inbound' && outbound)
                continue;
            const next = outbound ? to : from;
            if (!exists(next) || path.nodes.some(n => key(n) === key(next)))
                continue;
            if (path.edges.length >= depth) {
                truncated = true;
                continue;
            }
            if (!visited.has(key(next)) && visited.size >= maxNodes) {
                truncated = true;
                continue;
            }
            if (++expansions > 5000) {
                truncated = true;
                queue.length = 0;
                break;
            }
            const metadata = JSON.parse(row.metadata);
            const evidence_ids = Array.isArray(metadata.evidence_ids) ? metadata.evidence_ids.filter((eid: any) => typeof eid === 'string' && exists({ type: 'evidence', id: eid })) : [];
            const edge = { from, relation: row.relation, to, evidence_ids, support: evidence_ids.length ? 'supported' : 'unsupported' };
            const extended = { nodes: [...path.nodes, next], edges: [...path.edges, edge] };
            visited.add(key(next));
            if (paths.length >= maxPaths) {
                truncated = true;
                queue.length = 0;
                break;
            }
            paths.push(extended);
            queue.push(extended);
        }
    }
    return { paths, visited_count: visited.size, truncated };
}
export interface EntityCandidateInput {
    space_id: string;
    mention: string;
    entity_type?: string;
    attributes?: Record<string, unknown>;
    at?: string;
    limit?: number;
}
export function searchEntityCandidates(db: Database.Database, input: EntityCandidateInput) {
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !input.mention.trim())
        throw new TypeError('invalid candidate input');
    const normalize = (s: string) => s.normalize('NFKC').toLowerCase();
    const mention = normalize(input.mention);
    const candidates: any[] = [];
    const rows = db.prepare('SELECT * FROM entities WHERE space_id=? ORDER BY id LIMIT 10001').all(input.space_id) as any[];
    for (const row of rows.slice(0, 10000)) {
        if (input.at && row.created_at > input.at)
            continue;
        const m = JSON.parse(row.metadata);
        if (input.entity_type && m.type !== input.entity_type)
            continue;
        if (input.attributes && Object.entries(input.attributes).some(([k, v]) => JSON.stringify(m[k]) !== JSON.stringify(v)))
            continue;
        const matched_fields: string[] = [];
        if (normalize(row.name).includes(mention))
            matched_fields.push('name');
        if (Array.isArray(m.aliases) && m.aliases.some((a: any) => typeof a === 'string' && normalize(a).includes(mention)))
            matched_fields.push('aliases');
        if (!matched_fields.length)
            continue;
        candidates.push({ entity_id: row.id, matched_fields, evidence_ids: [], score: normalize(row.name) === mention ? 1 : matched_fields.includes('aliases') ? .9 : .6 });
    }
    candidates.sort((a, b) => b.score - a.score || a.entity_id.localeCompare(b.entity_id));
    return { candidates: candidates.slice(0, limit), truncated: candidates.length > limit || rows.length > 10000 };
}
