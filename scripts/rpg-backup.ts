import { WorldTime } from '../src/rpg/time.js';
import { GMNotes } from '../src/rpg/gm-notes.js';
import { Memory } from '../src/memory.js';
import { RpgCore } from '../src/rpg/core.js';
const [mode, path] = process.argv.slice(2);
if (!['backup', 'verify'].includes(mode) || !path)
    throw new Error('Usage: rpg-backup.ts backup DESTINATION | verify DATABASE');
const memory = new Memory(mode === 'verify' ? path : process.env.RPG_DB ?? 'rpg.db');
const core = new RpgCore(memory);
try {
    if (mode === 'backup') {
        await memory.db.backup(path);
        console.log(JSON.stringify({ backup: path }));
    }
    else {
        const integrity = memory.db.pragma('integrity_check');
        const foreign = memory.db.pragma('foreign_key_check') as unknown[];
        if (JSON.stringify(integrity) !== '[{"integrity_check":"ok"}]' || foreign.length)
            throw new Error('Database integrity check failed');
        const games = core.rows('SELECT id,owner_user_id FROM games').map(g => ({ game_id: g.id, ...core.verify(g.owner_user_id, g.id), gm_notes: new GMNotes(core.db).verify(g.id), world_time: new WorldTime(core.db).verify(g.id) }));
        console.log(JSON.stringify({ integrity: 'ok', foreign_keys: 'ok', games }, null, 2));
    }
}
finally {
    memory.close();
}
