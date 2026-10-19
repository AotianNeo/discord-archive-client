#!/usr/bin/env node
// Packs the client files a cold start needs into a few large files, so a first visit makes ~10 requests instead of ~2,400.
//
//   node scripts/boot-bundle.mjs trace --base https://127.0.0.1:8787 --cdp 9333 --password <pw> [--path /channels/<g>/<c>] [--trace pages/boot-trace.json]
//   node scripts/boot-bundle.mjs build [--public pages/public] [--trace pages/boot-trace.json]
//
// Why: Discord's HTML lists ~350 scripts and ~320 stylesheets, and once those have run the bundler requests ~1,700 more
// chunks on demand. Every file is small, but there are two dependent waves of them and they queue behind each other, so a
// cold start takes ~5 s even on a fast connection (bandwidth is not the limit, the number of round trips is).
//
// trace: opens the site in a fresh browser context (empty cache), signs in, waits until the client is idle, and records
//        every /assets/*.js and *.css it loaded (repeat --path to also open other pages). Results are merged into the trace
//        file, so tracing an already bundled site only adds what is still loaded separately.
// build: writes assets/boot-<hash>.js parts and assets/boot-<hash>.css, and rewrites official-shell.html; the original is
//        kept as official-shell.unbundled.html next to the trace, and later builds start from it (until fetch-client
//        writes a new shell).
//   - page chunks: the page's runtime scripts (web.*.js, fast-connect, sentry, …) keep their own <script> tags, and the
//     chunk files between two of them are packed into parts that stay between them, in the original order. A runtime
//     registers every chunk pushed before it starts, and a module shared by two runtimes can be compiled differently for
//     each, so moving a chunk across a runtime changes which version that runtime starts with;
//   - lazy chunks are shipped as functions that are not called: a hook on the bundler's script loader (r.l) runs the
//     stored function when the client asks for that chunk, in a task of its own like a loaded <script> (running it
//     inside the loader call re-enters the runtime's startup bookkeeping, and registering everything up front changes
//     which module versions the runtimes start with; both stall the client without an error);
//   - each file runs in its own function with try/catch, keeping per-file "use strict" and error isolation;
//   - all CSS goes into one stylesheet, and the same hook marks the bundled CSS chunks as loaded.
// Chunks missing from the trace still load on demand as before, so a stale trace costs speed, not correctness.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [mode, ...rest] = process.argv.slice(2);
const args = {};
const paths = [];
for (let i = 0; i < rest.length; i++) {
  const key = rest[i];
  if (!key.startsWith('--')) continue;
  const value = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : 'true';
  if (key === '--path') paths.push(value);
  else args[key.slice(2)] = value;
}
const TRACE = path.resolve(args.trace || 'pages/boot-trace.json');
const PART_BYTES = 6 * 1024 * 1024; // Pages allows 25 MiB per file; a handful of parts download in parallel
const CHUNK_RE = /^\s*(?:"use strict";\s*)?\(\s*(?:this|self|globalThis)\.(webpackChunk[\w$]+)\s*=/;

if (mode === 'trace') await trace();
else if (mode === 'build') build();
else {
  console.error('usage: boot-bundle.mjs trace --base <url> --cdp <port> --password <pw> [--path <path>]... | build [--public pages/public]');
  process.exit(2);
}

// ---- trace ----------------------------------------------------------------------------------------------------------
async function trace() {
  const BASE = (args.base || 'https://127.0.0.1:8787').replace(/\/$/, '');
  const PORT = args.cdp || '9333';
  const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve) => (ws.onopen = resolve));
  let seq = 0;
  const pending = new Map();
  const seen = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result || {}); pending.delete(msg.id); return; }
    if (msg.method === 'Network.requestWillBeSent') {
      const url = new URL(msg.params.request.url);
      if (url.origin === new URL(BASE).origin && /^\/assets\/[^/]+\.(?:js|css)$/.test(url.pathname)) seen.push(url.pathname);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const { browserContextId } = await send('Target.createBrowserContext', { disposeOnDetach: true });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const tab = (method, params) => send(method, params, sessionId);
  const evaluate = async (expression) => (await tab('Runtime.evaluate', { expression, returnByValue: true }))?.result?.value;
  const waitFor = async (expression, ms) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) {
      const value = await evaluate(expression).catch(() => null);
      if (value) return value;
    }
    return null;
  };
  // idle = no new asset requests for 5 s (the client keeps loading chunks for a few seconds after the first render)
  const settle = async () => {
    await waitFor(`document.querySelectorAll('li[id^="chat-messages-"]').length`, 60000);
    for (let last = -1; last !== seen.length; await sleep(5000)) last = seen.length;
  };
  await tab('Network.enable');
  await tab('Network.setCacheDisabled', { cacheDisabled: false });
  await tab('Page.navigate', { url: `${BASE}/` });
  if (await waitFor(`!!document.querySelector('input[name=password]')`, 15000)) {
    await evaluate(`(()=>{const i=document.querySelector('input[name=password]');i.value=${JSON.stringify(args.password || '')};i.form.submit();return 1})()`);
  }
  await settle();
  for (const extra of paths) {
    await tab('Page.navigate', { url: BASE + extra });
    await settle();
  }
  await send('Target.disposeBrowserContext', { browserContextId });
  ws.close();

  const previous = fs.existsSync(TRACE) ? JSON.parse(fs.readFileSync(TRACE, 'utf8')).files || [] : [];
  const files = [...new Set([...previous, ...seen.filter((p) => !/\/boot-[0-9a-f]+\.(?:js|css)$/.test(p))])];
  fs.writeFileSync(TRACE, JSON.stringify({ updated: new Date().toISOString(), files }, null, 1) + '\n');
  console.log(`[boot-bundle] trace: ${seen.length} asset requests, ${files.length - previous.length} new files, ${files.length} in ${TRACE}`);
}

// ---- build ----------------------------------------------------------------------------------------------------------
function build() {
  const PUBLIC = path.resolve(args.public || 'pages/public');
  const ASSETS = path.join(PUBLIC, 'assets');
  const shellPath = path.join(PUBLIC, 'official-shell.html');
  const originalPath = path.join(path.dirname(TRACE), 'official-shell.unbundled.html'); // outside public/: not deployed
  const current = fs.readFileSync(shellPath, 'utf8');
  // official-shell.html without the marker = freshly written by fetch-client: it becomes the new original
  if (!current.includes('data-boot-bundle') || !fs.existsSync(originalPath)) fs.writeFileSync(originalPath, current);
  const shell = fs.readFileSync(originalPath, 'utf8');
  const traced = fs.existsSync(TRACE) ? JSON.parse(fs.readFileSync(TRACE, 'utf8')).files || [] : [];
  if (!traced.length) console.warn(`[boot-bundle] no trace at ${TRACE}: bundling only the scripts and styles listed in the page`);

  const fileOf = (href) => {
    const m = /^\/assets\/([^/?#]+)$/.exec(href);
    return m && fs.existsSync(path.join(ASSETS, m[1])) ? m[1] : null;
  };
  const scriptTags = [...shell.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>\s*<\/script>/g)].filter((m) => fileOf(m[1]));
  const styleTags = [...shell.matchAll(/<link\b[^>]*>/g)].filter((m) => /\brel="stylesheet"/.test(m[0]) && fileOf(m[0].match(/\bhref="([^"]+)"/)?.[1] || ''));
  const preloadTags = [...shell.matchAll(/<link\b[^>]*>/g)].filter((m) => /\brel="preload"/.test(m[0]) && /\bas="script"/.test(m[0]));
  const pageScripts = scriptTags.map((m) => fileOf(m[1]));
  const isChunk = (f) => CHUNK_RE.test(fs.readFileSync(path.join(ASSETS, f), 'utf8').slice(0, 200));
  const pageChunks = pageScripts.filter(isChunk);
  const runtimeTags = new Set(scriptTags.filter((m) => !isChunk(fileOf(m[1]))).map((m) => m[0]));
  const pageStyles = styleTags.map((m) => fileOf(m[0].match(/\bhref="([^"]+)"/)[1]));
  const onPage = new Set([...pageScripts, ...pageStyles]);
  const read = (name) => fs.readFileSync(path.join(ASSETS, name), 'utf8');
  const lazyScripts = traced.map(fileOf).filter((f) => f && f.endsWith('.js') && !onPage.has(f) && isChunk(f));
  const lazyStyles = traced.map(fileOf).filter((f) => f && f.endsWith('.css') && !onPage.has(f));

  const chunkGlobal = [...pageChunks, ...lazyScripts].map((f) => CHUNK_RE.exec(read(f).slice(0, 200))?.[1]).find(Boolean);
  if (!chunkGlobal) throw new Error('no webpackChunk* global found in the page scripts');
  const body = (name) => read(name).replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '');
  const wrap = (name) => `try{(function(){${body(name)}\n}).call(self)}catch(e){setTimeout(function(){throw e})}\n`;
  const store = (name) => `B[${JSON.stringify(name)}]=function(){${body(name)}\n};\n`;
  // runs inside every bundler runtime (third element of a chunk push):
  //   r.l(url, done): a stored chunk runs in its own task (MessageChannel: no timer clamping), its push registers it as
  //   the <script> would, then done("load");
  //   CSS chunks whose file is in the combined stylesheet count as loaded (rspack: r.f.css + r.k, mini-css: r.f.miniCss + r.miniCssF)
  const hook = `(self.${chunkGlobal}=self.${chunkGlobal}||[]).push([["boot-bundle"],{},function(r){` +
    `var B=self.__bootChunks=self.__bootChunks||{},styles=${JSON.stringify(Object.fromEntries(lazyStyles.map((f) => [f, 1])))};` +
    `var Q=self.__bootQueue;if(!Q){Q=self.__bootQueue=[];var C=new MessageChannel();C.port1.onmessage=function(){var f=Q.shift();f&&f()};Q.post=function(f){Q.push(f);C.port2.postMessage(0)}}` +
    `if(typeof r.l==="function"&&!r.l.boot){var load=r.l;r.l=function(url,done){var name=String(url).split(/[?#]/)[0].split("/").pop(),chunk=B[name];` +
    `if(!chunk)return load.apply(this,arguments);delete B[name];` +
    `Q.post(function(){try{chunk.call(self)}catch(e){setTimeout(function(){throw e})}done({type:"load",target:{src:url}})})};r.l.boot=1}` +
    `[["css","k"],["miniCss","miniCssF"]].forEach(function(p){var load=r.f&&r.f[p[0]],name=r[p[1]];if(typeof load!=="function"||typeof name!=="function"||load.boot)return;` +
    `r.f[p[0]]=function(id){var file="";try{file=String(name(id)).split("/").pop()}catch(e){}if(styles[file])return;return load.apply(this,arguments)};r.f[p[0]].boot=1})}]);\n`;

  // groups: the chunk files between two runtime tags; the group before the last runtime (the app) also carries the hook
  // and the stored lazy chunks. A group becomes one or more parts, a file is never split
  const groups = [{ files: [], runtime: null }];
  for (const m of scriptTags) {
    if (runtimeTags.has(m[0])) { groups[groups.length - 1].runtime = m[0]; groups.push({ files: [], runtime: null }); }
    else groups[groups.length - 1].files.push(fileOf(m[1]));
  }
  const appGroup = groups.length > 1 ? groups[groups.length - 2] : groups[0];
  const parts = [];
  const pack = (codes, open = '', close = '') => {
    const out = [];
    let buffer = '';
    for (const code of codes) {
      if (buffer && buffer.length + code.length > PART_BYTES) { out.push(open + buffer + close); buffer = ''; }
      buffer += code;
    }
    if (buffer) out.push(open + buffer + close);
    return out;
  };
  for (const group of groups) {
    group.parts = group === appGroup
      ? [...pack(lazyScripts.map(store), '(function(B){', '})(self.__bootChunks=self.__bootChunks||{});\n'), ...pack([hook, ...group.files.map(wrap)])]
      : pack(group.files.map(wrap));
    parts.push(...group.parts);
  }
  const css = [...pageStyles, ...lazyStyles].map((f) => `/* ${f} */\n${read(f).replace(/\n\/\*# sourceMappingURL=\S+\s*\*\/\s*$/, '')}\n`).join('');

  const hashName = (content, ext) => `boot-${crypto.createHash('sha256').update(content).digest('hex').slice(0, 16)}.${ext}`;
  const written = new Set();
  const write = (content, ext) => {
    const name = hashName(content, ext);
    fs.writeFileSync(path.join(ASSETS, name), content);
    written.add(name);
    return name;
  };
  for (const group of groups) group.names = group.parts.map((p) => write(p, 'js'));
  const partNames = groups.flatMap((g) => g.names);
  const cssName = write(css, 'css');
  for (const old of fs.readdirSync(ASSETS)) if (/^boot-[0-9a-f]{16}\.(?:js|css)$/.test(old) && !written.has(old)) fs.unlinkSync(path.join(ASSETS, old));

  // rewrite: first stylesheet → combined CSS, first script → all parts; the other bundled tags and script preloads go
  let out = shell;
  const firstScript = scriptTags[0]?.[0];
  const firstStyle = styleTags[0]?.[0];
  const bundled = new Set([...pageChunks, ...pageStyles]);
  // all page scripts are defer: only their relative order matters, so the whole sequence goes where the first one was
  const drop = new Set([...scriptTags.map((m) => m[0]), ...styleTags.map((m) => m[0]),
    ...preloadTags.filter((m) => bundled.has(fileOf(m[0].match(/\bhref="([^"]+)"/)?.[1] || ''))).map((m) => m[0])]);
  const sequence = groups.flatMap((g) => [...g.names.map((n) => `<script defer src="/assets/${n}" data-boot-bundle></script>`), ...(g.runtime ? [g.runtime] : [])]);
  out = out.replace(/<script\b[^>]*\bsrc="[^"]+"[^>]*>\s*<\/script>|<link\b[^>]*>/g, (tag) => {
    if (tag === firstStyle) return `<link rel="stylesheet" href="/assets/${cssName}" data-boot-bundle>`;
    if (tag === firstScript) return sequence.join('\n');
    return drop.has(tag) ? '' : tag;
  });
  fs.writeFileSync(shellPath, out);

  const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  console.log(`[boot-bundle] ${pageChunks.length} page chunks + ${lazyScripts.length} lazy chunks → ${partNames.length} parts (${mb(parts.reduce((a, p) => a + p.length, 0))}); ${runtimeTags.size} runtime scripts keep their tags`);
  console.log(`[boot-bundle] ${pageStyles.length} page styles + ${lazyStyles.length} lazy styles → ${cssName} (${mb(css.length)})`);
  console.log(`[boot-bundle] rewrote ${shellPath} (original: ${originalPath})`);
}
