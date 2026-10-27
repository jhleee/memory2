import { Memory } from '../src/memory.js';
import { RpgCore } from '../src/rpg/core.js';
import { seedSample } from '../src/rpg/sample.js';
const memory = new Memory(process.env.RPG_DB ?? 'rpg.db');
const core = new RpgCore(memory);
if (!process.argv.includes('--migrate'))
    console.log(JSON.stringify(await seedSample(core, core.user('local-development', process.env.RPG_LOCAL_USER ?? 'developer')), null, 2));
memory.close();
