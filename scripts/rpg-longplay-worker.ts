import {Memory} from '../src/memory.js';
import {RpgCore} from '../src/rpg/core.js';
import {MemoryRuntime} from '../src/runtime.js';
import {OpenRouterDecisionProvider} from '../src/openrouter.js';
import {createRpgMcp} from '../src/rpg/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {LongplayOpenRouter,LONGPLAY_DECISION} from './lib/longplay-openrouter.js';
const memory=new Memory(process.env.RPG_DB!);
const remote=process.env.OPENROUTER_API_KEY?new LongplayOpenRouter(process.env.OPENROUTER_API_KEY,call=>console.error(JSON.stringify({kind:'remote-call',...call})),3):undefined;
const runtime=remote?new MemoryRuntime(memory,{decision:new OpenRouterDecisionProvider({model:LONGPLAY_DECISION,fetch:remote.fetch,timeoutMs:90000})}):undefined;
const core=new RpgCore(memory,runtime);const user=core.user('longplay-evaluation',process.env.RPG_EVAL_SUBJECT!);
const server=createRpgMcp(core,user);await server.connect(new StdioServerTransport());
console.error(JSON.stringify({kind:'worker-start',pid:process.pid}));
let stopped=false;async function stop(){if(stopped)return;stopped=true;await server.close();memory.close();process.exit(0);}
process.once('SIGINT',stop);process.once('SIGTERM',stop);process.stdin.once('end',stop);
