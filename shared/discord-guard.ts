// 所有对 discord.com/api 的请求都走 discordFetch。Pages Worker 和 sync-worker 共用 D1 表 discord_rate，
// 避让状态和预算跨实例、跨机房共享（之前各处直连 Discord，内存里的节流各管各的，429 之后下一分钟照样再打）。
// - 预算：全局每分钟 GLOBAL_PER_MINUTE 次，单路由每分钟 routeBudget(route) 次；超出时本地直接拒绝，不发到 Discord。
// - 响应头 X-RateLimit-Remaining=0：在 Reset-After 之前不再请求该路由，不等 429。
// - 429 按 retry_after 避让（global 时全局避让）；401 令牌失效，全局停 30 分钟；403 该路由停 10 分钟。
// - 10 分钟内 401/403/429 超过 INVALID_LIMIT 次，全局停 10 分钟（Discord 会封禁无效请求过多的来源）。
// - 同一实例内相邻请求至少间隔 MIN_GAP_MS。
// 被拒绝时抛出 status=429 的 DiscordRateLimited，调用方按原有的 429 分支处理。

export interface GuardEnv {
  DB: D1Database;
}

export class DiscordRateLimited extends Error {
  status = 429;
  retryAfter: number;
  global: boolean; // false = 只有这个路由在避让，调用方可以继续请求别的路由
  constructor(message: string, retryAfterSec: number, global = true) {
    super(message);
    this.retryAfter = Math.max(1, Math.ceil(retryAfterSec));
    this.global = global;
  }
}

const GLOBAL_PER_MINUTE = 40;
const ROUTE_PER_MINUTE: Record<string, number> = { search: 6, 'refresh-urls': 20, '/guilds/:id/channels': 4 };
const DEFAULT_ROUTE_PER_MINUTE = 12;
const INVALID_LIMIT = 30;
const MIN_GAP_MS = 350;

const tableReady = new WeakMap<D1Database, Promise<void>>();
let nextSlot = 0;

function ensureTable(env: GuardEnv): Promise<void> {
  let ready = tableReady.get(env.DB);
  if (!ready) {
    ready = env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS discord_rate (scope TEXT PRIMARY KEY, blocked_until INTEGER NOT NULL DEFAULT 0, ' +
      'window_start INTEGER NOT NULL DEFAULT 0, window_count INTEGER NOT NULL DEFAULT 0, note TEXT) WITHOUT ROWID'
    ).run().then(() => undefined, (err) => { tableReady.delete(env.DB); throw err; });
    tableReady.set(env.DB, ready);
  }
  return ready;
}

export function discordRoute(url: string): string {
  const path = new URL(url).pathname.replace(/^\/api\/v\d+/, '');
  if (/\/messages\/search$/.test(path)) return 'search';
  // 每个频道单独计：某个无权访问的频道 403 后，不能连带把论坛的帖子列表也停掉
  const threads = path.match(/^\/channels\/(\d+)\/threads\/search$/);
  if (threads) return `threads:${threads[1]}`;
  const channel = path.match(/^\/channels\/(\d+)\/messages/);
  if (channel) return `messages:${channel[1]}`;
  if (path === '/attachments/refresh-urls') return 'refresh-urls';
  return path.replace(/\d{15,22}/g, ':id');
}

function routeBudget(route: string): number {
  return ROUTE_PER_MINUTE[route] ?? DEFAULT_ROUTE_PER_MINUTE;
}

function countStatement(env: GuardEnv, scope: string, window: number) {
  return env.DB.prepare(
    'INSERT INTO discord_rate (scope, window_start, window_count) VALUES (?, ?, 1) ON CONFLICT(scope) DO UPDATE SET ' +
    'window_count = CASE WHEN window_start = excluded.window_start THEN window_count + 1 ELSE 1 END, window_start = excluded.window_start ' +
    'RETURNING blocked_until, window_count'
  ).bind(scope, window);
}

async function block(env: GuardEnv, scope: string, until: number, note: string): Promise<void> {
  console.warn(`[DiscordGuard] ${scope} 暂停到 ${new Date(until).toISOString()}: ${note}`);
  await env.DB.prepare(
    'INSERT INTO discord_rate (scope, blocked_until, note) VALUES (?, ?, ?) ON CONFLICT(scope) DO UPDATE SET ' +
    'blocked_until = MAX(blocked_until, excluded.blocked_until), note = excluded.note'
  ).bind(scope, until, note).run();
}

async function countInvalid(env: GuardEnv, now: number): Promise<void> {
  const row = await countStatement(env, 'invalid', Math.floor(now / 600_000)).first<{ window_count: number }>();
  if ((row?.window_count || 0) > INVALID_LIMIT) {
    await block(env, 'global', now + 600_000, `10 分钟内 ${row!.window_count} 次 401/403/429`);
  }
}

async function admit(env: GuardEnv, route: string): Promise<void> {
  await ensureTable(env);
  const now = Date.now();
  const minute = Math.floor(now / 60_000);
  const [global, perRoute] = (await env.DB.batch<{ blocked_until: number; window_count: number }>([
    countStatement(env, 'global', minute),
    countStatement(env, `route:${route}`, minute)
  ])).map((r) => r.results?.[0]);
  const blockedUntil = Math.max(global?.blocked_until || 0, perRoute?.blocked_until || 0);
  if (blockedUntil > now) {
    throw new DiscordRateLimited(`Discord 请求避让中（${route}），${Math.ceil((blockedUntil - now) / 1000)} 秒后恢复`, (blockedUntil - now) / 1000,
      (global?.blocked_until || 0) > now);
  }
  const untilNextMinute = ((minute + 1) * 60_000 - now) / 1000;
  if ((global?.window_count || 0) > GLOBAL_PER_MINUTE) {
    throw new DiscordRateLimited(`Discord 全局请求预算已用完（每分钟 ${GLOBAL_PER_MINUTE} 次）`, untilNextMinute);
  }
  if ((perRoute?.window_count || 0) > routeBudget(route)) {
    throw new DiscordRateLimited(`Discord 请求预算已用完（${route} 每分钟 ${routeBudget(route)} 次）`, untilNextMinute, false);
  }
  // 同一实例内排队错开，并发调用（Promise.all）也不会同时发出
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + MIN_GAP_MS + Math.floor(Math.random() * 150);
  if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
}

export async function discordFetch(env: GuardEnv, url: string, init: RequestInit = {}): Promise<Response> {
  const route = discordRoute(url);
  try {
    await admit(env, route);
  } catch (err) {
    // 只差几秒（bucket 重置、分钟窗口切换）就等一下再试一次
    if (!(err instanceof DiscordRateLimited) || err.retryAfter > 3) throw err;
    await new Promise((r) => setTimeout(r, err.retryAfter * 1000));
    await admit(env, route);
  }
  const response = await fetch(url, init);
  const now = Date.now();
  try {
    if (response.status === 429) {
      const body: any = await response.clone().json().catch(() => ({}));
      const retryAfter = Number(body.retry_after ?? response.headers.get('retry-after') ?? 5) || 5;
      const isGlobal = body.global === true || response.headers.get('x-ratelimit-global') === 'true';
      await block(env, isGlobal ? 'global' : `route:${route}`, now + retryAfter * 1000 + 1000 + Math.floor(Math.random() * 2000), `429 retry_after=${retryAfter}`);
      await countInvalid(env, now);
      throw new DiscordRateLimited(`Discord 官方频率限制: 需等待 ${Math.ceil(retryAfter)} 秒`, retryAfter + 1, isGlobal);
    }
    if (response.status === 401) {
      await block(env, 'global', now + 30 * 60_000, '401：DISCORD_TOKEN 被拒绝（失效或已更换）');
      await countInvalid(env, now);
    } else if (response.status === 403) {
      await block(env, `route:${route}`, now + 10 * 60_000, '403：无权访问');
      await countInvalid(env, now);
    } else if (response.headers.get('x-ratelimit-remaining') === '0') {
      const resetAfter = Number(response.headers.get('x-ratelimit-reset-after') || 1);
      await block(env, `route:${route}`, now + resetAfter * 1000 + 250, 'bucket 用完，等待重置');
    }
  } catch (err) {
    if (err instanceof DiscordRateLimited) throw err;
    console.warn('[DiscordGuard] 记录限频状态失败:', err);
  }
  return response;
}

export async function discordRateState(env: GuardEnv): Promise<unknown[]> {
  try {
    await ensureTable(env);
    const rows = await env.DB.prepare(
      'SELECT scope, blocked_until, window_start, window_count, note FROM discord_rate ORDER BY blocked_until DESC LIMIT 30'
    ).all();
    return rows.results || [];
  } catch (_) {
    return [];
  }
}
