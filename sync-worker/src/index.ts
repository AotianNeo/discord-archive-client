/**
 * 云端增量同步 Worker：Cron Trigger 每分钟运行，把服务器里的新消息、新帖子写进 D1，
 * 与 Pages 项目共用同一个 D1 数据库。所有 Discord 请求经过 shared/discord-guard.ts 限频。
 */

import { DiscordRateLimited, discordFetch, discordRateState } from '../../shared/discord-guard';
import { isForward, snapshotsFromDiscord } from '../../shared/message-snapshots';

export interface Env {
  DB: D1Database;
  DISCORD_TOKEN: string;          // secret；用户令牌，或 "Bot <token>"
  DISCORD_GUILD_ID: string;
  GUILD_OWNER_ID?: string;        // 可选：服主 ID，消息上的 owner 标记
  PRIORITY_CHANNEL_IDS?: string;  // 可选：逗号分隔，名额不够时优先同步的频道
}

let GUILD_OWNER_ID = '0';

function getDomainProvider(url: string): { name: string; url?: string; color?: number } {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host.includes('youtube.com') || host.includes('youtu.be')) return { name: 'YouTube', url: 'https://www.youtube.com', color: 16711680 };
    if (host.includes('twitter.com') || host.includes('x.com')) return { name: 'X (Twitter)', url: 'https://x.com', color: 1942002 };
    if (host.includes('substack.com')) return { name: 'Substack', url: 'https://substack.com', color: 16736000 };
    if (host.includes('zoom.us')) return { name: 'Zoom', url: 'https://zoom.us', color: 2969087 };
    if (host.includes('drive.google.com')) return { name: 'Google Drive', url: 'https://drive.google.com', color: 4289797 };
    if (host.includes('github.com')) return { name: 'GitHub', url: 'https://github.com', color: 2434341 };
    if (host.includes('tenor.com')) return { name: 'Tenor', url: 'https://tenor.com' };
    const cleanHost = host.replace(/^www\./, '');
    const capitalized = cleanHost.charAt(0).toUpperCase() + cleanHost.slice(1);
    return { name: capitalized, url: `${parsed.protocol}//${cleanHost}` };
  } catch {
    return { name: 'Link' };
  }
}

export function normalizeDiscordEmbed(raw: any): any {
  if (!raw) return null;
  if (typeof raw === 'object' && !Array.isArray(raw) && raw.type && (raw.title || raw.description || raw.url || raw.image || raw.thumbnail)) {
    return raw;
  }

  let title = '';
  let description = '';
  let url = '';
  let footer = '';
  let image = '';
  let thumbnail = '';
  let color: number | undefined = undefined;
  let author: any = undefined;
  let provider: any = undefined;

  if (Array.isArray(raw)) {
    title = String(raw[0] || '').trim();
    description = String(raw[1] || '').trim();
    url = String(raw[2] || '').trim();
    footer = String(raw[3] || '').trim();
  } else if (typeof raw === 'object') {
    title = String(raw.title || '').trim();
    description = String(raw.description || '').trim();
    url = String(raw.url || '').trim();
    footer = typeof raw.footer === 'string' ? raw.footer : String(raw.footer?.text || '').trim();
    image = String(raw.image?.url || raw.image || '').trim();
    thumbnail = String(raw.thumbnail?.url || raw.thumbnail || '').trim();
    if (typeof raw.color === 'number') color = raw.color;
    if (raw.author) author = raw.author;
    if (raw.provider) provider = raw.provider;
  }

  if (!url && !title && !description && !image) return null;

  let type = 'rich';
  const lowerUrl = url.toLowerCase();
  const domainInfo = url ? getDomainProvider(url) : null;
  if (domainInfo) {
    if (!provider) provider = { name: domainInfo.name, url: domainInfo.url };
    if (color === undefined && domainInfo.color) color = domainInfo.color;
  }

  if (lowerUrl.includes('twitter.com') || lowerUrl.includes('x.com') || footer.toLowerCase() === 'x') {
    type = 'rich';
    color = 1942002;
    provider = { name: 'X (Twitter)', url: 'https://x.com' };
    if (!author) {
      const authorMatch = url.match(/(?:twitter\.com|x\.com)\/([a-zA-Z0-9_]+)/i);
      const handle = authorMatch ? authorMatch[1] : '';
      if (handle && handle.toLowerCase() !== 'i' && handle.toLowerCase() !== 'status') {
        author = { name: `@${handle}`, url: `https://x.com/${handle}` };
      }
    }
    if (!footer) footer = 'X';
  } else if (lowerUrl.includes('youtube.com') || lowerUrl.includes('youtu.be')) {
    type = 'video';
    const vMatch = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    if (vMatch && !thumbnail) thumbnail = `https://img.youtube.com/vi/${vMatch[1]}/hqdefault.jpg`;
  } else if (lowerUrl.includes('tenor.com') || lowerUrl.includes('giphy.com')) {
    type = 'gifv';
    if (!title) {
      const slugMatch = url.match(/\/view\/([^/?#]+)/i);
      if (slugMatch) title = slugMatch[1].replace(/-gif-\d+$/, '').replace(/-\d+$/, '').replace(/-/g, ' ');
    }
  } else if (/\.(png|jpe?g|gif|webp|svg)($|\?)/i.test(url)) {
    type = 'image';
    if (!image) image = url;
  }

  const embed: any = { type, url: url || undefined };
  if (title) embed.title = title;
  if (description) embed.description = description;
  if (color !== undefined) embed.color = color;
  if (provider) embed.provider = provider;
  if (author) embed.author = author;
  if (footer) {
    embed.footer = {
      text: footer,
      icon_url: footer.toLowerCase() === 'x' ? 'https://abs.twimg.com/responsive-web/client-web/icon-default.522d363a.png' : undefined
    };
  }
  if (image) embed.image = { url: image, proxy_url: image, width: 600, height: 400 };
  if (thumbnail) embed.thumbnail = { url: thumbnail, proxy_url: thumbnail, width: 400, height: 300 };

  return embed;
}

function compareSnowflake(a: string, b: string): number {
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
const FETCH_LIMIT = 50;
const MAX_CHANNEL_FETCHES_PER_RUN = 4; // 有新消息的频道每轮最多拉 4 个，其余下一分钟继续

// 令牌无权读取的频道（返回 403）：记 24 小时，期间不再请求。键为频道 ID（拉消息）或 threads:<频道 ID>（查帖子，
// 机器人令牌不能用 threads/search，不能因此连消息都不拉）。
// 之前它们每轮都排在队列最前，403 后被 discord-guard 停 10 分钟，被拒绝的请求又让整轮循环提前结束，帖子一直轮不上
const FORBIDDEN_TTL_MS = 24 * 3600_000;

async function readForbidden(env: Env): Promise<Record<string, number>> {
  const row = await env.DB.prepare("SELECT payload FROM metadata WHERE name = 'forbidden_channels'").first<{ payload: unknown }>();
  try {
    const all = row ? JSON.parse(typeof row.payload === 'string' ? row.payload : new TextDecoder().decode(row.payload as ArrayBuffer)) : {};
    const now = Date.now();
    return Object.fromEntries(Object.entries(all).filter(([, until]) => Number(until) > now)) as Record<string, number>;
  } catch (_) {
    return {};
  }
}

async function markForbidden(env: Env, forbidden: Record<string, number>, channelId: string): Promise<void> {
  forbidden[channelId] = Date.now() + FORBIDDEN_TTL_MS;
  await env.DB.prepare(
    "INSERT INTO metadata (name, payload) VALUES ('forbidden_channels', ?) ON CONFLICT(name) DO UPDATE SET payload = excluded.payload"
  ).bind(JSON.stringify(forbidden)).run();
}

// 帖子/子区：用户令牌不能用 /guilds/:id/threads/active（仅限机器人），官方客户端靠网关推送活跃帖子，
// 所以只靠一次性导出的话，活跃的帖子可能一条都没有，已有帖子的新回复也不会更新。
// 每轮只发一个 threads/search：奇数轮查论坛的活跃帖子（论坛约 2 分钟刷新一次），
// 偶数轮轮转查论坛已归档帖子和文字频道的子区。新帖写入 thread_meta，有新消息的帖子和频道共用本轮拉取名额。
interface ThreadInfo { id: string; name: string; last_message_id: string }

async function discoverThreads(env: Env, listed: any[], headers: Record<string, string>, forbidden: Record<string, number>): Promise<ThreadInfo[]> {
  const searchable = (c: any) => !forbidden[c.id] && !forbidden[`threads:${c.id}`];
  const forums = listed.filter((c) => [15, 16].includes(Number(c.type)) && searchable(c));
  const texts = listed.filter((c) => [0, 5].includes(Number(c.type)) && searchable(c));
  const rest: Array<[any, boolean]> = [
    ...forums.map((c): [any, boolean] => [c, true]),
    ...texts.map((c): [any, boolean] => [c, false]),
    ...texts.map((c): [any, boolean] => [c, true])
  ];
  const row = await env.DB.prepare("SELECT payload FROM metadata WHERE name = 'thread_discovery'").first<{ payload: unknown }>();
  let state: { run?: number; forum?: number; rest?: number } = {};
  try { state = row ? JSON.parse(typeof row.payload === 'string' ? row.payload : new TextDecoder().decode(row.payload as ArrayBuffer)) : {}; } catch (_) {}
  const run = (state.run || 0) + 1;
  const useForum = forums.length > 0 && (run % 2 === 1 || !rest.length);
  let target: [any, boolean] | undefined;
  if (useForum) {
    target = [forums[(state.forum || 0) % forums.length], false];
    state.forum = ((state.forum || 0) + 1) % forums.length;
  } else if (rest.length) {
    target = rest[(state.rest || 0) % rest.length];
    state.rest = ((state.rest || 0) + 1) % rest.length;
  }
  await env.DB.prepare(
    "INSERT INTO metadata (name, payload) VALUES ('thread_discovery', ?) ON CONFLICT(name) DO UPDATE SET payload = excluded.payload"
  ).bind(JSON.stringify({ ...state, run })).run();
  if (!target) return [];

  const [parent, archived] = target;
  const url = `https://discord.com/api/v9/channels/${parent.id}/threads/search?archived=${archived}&sort_by=last_message_time&sort_order=desc&limit=25&offset=0`;
  const resp = await discordFetch(env, url, { headers });
  if (!resp.ok) {
    console.warn(`[CloudSync] #${parent.name} 帖子列表获取失败: ${resp.status}`);
    if (resp.status === 403) await markForbidden(env, forbidden, `threads:${parent.id}`);
    return [];
  }
  const data: any = await resp.json();
  const threads = (Array.isArray(data?.threads) ? data.threads : []).filter((t: any) => t?.id && t.last_message_id);
  if (threads.length) {
    await env.DB.batch(threads.map((t: any) => env.DB.prepare(
      'INSERT INTO thread_meta (id, parent_id, name, owner_id, message_count, last_message_id, archived) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET name = excluded.name, message_count = MAX(thread_meta.message_count, excluded.message_count), archived = excluded.archived, ' +
      'last_message_id = CASE WHEN CAST(excluded.last_message_id AS INTEGER) > CAST(thread_meta.last_message_id AS INTEGER) THEN excluded.last_message_id ELSE thread_meta.last_message_id END'
    ).bind(String(t.id), String(t.parent_id || parent.id), String(t.name || ''), String(t.owner_id || ''), Number(t.message_count || 0),
      String(t.last_message_id), t.thread_metadata?.archived ? 1 : 0)));
  }
  console.log(`[CloudSync] #${parent.name} ${archived ? '已归档' : '活跃'}帖子 ${threads.length} 个`);
  return threads.map((t: any) => ({ id: String(t.id), name: String(t.name || ''), last_message_id: String(t.last_message_id) }));
}

function toRecord(raw: any, channelId: string) {
  const authorId = raw.author?.id || '';
  const authorName = raw.author?.global_name || raw.author?.username || '用户';
  return {
    id: String(raw.id),
    channel_id: raw.channel_id || channelId,
    author_id: authorId,
    author: authorName,
    username: raw.author?.username || authorName,
    avatar: raw.author?.avatar ? `https://cdn.discordapp.com/avatars/${authorId}/${raw.author.avatar}.webp?size=64` : '',
    content: raw.content || '',
    created_at: raw.timestamp || new Date().toISOString(),
    owner: authorId === GUILD_OWNER_ID,
    // 转发（message_reference.type = 1）的内容在 message_snapshots，不能当成回复存
    ...(isForward(raw) ? { snapshots: snapshotsFromDiscord(raw) } : {
      reply_author: raw.referenced_message?.author?.global_name || raw.referenced_message?.author?.username,
      reply_author_id: raw.referenced_message?.author?.id,
      reply_content: raw.referenced_message?.content,
      reply_channel_id: raw.message_reference?.channel_id,
      reply_message_id: raw.message_reference?.message_id
    }),
    attachments: (raw.attachments || []).map((a: any) => ({
      id: a.id ? String(a.id) : undefined,
      filename: a.filename || '附件',
      url: a.url || a.proxy_url || `/attachments/${raw.id}_${a.id}.bin`,
      content_type: a.content_type || 'application/octet-stream',
      size: a.size || 0,
      width: a.width,
      height: a.height
    })),
    embeds: (raw.embeds || []).map(normalizeDiscordEmbed).filter(Boolean),
    stickers: (raw.sticker_items || []).map((st: any) => ({
      id: String(st.id),
      name: st.name || 'sticker',
      format_type: Number(st.format_type) || 1,
      url: `/stickers/${st.id}.${Number(st.format_type) === 3 ? 'json' : Number(st.format_type) === 4 ? 'gif' : 'png'}`
    })),
    message_type: Number(raw.type || 0),
    remote: true
  };
}

// 每分钟：先用 1 个请求拿到全部频道的 last_message_id，只拉真正有新消息的频道（之前每分钟固定连打 7 个频道）。
// 所有 Discord 请求走 discordFetch：跨 Worker 共享预算，429/401/403 后按 D1 里记录的时间避让。
// 跑完写 metadata.cron_heartbeat（已是最新的频道列表），Pages 那边访客打开这些频道时不再另外请求 Discord。
export async function syncAllChannels(env: Env): Promise<{
  timestamp: string;
  total_new_messages: number;
  channels_synced: Array<{ id: string; name: string; count: number; max_id: string }>;
  skipped?: string;
}> {
  const results: Array<{ id: string; name: string; count: number; max_id: string }> = [];
  const done = (skipped?: string) => ({
    timestamp: new Date().toISOString(),
    total_new_messages: results.reduce((n, r) => n + r.count, 0),
    channels_synced: results,
    ...(skipped ? { skipped } : {})
  });
  if (!env.DISCORD_TOKEN) {
    console.warn('[CloudSync] 未配置 DISCORD_TOKEN，跳过同步');
    return done('no token');
  }
  const guildId = (env.DISCORD_GUILD_ID || '').trim();
  if (!/^\d{15,22}$/.test(guildId)) {
    console.warn('[CloudSync] DISCORD_GUILD_ID 未配置，跳过同步');
    return done('no guild');
  }
  GUILD_OWNER_ID = (env.GUILD_OWNER_ID || '').trim() || '0';
  const headers = { Authorization: env.DISCORD_TOKEN, 'User-Agent': USER_AGENT };

  let listed: any[] = [];
  try {
    const resp = await discordFetch(env, `https://discord.com/api/v10/guilds/${guildId}/channels`, { headers });
    if (!resp.ok) {
      console.warn(`[CloudSync] 频道列表获取失败: ${resp.status}，本轮跳过`);
      return done(`channels ${resp.status}`);
    }
    listed = await resp.json();
  } catch (err: any) {
    console.warn('[CloudSync] 本轮跳过:', err.message);
    return done(err.message);
  }

  const known = new Map<string, string>();
  const statusRows = await env.DB.prepare('SELECT channel_id, latest_message_id FROM sync_status').all<{ channel_id: string; latest_message_id: string }>();
  for (const row of statusRows.results || []) known.set(row.channel_id, row.latest_message_id || '');

  const forbidden = await readForbidden(env);
  const upToDate: string[] = [];
  const changed: Array<{ id: string; name: string; after: string; target: string }> = [];
  for (const c of Array.isArray(listed) ? listed : []) {
    if (![0, 5].includes(Number(c.type)) || !c.last_message_id || forbidden[c.id]) continue;
    let after = known.get(c.id) || '';
    if (!known.has(c.id)) {
      // 从没同步过的频道：从归档最后一条接着拉（只查一次，拉完就有 sync_status 了）
      // last_id 是 INTEGER 列，雪花 ID 超过 2^53，直接取会变成有损的 JS number
      const row = await env.DB.prepare('SELECT CAST(last_id AS TEXT) AS last_id FROM block_index WHERE channel = ? ORDER BY seq DESC LIMIT 1').bind(c.id).first<{ last_id: string }>();
      after = row?.last_id ? String(row.last_id) : '';
    }
    if (compareSnowflake(String(c.last_message_id), after) > 0) changed.push({ id: c.id, name: c.name, after, target: String(c.last_message_id) });
    else upToDate.push(c.id);
  }
  const priority = new Set((env.PRIORITY_CHANNEL_IDS || '').split(',').map((id) => id.trim()).filter(Boolean));
  changed.sort((a, b) => Number(priority.has(b.id)) - Number(priority.has(a.id)));

  try {
    await discoverThreads(env, Array.isArray(listed) ? listed : [], headers, forbidden);
  } catch (err: any) {
    console.warn('[CloudSync] 帖子列表跳过:', err.message);
  }
  // 帖子是否落后只看 D1（thread_meta 由 discoverThreads 更新），不用每轮都等发现到它；
  // 之前帖子排在频道后面，活跃频道每分钟占满 4 个名额，新帖一直轮不上
  const threadChanged: Array<{ id: string; name: string; after: string; target: string }> = [];
  const threadRows = (await env.DB.prepare(
    'SELECT t.id, t.name, t.last_message_id, s.latest_message_id AS synced, ' +
    '(SELECT CAST(last_id AS TEXT) FROM block_index b WHERE b.channel = t.id ORDER BY seq DESC LIMIT 1) AS archived_to ' +
    'FROM thread_meta t LEFT JOIN sync_status s ON s.channel_id = t.id'
  ).all<{ id: string; name: string; last_message_id: string; synced: string | null; archived_to: string | null }>()).results || [];
  for (const t of threadRows) {
    // 新帖子从头拉（帖子消息不多）；导出过的帖子从归档最后一条接着拉
    const after = t.synced || (t.archived_to ? String(t.archived_to) : '0');
    if (compareSnowflake(String(t.last_message_id), after) > 0) threadChanged.push({ id: t.id, name: t.name, after, target: String(t.last_message_id) });
    else upToDate.push(t.id);
  }
  // 每轮最多 MAX_CHANNEL_FETCHES_PER_RUN 次真正发出的请求；有帖子待拉时给帖子留 1 个，其余给频道（核心频道优先）。
  // 某个路由在避让中（本地拒绝、没发请求）就跳过它继续下一个；只有全局避让或 Discord 真的回 429 才结束本轮
  type Target = { id: string; name: string; after: string; target: string };
  let fetches = 0;
  let stop = false;
  const fetchOne = async (ch: Target): Promise<void> => {
    try {
      const apiUrl = new URL(`https://discord.com/api/v10/channels/${ch.id}/messages`);
      apiUrl.searchParams.set('limit', String(FETCH_LIMIT));
      if (ch.after) apiUrl.searchParams.set('after', ch.after);
      const resp = await discordFetch(env, apiUrl.toString(), { headers });
      fetches++;
      if (!resp.ok) {
        console.warn(`[CloudSync] 频道 #${ch.name} 获取失败: ${resp.status}`);
        if (resp.status === 403) await markForbidden(env, forbidden, ch.id);
        return;
      }
      const rawBatch: any[] = await resp.json();
      const batch = (Array.isArray(rawBatch) ? rawBatch : [])
        .filter((raw) => raw?.id && compareSnowflake(String(raw.id), ch.after) > 0)
        .sort((a, b) => compareSnowflake(String(a.id), String(b.id)));
      if (!batch.length) {
        // last_message_id 指向的消息已删除（或帖子是空的）：记下它，否则每分钟都会重新请求一次
        await env.DB.prepare(
          'INSERT INTO sync_status (channel_id, last_refreshed_at, latest_message_id) VALUES (?, ?, ?) ' +
          'ON CONFLICT(channel_id) DO UPDATE SET last_refreshed_at = excluded.last_refreshed_at, latest_message_id = MAX(sync_status.latest_message_id, excluded.latest_message_id)'
        ).bind(ch.id, Date.now(), ch.target).run();
        upToDate.push(ch.id);
        return;
      }
      const now = Date.now();
      const records = batch.map((raw) => toRecord(raw, ch.id));
      const maxId = records[records.length - 1].id;
      await env.DB.batch([
        ...records.map((r) => env.DB.prepare(
          'INSERT INTO message_cache (channel, message_id, created_at, payload, inserted_at) VALUES (?, ?, ?, ?, ?) ' +
          'ON CONFLICT(channel, message_id) DO UPDATE SET created_at = excluded.created_at, payload = excluded.payload'
        ).bind(r.channel_id, r.id, r.created_at, new TextEncoder().encode(JSON.stringify(r)), now)),
        env.DB.prepare(
          'INSERT INTO sync_status (channel_id, last_refreshed_at, latest_message_id) VALUES (?, ?, ?) ' +
          'ON CONFLICT(channel_id) DO UPDATE SET last_refreshed_at = excluded.last_refreshed_at, latest_message_id = MAX(sync_status.latest_message_id, excluded.latest_message_id)'
        ).bind(ch.id, now, maxId)
      ]);
      if (batch.length < FETCH_LIMIT) upToDate.push(ch.id);
      results.push({ id: ch.id, name: ch.name, count: records.length, max_id: maxId });
      console.log(`[CloudSync] 频道 #${ch.name} 写入 ${records.length} 条新消息 (最新 ID: ${maxId})`);
    } catch (err: any) {
      if (err instanceof DiscordRateLimited && !err.global) return; // 只是这个频道在避让（各频道的 bucket 互相独立），换下一个
      console.warn(`[CloudSync] 频道 #${ch.name} 同步中断:`, err.message);
      if (err.status === 429) stop = true;
    }
  };
  const reserve = threadChanged.length ? 1 : 0;
  for (const ch of changed) {
    if (stop || fetches >= MAX_CHANNEL_FETCHES_PER_RUN - reserve) break;
    await fetchOne(ch);
  }
  for (const ch of threadChanged) {
    if (stop || fetches >= MAX_CHANNEL_FETCHES_PER_RUN) break;
    await fetchOne(ch);
  }

  await env.DB.prepare(
    'INSERT INTO metadata (name, payload) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET payload = excluded.payload'
  ).bind('cron_heartbeat', JSON.stringify({ at: Date.now(), channels: upToDate })).run();
  return done();
}

export default {
  // 1. 每分钟自动由 Cloudflare Cron Trigger 触发 (100% 云端免维护)
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(syncAllChannels(env));
  },

  // 2. HTTP：只读状态。手动触发入口已去掉（之前任何人访问 /sync 都会立刻连打 Discord）
  async fetch(request: Request, env: Env): Promise<Response> {
    const rows = await env.DB.prepare(
      'SELECT channel_id, last_refreshed_at, latest_message_id FROM sync_status ORDER BY last_refreshed_at DESC LIMIT 20'
    ).all();
    const beat = await env.DB.prepare("SELECT payload FROM metadata WHERE name = 'cron_heartbeat'").first<{ payload: unknown }>();
    let heartbeat: unknown = null;
    try {
      heartbeat = beat ? JSON.parse(typeof beat.payload === 'string' ? beat.payload : new TextDecoder().decode(beat.payload as ArrayBuffer)) : null;
    } catch (_) {}

    return Response.json({
      service: 'sync-worker',
      schedule: '*/1 * * * *',
      heartbeat,
      discord_rate: await discordRateState(env),
      synced_channels: rows.results || []
    });
  }
};
