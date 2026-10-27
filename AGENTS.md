# Repository instructions

## Scope and workflow

- Read README.md and the relevant domain guide before editing. Inspect git status and preserve unrelated work.
- Keep domain rules in src/rpg/, transport in its server/MCP modules, and orchestration in scripts/. Existing memory and CLI modules remain compatible unless the task requires changes.
- Prefer focused feature branches and reviewable commits. Do not push to another repository or rewrite shared history as part of routine maintenance.
- Update documentation and CHANGELOG.md when observable behavior changes. Keep known unresolved issues in docs/known-issues.md accurate.

## State invariants

- A Game pins an immutable Release. Campaign expansion uses validated proposals and explicit owner commit; narration alone is not canonical state.
- Preserve event provenance, evidence, transactional writes, idempotency, revision checks and replay consistency. Do not erase historical facts to make a snapshot appear correct.
- Keep canonical knowledge, perspective-dependent belief, GM-private notes and hidden timed truths distinct. Player-facing reads must respect authorization and observation boundaries.
- turn_seq, world_tick and elapsed seconds have different meanings. Never silently convert dialogue turns to elapsed world time.
- GM note updates use their own revision and attention budgets. Do not make optional reminders mandatory gameplay interruptions.
- Add forward migrations. Do not edit an already released migration to change existing installations. Backups and migration checks must preserve player data.

## Validation

Run npm run repo:check, npm run typecheck and npm test. Add meaningful regression coverage for changed state, authorization, migration or replay behavior. Pure documentation edits need repository checks only. Offline evaluation is the default; live model calls require task authorization and injected credentials. Do not add paid model fallback implicitly.

Never commit .env files, keys, SQLite files, node_modules, dist, raw evaluation run directories or private campaign logs. Use .env.example for variable names only. Historical synthetic evaluation evidence belongs in docs with provenance and explicit limitations.

Write Korean technical documents with concrete scope, status and reproducible commands. Distinguish implemented behavior, observed results and proposals. Storage integrity does not prove narrative consistency; model reviews do not prove human enjoyment. Keep cold-start findings visible until regression evidence resolves them.
