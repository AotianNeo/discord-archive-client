/**
 * 身份组和成员资料同步（单独的 Cron，和消息同步分开计 D1 查询数）：
 * - 每 30 分钟拉一次 GET /guilds/:id，存身份组和 features（渐变色、身份组图标要靠 features 打开）
 * - 每轮拉 PROFILES_PER_RUN 个成员：用户令牌用 /users/:id/profile?guild_id=（身份组、服务器内昵称/头像/横幅/简介/代词），
 *   机器人令牌没有资料接口，用 /guilds/:id/members/:id
 * 顺序：访客客户端要过、还没拉到的 > 从没拉过的发言者（发言多的优先）> 过期的（成员 7 天，已退出的 30 天）。
 * 队列走 member_meta 的 (due_at, wanted_at) 索引；发言者在刷新身份组时从 user_meta 补进来（INSERT OR IGNORE，每 30 分钟一次）
 */

import { DiscordRateLimited, discordFetch } from '../../shared/discord-guard';
import { GUILD_ROLES_KEY, ensureMemberTable } from '../../shared/members';

export interface MemberSyncEnv {
  DB: D1Database;
  DISCORD_TOKEN: string;
  DISCORD_GUILD_ID: string;
}

const ROLES_REFRESH_MS = 30 * 60_000;
const PROFILES_PER_RUN = 5;
const MEMBER_REFRESH_MS = 7 * 24 * 3600_000;
const LEFT_REFRESH_MS = 30 * 24 * 3600_000;

function text(payload: unknown): string {
  return typeof payload === 'string' ? payload : new TextDecoder().decode(payload as ArrayBuffer);
}

async function syncRoles(env: MemberSyncEnv, guildId: string, headers: Record<string, string>): Promise<string> {
  const row = await env.DB.prepare('SELECT payload FROM metadata WHERE name = ?').bind(GUILD_ROLES_KEY).first<{ payload: unknown }>();
  let fetchedAt = 0;
  try { fetchedAt = row ? Number(JSON.parse(text(row.payload)).fetched_at) || 0 : 0; } catch (_) {}
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

async function seedAuthors(env: MemberSyncEnv): Promise<void> {
  try {
    await env.DB.prepare('INSERT OR IGNORE INTO member_meta (user_id, due_at, wanted_at) SELECT id, 1, message_count FROM user_meta').run();
  } catch (_) {} // 没导入过 user_meta 的库：只靠访客要过的
}

async function memberQueue(env: MemberSyncEnv, limit: number): Promise<string[]> {
  const rows = await env.DB.prepare('SELECT user_id AS id FROM member_meta WHERE due_at <= ? ORDER BY due_at, wanted_at DESC LIMIT ?')
    .bind(Date.now(), limit).all<{ id: string }>();
  return (rows.results || []).map((row) => String(row.id));
}

// 资料接口的响应里去掉和令牌主人相关的（共同好友/服务器）、实验分组和小组件；guild_member.user 与 user 重复
function storedProfile(body: any): any {
  const { mutual_guilds, mutual_friends, mutual_friends_count, profile_themes_experiment_bucket, widgets, ...rest } = body || {};
  if (rest.guild_member) {
    const { user, unusual_dm_activity_until, ...member } = rest.guild_member;
    rest.guild_member = member;
  }
  return rest;
}

async function fetchMember(env: MemberSyncEnv, guildId: string, userId: string, headers: Record<string, string>, isBot: boolean):
  Promise<{ in_guild: number; nick: string | null; profile: any } | null> {
  const url = isBot
    ? `https://discord.com/api/v10/guilds/${guildId}/members/${userId}`
    : `https://discord.com/api/v9/users/${userId}/profile?with_mutual_guilds=false&with_mutual_friends=false&with_mutual_friends_count=false&guild_id=${guildId}`;
  const resp = await discordFetch(env, url, { headers });
  if (resp.status === 404) return { in_guild: 0, nick: null, profile: null }; // 已注销 / 不在服务器里（机器人令牌）
  if (!resp.ok) {
    console.warn(`[Members] ${userId} 资料获取失败: ${resp.status}`);
    return null;
  }
  const body: any = await resp.json();
  const profile = storedProfile(isBot ? { user: body.user, guild_member: body } : body);
  return { in_guild: profile.guild_member ? 1 : 0, nick: profile.guild_member?.nick ?? null, profile };
}

export async function syncMembers(env: MemberSyncEnv, headers: Record<string, string>): Promise<{ roles: string; profiles: number }> {
  const guildId = (env.DISCORD_GUILD_ID || '').trim();
  if (!env.DISCORD_TOKEN || !/^\d{15,22}$/.test(guildId)) return { roles: 'not configured', profiles: 0 };
  await ensureMemberTable(env.DB);
  let roles = '';
  try {
    roles = await syncRoles(env, guildId, headers);
  } catch (err: any) {
    roles = err.message;
    if (err instanceof DiscordRateLimited && err.global) return { roles, profiles: 0 };
  }
  if (roles !== 'fresh') await seedAuthors(env);
  const isBot = /^Bot\s/i.test(env.DISCORD_TOKEN);
  let profiles = 0;
  for (const userId of await memberQueue(env, PROFILES_PER_RUN)) {
    let result: Awaited<ReturnType<typeof fetchMember>>;
    try {
      result = await fetchMember(env, guildId, userId, headers, isBot);
    } catch (err: any) {
      console.warn('[Members] 本轮停止:', err.message);
      break; // 资料路由或全局在避让
    }
    if (!result) break; // 403 等：guard 已暂停该路由
    const now = Date.now();
    await env.DB.prepare(
      'INSERT INTO member_meta (user_id, in_guild, nick, profile, fetched_at, wanted_at, due_at) VALUES (?, ?, ?, ?, ?, 0, ?) ' +
      'ON CONFLICT(user_id) DO UPDATE SET in_guild = excluded.in_guild, nick = excluded.nick, profile = excluded.profile, ' +
      'fetched_at = excluded.fetched_at, wanted_at = 0, due_at = excluded.due_at'
    ).bind(userId, result.in_guild, result.nick, result.profile ? JSON.stringify(result.profile) : null, now,
      now + (result.in_guild ? MEMBER_REFRESH_MS : LEFT_REFRESH_MS)).run();
    profiles++;
  }
  return { roles, profiles };
}
