import { Memory } from '../src/memory.js';
import { RpgCore } from '../src/rpg/core.js';
import { seedSample } from '../src/rpg/sample.js';
import { campaignChapter } from '../src/rpg/campaign-sample.js';
const memory = new Memory(process.env.RPG_DB ?? 'rpg.db');
const core = new RpgCore(memory);
const user = core.user('local-development', process.env.RPG_LOCAL_USER ?? 'developer');
try {
    const f = await seedSample(core, user);
    const proposal = await core.call('rpg_game_propose_expansion', user, { game_id: f.game_id, expected_revision: 0, idempotency_key: 'demo-proposal', proposal: campaignChapter(f, 1) });
    const committed = await core.call('rpg_game_commit_expansion', user, { game_id: f.game_id, expected_revision: 0, idempotency_key: 'demo-commit', proposal_id: proposal.proposal_id, acknowledge_semantic_limits: true });
    await core.call('rpg_game_act', user, { game_id: f.game_id, expected_revision: committed.revision, idempotency_key: 'demo-move', action: { type: 'move', actor_id: f.hero, target_id: 'chapter1-city' } });
    console.log(JSON.stringify({ ...f, revision: 2, turn_seq: 1, events: await core.call('rpg_game_get_events', user, { game_id: f.game_id }) }, null, 2));
}
finally {
    memory.close();
}
