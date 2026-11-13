import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, copyFileSync } from 'node:fs';
import { join, relative, extname, resolve } from 'node:path';
import { build } from 'esbuild';
const root=process.cwd();
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json; charset=utf-8','.txt':'text/plain; charset=utf-8','.ico':'image/x-icon','.woff2':'font/woff2','.png':'image/png','.webp':'image/webp'};
const files={};
function walk(directory){for(const entry of readdirSync(directory)){const path=join(directory,entry);if(statSync(path).isDirectory())walk(path);else{const name='/'+relative(join(root,'out'),path);if(name.startsWith('/downloads/'))continue;files[name]={type:types[extname(path)]||(name==='/api/configuration'?'application/json':'application/octet-stream'),content:readFileSync(path).toString('base64')};}}}
walk(join(root,'out'));
writeFileSync(join(root,'hosting/static-files.generated.ts'),'export const files: Record<string,{type:string;content:string}> = '+JSON.stringify(files)+';\n');
mkdirSync(join(root,'dist/server'),{recursive:true});mkdirSync(join(root,'dist/.openai'),{recursive:true});
copyFileSync(join(root,'.openai/hosting.json'),join(root,'dist/.openai/hosting.json'));
await build({entryPoints:[join(root,'hosting/worker.ts')],bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,outfile:join(root,'dist/server/index.js')});
const bundle=readFileSync(join(root,'dist/server/index.js'),'utf8');
if(!bundle.includes('fetch('))throw new Error('Missing Worker handler');
console.log(`Account host built with ${Object.keys(files).length} static assets and protected Firebase integration API.`);
