import { Memory } from '../src/memory.js';
import { RpgCore } from '../src/rpg/core.js';
import { seedSample } from '../src/rpg/sample.js';
import { performance } from 'node:perf_hooks';
import { cpus, totalmem } from 'node:os';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'rpg-bench-'));
const memory = new Memory(join(dir, 'bench.db'));
const core = new RpgCore(memory);
const user = core.user('benchmark', 'offline');
const f = await seedSample(core, user);
const action: number[] = [], context: number[] = [];
try {
    for (let i = 0; i < 103; i++) {
        let t = performance.now();
        await core.call('rpg_game_act', user, { game_id: f.game_id, expected_revision: i, idempotency_key: `bench-${i}`, action: { type: 'inspect', actor_id: f.hero, target_id: f.location_a } });
        const a = performance.now() - t;
        t = performance.now();
        await core.call('rpg_game_get_context', user, { game_id: f.game_id });
        if (i >= 3) {
            action.push(a);
            context.push(performance.now() - t);
        }
    }
    const stats = (xs: number[]) => { xs.sort((a, b) => a - b); return { samples: xs.length, p50_ms: xs[Math.ceil(xs.length * .5) - 1], p95_ms: xs[Math.ceil(xs.length * .95) - 1] }; };
    const report = { date: new Date().toISOString(), runtime: process.version, cpu: cpus()[0]?.model, cpu_count: cpus().length, memory_bytes: totalmem(), processes: 1, storage: 'temporary SQLite WAL file', fixture: 'RULE-SAMPLE-01, CSPRNG not used by inspect', condition: 'warm, 3 excluded warm-up iterations, sequential direct Core API calls', network: false, action: stats(action), context: stats(context), recovery: core.verify(user, f.game_id) };
    writeFileSync('docs/benchmark-local.json', JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
}
finally {
    memory.close();
    rmSync(dir, { recursive: true, force: true });
}
