#!/usr/bin/env node
// Fills member_meta (roles, server nickname, server avatar) for every known user in one go, the way the official client
// loads members while you browse a server: one gateway session, REQUEST_GUILD_MEMBERS (op 8) with 100 user ids each.
// ~1,300 users take a few seconds. Members are only ever fetched in bulk like this; re-run it to pick up new members
// and role changes (the sync worker refreshes the role list itself).
//
//   DISCORD_TOKEN=... node scripts/backfill_members.mjs --guild <server id> --db <D1 name> [--local] [--config pages/wrangler.jsonc]
//
// User ids: user_meta, message authors synced since the import, and member_meta. With a user token run this from a normal connection:
// Discord rejects user-token gateway logins from Cloudflare's network (close code 4000).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const TOKEN = (process.env.DISCORD_TOKEN || '').trim();
const GUILD = String(args.guild || '');
const CONFIG = path.resolve(args.config || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'pages', 'wrangler.jsonc'));
const TARGET = args.local ? '--local' : '--remote';
if (!TOKEN || !/^\d{15,22}$/.test(GUILD) || !args.db) {
  console.error('usage: DISCORD_TOKEN=... node scripts/backfill_members.mjs --guild <server id> --db <D1 name> [--local] [--config <wrangler config>]');
  process.exit(1);
}
const isBot = /^Bot\s/i.test(TOKEN);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const wrangler = (extra) => execFileSync('npx', ['wrangler', 'd1', 'execute', args.db, TARGET, '-y', '--config', CONFIG, ...extra],
  { cwd: path.dirname(CONFIG), encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 << 20 });

// same table as scripts/schema.sql
wrangler(['--command', 'CREATE TABLE IF NOT EXISTS member_meta (user_id TEXT PRIMARY KEY, in_guild INTEGER NOT NULL DEFAULT 0, nick TEXT, ' +
  'profile TEXT, fetched_at INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID']);
const rows = JSON.parse(wrangler(['--json', '--command',
  "SELECT id FROM user_meta UNION SELECT json_extract(CAST(payload AS TEXT), '$.author_id') FROM message_cache UNION SELECT user_id FROM member_meta"]))[0].results;
const ids = [...new Set(rows.map((r) => String(r.id)).filter((id) => /^\d{15,22}$/.test(id)))];
console.error(`${ids.length} users to look up`);

const members = new Map();
const notFound = new Set();
await new Promise((resolve, reject) => {
  const ws = new WebSocket('wss://gateway.discord.gg/?v=9&encoding=json');
  const chunks = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
  let next = 0;
  let pending = 0;
  let seq = null;
  let beat;
  const timer = setTimeout(() => { ws.close(); reject(new Error('timed out after 120 s')); }, 120_000);
  const send = (op, d) => ws.send(JSON.stringify({ op, d }));
  const request = () => {
    if (next >= chunks.length) {
      if (!pending) { clearTimeout(timer); clearInterval(beat); ws.close(1000); resolve(); }
      return;
    }
    pending++;
    send(8, { guild_id: [GUILD], user_ids: chunks[next], presences: false, nonce: String(next) });
    next++;
  };
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.s != null) seq = msg.s;
    if (msg.op === 10) {
      beat = setInterval(() => send(1, seq), msg.d.heartbeat_interval);
      send(2, isBot
        ? { token: TOKEN.slice(4).trim(), intents: 1, properties: { os: 'linux', browser: 'discord-archive-client', device: 'discord-archive-client' } }
        : {
            token: TOKEN,
            capabilities: 1767421,
            properties: {
              os: 'Mac OS X', browser: 'Chrome', device: '', system_locale: 'en-US', browser_user_agent: UA, browser_version: '140.0.0.0',
              os_version: '10.15.7', referrer: '', referring_domain: '', release_channel: 'stable',
              client_build_number: Number(process.env.GATEWAY_CLIENT_BUILD || 641004), client_event_source: null
            },
            client_state: { guild_versions: {} }
          });
    } else if (msg.t === 'READY') {
      request(); // one request in flight at a time, like the client's member requester
    } else if (msg.t === 'GUILD_MEMBERS_CHUNK' && msg.d?.guild_id === GUILD) {
      for (const m of msg.d.members || []) members.set(String(m.user.id), m);
      for (const id of msg.d.not_found || []) notFound.add(String(id));
      if ((msg.d.chunk_index ?? 0) + 1 >= (msg.d.chunk_count ?? 1)) { pending--; request(); }
    }
  };
  ws.onclose = (event) => {
    clearTimeout(timer); clearInterval(beat);
    if (next < chunks.length || pending) reject(new Error(`gateway closed: ${event.code} ${event.reason}`));
  };
  ws.onerror = () => {};
});
console.error(`${members.size} members, ${notFound.size} no longer in the server`);

const lit = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const now = Date.now();
const upsert = (id, inGuild, nick, profile) =>
  `INSERT OR REPLACE INTO member_meta (user_id, in_guild, nick, profile, fetched_at) VALUES (${lit(id)}, ${inGuild}, ${lit(nick)}, ${lit(profile)}, ${now});`;
const sql = [];
for (const [id, m] of members) {
  const { user, ...member } = m;
  sql.push(upsert(id, 1, member.nick ?? null, JSON.stringify({ user, guild_member: member })));
}
for (const id of notFound) if (!members.has(id)) sql.push(upsert(id, 0, null, null));
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'members-')), 'members.sql');
fs.writeFileSync(file, sql.join('\n') + '\n');
wrangler(['--file', file]);
console.error(`wrote ${sql.length} rows to member_meta (${TARGET.slice(2)})`);
