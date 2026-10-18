// Offline test for shared/discord-guard.ts and the sync worker's cron loop: fake Discord (stubbed fetch) + node:sqlite as D1.
// Nothing here talks to discord.com. Usage: node test/guard-and-sync.test.mjs  (Node 22.5+, needs pages/node_modules for esbuild)
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const esbuild = path.join(here, '..', 'pages', 'node_modules', '.bin', 'esbuild');
const out = fs.mkdtempSync('/tmp/guard-test-');
execFileSync(esbuild, [path.join(here, '..', 'shared', 'discord-guard.ts'), '--bundle', '--format=esm', `--outfile=${out}/guard.mjs`]);
execFileSync(esbuild, [path.join(here, '..', 'sync-worker', 'src', 'index.ts'), '--bundle', '--format=esm', `--outfile=${out}/sync.mjs`]);

function fakeD1() {
  const db = new DatabaseSync(':memory:');
  const stmt = (sql, args = []) => ({
    sql,
    bind: (...a) => stmt(sql, a),
    first: async (col) => { const r = db.prepare(sql).get(...args); return r ? (col ? r[col] : { ...r }) : null; },
    all: async () => ({ results: db.prepare(sql).all(...args).map((r) => ({ ...r })) }),
    run: async () => { db.prepare(sql).run(...args); return { success: true }; },
    _all: () => ({ results: db.prepare(sql).all(...args).map((r) => ({ ...r })) })
  });
  return {
    raw: db,
    prepare: (sql) => stmt(sql),
    batch: async (list) => { db.exec('BEGIN'); try { const r = list.map((s) => s._all()); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } }
  };
}

let calls = [];
let responder = () => new Response('[]', { status: 200 });
globalThis.fetch = async (url, init = {}) => { calls.push(String(url)); return responder(String(url), init); };
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const guard = await import(`${out}/guard.mjs`);
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); };
const tryFetch = async (env, url) => { try { const r = await guard.discordFetch(env, url); return r.status; } catch (e) { return e.status === 429 ? `refused(${e.retryAfter}s)` : `error ${e.message}`; } };
const M = (ch) => `https://discord.com/api/v10/channels/${ch}/messages?limit=50`;

// 1. 429 on a route: that route pauses (no more upstream calls), other routes keep working
{
  const env = { DB: fakeD1() };
  calls = [];
  responder = () => json({ message: 'You are being rate limited.', retry_after: 7.5, global: false }, 429);
  const first = await tryFetch(env, M('111'));
  responder = () => json([], 200, { 'x-ratelimit-remaining': '4' });
  const second = await tryFetch(env, M('111'));
  const other = await tryFetch(env, M('222'));
  check('429 pauses that route without calling Discord again', String(first).startsWith('refused') && String(second).startsWith('refused') && other === 200 && calls.length === 2, `first=${first} second=${second} other=${other} upstream_calls=${calls.length}`);
}

// 2. Global 429 pauses everything
{
  const env = { DB: fakeD1() };
  calls = [];
  responder = () => json({ retry_after: 20, global: true }, 429, { 'x-ratelimit-global': 'true' });
  await tryFetch(env, M('111'));
  responder = () => json([]);
  const other = await tryFetch(env, 'https://discord.com/api/v9/attachments/refresh-urls');
  check('global 429 pauses every route', String(other).startsWith('refused') && calls.length === 1, `other=${other} upstream_calls=${calls.length}`);
}

// 3. X-RateLimit-Remaining: 0 waits for the bucket reset instead of hitting a 429
{
  const env = { DB: fakeD1() };
  calls = [];
  responder = () => json([], 200, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '1.2' });
  await tryFetch(env, M('333'));
  responder = () => json([], 200, { 'x-ratelimit-remaining': '3' });
  const t0 = Date.now();
  const second = await tryFetch(env, M('333'));
  const waited = Date.now() - t0;
  check('empty bucket: next call waits for reset, then succeeds', second === 200 && waited >= 1200 && calls.length === 2, `waited=${waited}ms status=${second}`);
}

// 4. 401 (dead token) stops all calls for 30 minutes
{
  const env = { DB: fakeD1() };
  calls = [];
  responder = () => json({ message: '401: Unauthorized', code: 0 }, 401);
  const first = await tryFetch(env, M('444'));
  responder = () => json([]);
  const later = await tryFetch(env, 'https://discord.com/api/v10/guilds/1/channels');
  const row = env.DB.raw.prepare("SELECT blocked_until FROM discord_rate WHERE scope = 'global'").get();
  const minutes = Math.round((row.blocked_until - Date.now()) / 60000);
  check('401 stops every route for 30 min', first === 401 && String(later).startsWith('refused') && calls.length === 1 && minutes === 30, `blocked_for=${minutes}min upstream_calls=${calls.length}`);
}

// 5. Per-route budget: 12/min; the 13th call is refused locally
{
  const env = { DB: fakeD1() };
  calls = [];
  responder = () => json([], 200, { 'x-ratelimit-remaining': '5' });
  const statuses = [];
  const t0 = Date.now();
  for (let i = 0; i < 12; i++) statuses.push(await tryFetch(env, M('555')));
  const elapsed = Date.now() - t0;
  statuses.push(await tryFetch(env, M('555')));
  const refused = statuses.filter((s) => String(s).startsWith('refused')).length;
  // a refusal within 3 s of the next minute waits and retries, so allow either outcome for the last call
  check('route budget caps calls per minute', calls.length <= 13 && (refused === 1 || calls.length === 13) && calls.length >= 12, `upstream_calls=${calls.length} refused=${refused}`);
  check('calls from one instance are spaced >= 350 ms', elapsed >= 11 * 350, `12 calls took ${elapsed}ms`);
}

// 6. Cron loop: one list request, then only channels with new messages; heartbeat lists up-to-date channels
{
  const env = { DB: fakeD1(), DISCORD_TOKEN: 'fake', DISCORD_GUILD_ID: '2000000000000000900' };
  const db = env.DB.raw;
  db.exec(`CREATE TABLE sync_status (channel_id TEXT PRIMARY KEY, last_refreshed_at INTEGER, latest_message_id TEXT, in_flight INTEGER DEFAULT 0, lock_expires_at INTEGER DEFAULT 0);
    CREATE TABLE message_cache (channel TEXT, message_id TEXT, created_at TEXT, payload BLOB, inserted_at INTEGER DEFAULT 0, PRIMARY KEY(channel, message_id));
    CREATE TABLE metadata (name TEXT PRIMARY KEY, payload BLOB);
    CREATE TABLE block_index (channel TEXT, seq INTEGER, first_id INTEGER, last_id INTEGER, count INTEGER, PRIMARY KEY(channel, seq)); -- INTEGER like production: reading ids > 2^53 without CAST must fail here
    CREATE TABLE thread_meta (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, name TEXT NOT NULL, owner_id TEXT NOT NULL, message_count INTEGER NOT NULL DEFAULT 0, last_message_id TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 1);
    INSERT INTO sync_status VALUES ('2000000000000000003', 0, '1000000000000000100', 0, 0), ('2000000000000000002', 0, '1000000000000000200', 0, 0), ('2000000000000000001', 0, '1000000000000000300', 0, 0);
    INSERT INTO block_index VALUES ('1000000000000000777', 1, 1000000000000000001, 1000000000000000050, 50);`);
  const listing = [
    { id: '2000000000000000003', name: 'news', type: 0, last_message_id: '1000000000000000105' },   // 5 new
    { id: '2000000000000000002', name: 'chat', type: 0, last_message_id: '1000000000000000200' }, // none
    { id: '2000000000000000001', name: 'general', type: 0, last_message_id: '1000000000000000300' },     // none
    { id: '1000000000000000777', name: 'never-synced', type: 0, last_message_id: '1000000000000000052' }, // 2 new after archive
    { id: '1000000000000000888', name: 'voice', type: 2, last_message_id: '1000000000000000999' },
    { id: '1000000000000000999', name: 'empty', type: 0, last_message_id: null },
    { id: '1000000000000000555', name: 'forum', type: 15, last_message_id: null }
  ];
  // 论坛活跃帖子：一个新帖（归档里没有），threads/search 才能发现
  const forumThreads = { threads: [{ id: '1000000000000000600', parent_id: '1000000000000000555', name: 'new post', owner_id: '1', message_count: 3, last_message_id: '1000000000000000603', thread_metadata: { archived: false } }], has_more: false, total_results: 1 };
  const msgs = (from, n, ch) => Array.from({ length: n }, (_, i) => ({ id: String(BigInt(from) + BigInt(i + 1)), channel_id: ch, content: `m${i}`, timestamp: new Date().toISOString(), author: { id: '1', username: 'u' }, attachments: [], embeds: [] }));
  calls = [];
  responder = (url) => {
    if (url.includes('/guilds/2000000000000000900/channels')) return json(listing, 200, { 'x-ratelimit-remaining': '4' });
    if (url.includes('/threads/search')) return json(url.includes('/channels/1000000000000000555/') && url.includes('archived=false') ? forumThreads : { threads: [], has_more: false, total_results: 0 });
    const u = new URL(url);
    const ch = u.pathname.split('/')[4];
    const after = u.searchParams.get('after');
    if (ch === '2000000000000000003') return json(msgs(after, 5, ch).reverse());
    if (ch === '1000000000000000777') return json(msgs(after, 2, ch).reverse());
    if (ch === '1000000000000000600') return json(BigInt(after) < 1000000000000000603n ? msgs('1000000000000000600', 3, ch).reverse() : []);
    return json([]);
  };
  const sync = await import(`${out}/sync.mjs`);
  const r1 = await sync.syncAllChannels(env);
  const fetched = calls.filter((c) => c.includes('/messages')).map((c) => new URL(c).pathname.split('/')[4] + '@' + new URL(c).searchParams.get('after'));
  const beat = JSON.parse(db.prepare("SELECT payload FROM metadata WHERE name='cron_heartbeat'").get().payload);
  const cached = db.prepare('SELECT COUNT(*) n FROM message_cache').get().n;
  const search = calls.filter((c) => c.includes('/threads/search'));
  const thread = db.prepare("SELECT parent_id, name, archived FROM thread_meta WHERE id = '1000000000000000600'").get();
  check('cron: 1 list call + 1 thread search + only the changed channels/posts', calls.length === 5 && search.length === 1 && search[0].includes('archived=false') && fetched.includes('2000000000000000003@1000000000000000100') && fetched.includes('1000000000000000777@1000000000000000050') && fetched.includes('1000000000000000600@0'), `calls=${calls.length} fetched=${fetched.join(',')}`);
  check('cron: new forum post discovered (active), stored in thread_meta and fetched from the start', thread?.parent_id === '1000000000000000555' && thread.archived === 0 && db.prepare("SELECT COUNT(*) n FROM message_cache WHERE channel = '1000000000000000600'").get().n === 3, `thread=${JSON.stringify(thread)}`);
  check('cron: new messages cached, heartbeat lists up-to-date channels', r1.total_new_messages === 10 && cached === 10 && beat.channels.includes('1000000000000000600') && !beat.channels.includes('1000000000000000888'), `new=${r1.total_new_messages} cached=${cached} heartbeat=${beat.channels.length}`);

  listing[0].last_message_id = '1000000000000000105';
  listing[3].last_message_id = '1000000000000000052';
  calls = [];
  await sync.syncAllChannels(env);
  const second = calls.filter((c) => c.includes('/threads/search'));
  calls = [];
  await sync.syncAllChannels(env);
  check('cron: idle minute costs 2 requests (channel list + one thread search, forum/archived alternate)', calls.length === 2 && second[0]?.includes('archived=true') && calls[1].includes('/channels/1000000000000000555/threads/search?archived=false'), `calls=${calls.map((c) => c.split("/api/")[1]).join(" ; ")} run2=${second[0]?.split("/api/v9")[1]}`);

  // 5 个频道都有新消息、另有一个落后的帖子：帖子必须占到 1 个名额（之前频道每轮占满 4 个，帖子永远轮不上）
  {
    db.exec('DELETE FROM discord_rate'); // each scenario gets a fresh request budget (/guilds/:id/channels allows 4/min)
    const busy = Array.from({ length: 5 }, (_, i) => ({ id: String(1000000000000001000n + BigInt(i)), name: `busy${i}`, type: 0, last_message_id: '1000000000000009999' }));
    db.exec(`INSERT INTO thread_meta VALUES ('1000000000000000700', '1000000000000000555', 'lagging post', '1', 5, '1000000000000000705', 0)`);
    const saved = responder;
    responder = (url) => {
      if (url.includes('/guilds/2000000000000000900/channels')) return json([...listing, ...busy]);
      if (url.includes('/threads/search')) return json({ threads: [], has_more: false });
      const ch = new URL(url).pathname.split('/')[4];
      if (ch === '1000000000000000700') return json(msgs('1000000000000000700', 5, ch).reverse());
      return json(msgs(new URL(url).searchParams.get('after') || '1000000000000000000', 2, ch).reverse());
    };
    calls = [];
    await sync.syncAllChannels(env);
    const fetchedNow = calls.filter((c) => c.includes('/messages')).map((c) => new URL(c).pathname.split('/')[4]);
    check('cron: a lagging post gets a fetch slot even when channels are busy', fetchedNow.length === 4 && fetchedNow.includes('1000000000000000700'), `fetched=${fetchedNow.join(',')}`);
    responder = saved;
  }

  // 生产上的情况：3 个无权访问的频道（403）排在队列最前，之前被拒绝后整轮直接结束，帖子永远轮不上
  {
    db.exec('DELETE FROM discord_rate'); // each scenario gets a fresh request budget (/guilds/:id/channels allows 4/min)
    const locked = Array.from({ length: 3 }, (_, i) => ({ id: String(1000000000000002000n + BigInt(i)), name: `locked${i}`, type: 0, last_message_id: '1000000000000009999' }));
    db.exec(`INSERT INTO thread_meta VALUES ('1000000000000000800', '1000000000000000555', 'starved post', '1', 4, '1000000000000000804', 0)`);
    const saved = responder;
    responder = (url) => {
      if (url.includes('/guilds/2000000000000000900/channels')) return json([...listing, ...locked]);
      if (url.includes('/threads/search')) return json({ threads: [], has_more: false });
      const ch = new URL(url).pathname.split('/')[4];
      if (ch.startsWith('100000000000000200')) return json({ message: 'Missing Access', code: 50001 }, 403);
      if (ch === '1000000000000000800') return json(msgs('1000000000000000800', 4, ch).reverse());
      return json([]);
    };
    calls = [];
    await sync.syncAllChannels(env);
    const run1 = calls.filter((c) => c.includes('/messages')).map((c) => new URL(c).pathname.split('/')[4]);
    calls = [];
    await sync.syncAllChannels(env);
    const run2 = calls.filter((c) => c.includes('/messages')).map((c) => new URL(c).pathname.split('/')[4]);
    const forbidden = JSON.parse(db.prepare("SELECT payload FROM metadata WHERE name = 'forbidden_channels'").get()?.payload || '{}');
    check('cron: 403 channels are remembered and skipped; the post still gets fetched', run1.includes('1000000000000000800') && Object.keys(forbidden).length === 3 && !run2.some((c) => c.startsWith('100000000000000200')),
      `run1=${run1.join(',')} run2=${run2.join(',') || '-'} forbidden=${Object.keys(forbidden).length}`);
    responder = saved;
  }

  calls = [];
  responder = (url) => url.includes('/channels') && !url.includes('/messages') ? json({ retry_after: 30, global: false }, 429) : json([]);
  const r3 = await sync.syncAllChannels(env);
  calls.length = 0;
  responder = () => json(listing);
  const r4 = await sync.syncAllChannels(env);
  check('cron: after a 429 the next runs skip without calling Discord', !!r3.skipped && !!r4.skipped && calls.length === 0, `run3=${r3.skipped} run4=${r4.skipped} calls=${calls.length}`);
}

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
fs.rmSync(out, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
