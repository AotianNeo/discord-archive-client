// 身份组列表：一次 GET /guilds/:id 拿到全部身份组和 features（渐变色、身份组图标要靠 features 打开），每 30 分钟刷新。
// 只同步能批量获取的：每个人的身份组和昵称由 scripts/backfill_members.mjs 走网关批量拉，这里不逐个请求成员
import { discordFetch } from '../../shared/discord-guard';
import { GUILD_ROLES_KEY } from '../../shared/roles';

const ROLES_REFRESH_MS = 30 * 60_000;

export async function syncRoles(env: { DB: D1Database; DISCORD_TOKEN: string; DISCORD_GUILD_ID: string }, headers: Record<string, string>): Promise<string> {
  const guildId = (env.DISCORD_GUILD_ID || '').trim();
  if (!env.DISCORD_TOKEN || !/^\d{15,22}$/.test(guildId)) return 'not configured';
  const row = await env.DB.prepare('SELECT payload FROM metadata WHERE name = ?').bind(GUILD_ROLES_KEY).first<{ payload: unknown }>();
  let fetchedAt = 0;
  try {
    fetchedAt = row ? Number(JSON.parse(typeof row.payload === 'string' ? row.payload : new TextDecoder().decode(row.payload as ArrayBuffer)).fetched_at) || 0 : 0;
  } catch (_) {}
  if (Date.now() - fetchedAt < ROLES_REFRESH_MS) return 'fresh';
  const resp = await discordFetch(env, `https://discord.com/api/v9/guilds/${guildId}`, { headers });
  if (!resp.ok) return `guild ${resp.status}`;
  const guild: any = await resp.json();
  const roles = Array.isArray(guild?.roles) ? guild.roles : [];
  if (!roles.length) return 'no roles';
  await env.DB.prepare(
    'INSERT INTO metadata (name, payload) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET payload = excluded.payload'
  ).bind(GUILD_ROLES_KEY, JSON.stringify({ roles, features: Array.isArray(guild.features) ? guild.features : [], fetched_at: Date.now() })).run();
  return `${roles.length} roles`;
}
