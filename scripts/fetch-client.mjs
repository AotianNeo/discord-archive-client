#!/usr/bin/env node
// Downloads the current Discord web client build into <out>/assets and writes <out>/official-shell.html.
// The repository does not ship Discord's client code; run this before building the Pages project.
//
//   node scripts/fetch-client.mjs --out pages/public [--html saved-app.html] [--concurrency 12]
//
// What it does:
//   1. takes https://discord.com/app (or a saved copy) and keeps its script/style tags,
//   2. downloads every /assets/ file the page references, then crawls the downloaded JS/CSS for more:
//      lazy chunks (the bundler's chunk-id → hash maps), worker runtimes (importScripts maps), wasm, fonts, images,
//   3. mirrors the animations the client fetch()es from cdn.discordapp.com/assets/content (no CORS for other origins),
//   4. pins assets/version.*.json to the downloaded build, so the client does not reload itself looking for a newer one,
//   5. replaces GLOBAL_ENV so every endpoint points back at this site, and adds pages/shell/inject-*.html.
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, arg, i, all) => {
  if (arg.startsWith('--')) acc.push([arg.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const OUT = path.resolve(args.out || 'pages/public');
const ASSETS = path.join(OUT, 'assets');
const CONCURRENCY = Number(args.concurrency || 12);
const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const SHELL = path.join(ROOT, 'pages', 'shell');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
// Must match VISITOR_USER_ID in pages/src/index.ts: base64(id).archive-session.signature
const VISITOR_TOKEN = `${Buffer.from('100000000000000001').toString('base64')}.archive-session.signature`;

fs.mkdirSync(path.join(ASSETS, 'content'), { recursive: true });

const html = args.html
  ? fs.readFileSync(args.html, 'utf8')
  : await (await fetch('https://discord.com/app', { headers: { 'User-Agent': UA } })).text();
const envMatch = html.match(/window\.GLOBAL_ENV\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/);
if (!envMatch) throw new Error('GLOBAL_ENV not found in the app HTML');
const pick = (key) => envMatch[1].match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`))?.[1] || '';
const build = { BUILD_NUMBER: pick('BUILD_NUMBER'), VERSION_HASH: pick('VERSION_HASH'), BUILT_AT: pick('BUILT_AT'), SENTRY_RELEASE: pick('SENTRY_RELEASE') };
if (!build.VERSION_HASH) throw new Error('VERSION_HASH not found in GLOBAL_ENV');
console.log(`[fetch-client] build ${build.BUILD_NUMBER} (${build.VERSION_HASH})`);

// ---- download + crawl -------------------------------------------------------------------------------------------
const ASSET_EXT = 'js|css|wasm|png|svg|webp|gif|jpe?g|ico|woff2?|ttf|otf|mp3|ogg|wav|mp4|webm|mov|json|lottie|scm';
const queued = new Set();
const failed = [];
const queue = [];
const enqueue = (name) => {
  name = name.replace(/^\/?assets\//, '').split(/[?#]/)[0];
  if (!name || name.startsWith('.') || name.includes('/') || name.includes('..') || queued.has(name)) return;
  queued.add(name);
  queue.push(name);
};
const contentQueue = new Set();

function discover(text) {
  for (const m of text.matchAll(new RegExp(`/assets/([\\w.-]+\\.(?:${ASSET_EXT}))`, 'g'))) enqueue(m[1]);
  // bundler chunk maps: ({12345:"0123456789abcdef",31e4:"…",...})[e]+".js" — keys are minified numbers (31e4 = 310000);
  // the same shape maps CSS chunks ("…".css) and worker runtimes' importScripts chunks
  for (const m of text.matchAll(/\(\{((?:[0-9e]+:"[0-9a-f]{12,20}",?)+)\}\)\[e\]\+"(\.[a-z0-9]+)"/g)) {
    for (const h of m[1].matchAll(/"([0-9a-f]{12,20})"/g)) enqueue(h[1] + m[2]);
  }
  // special-cased chunks: "49747"===e?""+e+".70e7729f6e1562fb.js"
  for (const m of text.matchAll(/"(\d+)"===e\?""\+e\+"(\.[0-9a-f]{12,20}\.(?:js|css))"/g)) enqueue(m[1] + m[2]);
  // literal asset file names: r.p+"5e40a46c14f43b52.wasm", "libdiscore-wasm-fetch.8b2e3eed86992d86.js"
  for (const m of text.matchAll(new RegExp(`"([\\w.-]*[0-9a-f]{12,64}\\.(?:${ASSET_EXT}))"`, 'g'))) enqueue(m[1]);
  // wasm modules loaded through the runtime's async-wasm helper: __webpack_require__.v(exports, id, "<hash>") -> <hash>.module.wasm
  for (const m of text.matchAll(/\.v\(\w+,\w+(?:\.id)?,"([0-9a-f]{12,32})"/g)) enqueue(`${m[1]}.module.wasm`);
  for (const m of text.matchAll(/cdn\.discordapp\.com\/assets\/content\/([0-9a-f]{64}\.(?:riv|lottiejson))/g)) contentQueue.add(m[1]);
}

async function download(url, file) {
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return fs.readFileSync(file);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.status === 404 || res.status === 403) return null;
      if (!res.ok) throw new Error(String(res.status));
      const body = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(file, body);
      return body;
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return null;
}

discover(html);
let done = 0;
async function worker() {
  while (queue.length) {
    const name = queue.shift();
    try {
      const body = await download(`https://discord.com/assets/${name}`, path.join(ASSETS, name));
      if (!body) failed.push(name);
      else if (/\.(js|css)$/.test(name)) discover(body.toString('utf8'));
    } catch (err) {
      failed.push(`${name} (${err.message})`);
    }
    if (++done % 500 === 0) console.log(`[fetch-client] ${done} files, ${queue.length} queued`);
  }
}
// workers exit when the queue is momentarily empty; loop until nothing new was discovered
while (queue.length) await Promise.all(Array.from({ length: CONCURRENCY }, worker));
for (const name of contentQueue) {
  await download(`https://cdn.discordapp.com/assets/content/${name}`, path.join(ASSETS, 'content', name)).catch(() => failed.push(`content/${name}`));
}

// ---- version pin + shell ----------------------------------------------------------------------------------------
for (const channel of ['stable', 'ptb', 'canary', 'staging']) {
  fs.writeFileSync(path.join(ASSETS, `version.${channel}.json`), JSON.stringify({ hash: build.VERSION_HASH, required: false }));
}
const fill = (text) => text.replace(/\{\{(\w+)\}\}/g, (_, key) => key === 'VISITOR_TOKEN' ? VISITOR_TOKEN : (build[key] ?? ''));
// head injections go right after GLOBAL_ENV: the token must be in localStorage before Discord's fast-connect script runs
let shell = html.replace(envMatch[0], () => `${fill(fs.readFileSync(path.join(SHELL, 'global-env.js'), 'utf8'))}\n</script>\n` +
  fill(fs.readFileSync(path.join(SHELL, 'inject-head.html'), 'utf8')));
shell = shell.replace(/<title>[\s\S]*?<\/title>/, '<title>Discord</title>');
shell = shell.replace('</body>', `${fs.readFileSync(path.join(SHELL, 'inject-body.html'), 'utf8')}\n</body>`);
fs.writeFileSync(path.join(OUT, 'official-shell.html'), shell);

console.log(`[fetch-client] ${queued.size - failed.length} files in ${ASSETS}, ${contentQueue.size} animations, ${failed.length} not found`);
if (failed.length) fs.writeFileSync(path.join(OUT, 'fetch-client-missing.txt'), failed.join('\n') + '\n');
console.log(`[fetch-client] wrote ${path.join(OUT, 'official-shell.html')}`);
