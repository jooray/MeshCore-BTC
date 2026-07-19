import config from './config.json' with { type: 'json' };
import { startBot } from './core/framework.mjs';
import bitcoin from './modules/bitcoin.mjs';
import ai from './modules/ai.mjs';

const modules = [bitcoin, ai].filter(m => config.modules?.[m.name] !== false);

await startBot(config, modules);
