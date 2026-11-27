// Builds the Cloudflare Pages version (used for card.lascafe.sa) from the same source files.
// Run from this folder:  node build.mjs   then:  npx wrangler@4 pages deploy
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
mkdirSync(here('dist/_worker.js'), { recursive: true });
copyFileSync(here('../worker.js'), here('dist/_worker.js/index.js'));
copyFileSync(here('../wallet-assets.js'), here('dist/_worker.js/wallet-assets.js'));
console.log('built pages/dist');
