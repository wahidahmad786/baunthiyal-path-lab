import { build } from 'esbuild';
import { mkdirSync,copyFileSync } from 'node:fs';
mkdirSync('dist/server',{recursive:true});mkdirSync('dist/.openai',{recursive:true});
copyFileSync('.openai/hosting.json','dist/.openai/hosting.json');
await build({entryPoints:['worker/index.ts'],bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,outfile:'dist/server/index.js'});
console.log('Signed callback Worker built.');
