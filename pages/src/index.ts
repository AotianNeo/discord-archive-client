import { decompress } from 'fzstd';
import { Deflate } from 'pako';
import { discordFetch } from '../../shared/discord-guard';
import { ArchiveSnapshot, MESSAGE_REFERENCE_FORWARD, isForward, snapshotsFromDiscord } from '../../shared/message-snapshots';
import guildExperiments from './experiments/guild_experiments.json';
import userExperiments from './experiments/user_experiments.json';
import apexExperiments from './experiments/apex_experiments.json';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  MEDIA?: R2Bucket;
  DISCORD_GUILD_ID: string;   // 归档的服务器 ID（必填）
  ACCESS_PASSWORD?: string;   // 站点访问口令；未设置时整站拒绝访问，除非 PUBLIC_ACCESS = "true"
  PUBLIC_ACCESS?: string;     // "true" = 不设口令，任何人可访问
  GUILD_NAME?: string;        // 官方界面里显示的服务器名
  GUILD_ICON?: string;        // 服务器图标哈希（可选，/icons/<guild>/<hash>.png 回源 Discord CDN）
  GUILD_OWNER_ID?: string;    // 服务器所有者 ID（可选，用于"服主"标记）
  HOME_CHANNEL_ID?: string;   // 登录后落地的频道（可选，默认第一个文字频道）
  VISITOR_NAME?: string;      // 访客在官方界面里的名字
  LOCALE?: string;            // 官方界面语言，例如 en-US、zh-CN（默认 en-US）
  COUNTRY_CODE?: string;      // 计费/地区相关端点返回的国家代码（默认 US）
  DISCORD_TOKEN?: string;     // 可选：用于实时同步、搜索、附件链接续签（secret）
  ORIGIN_URL?: string;        // 可选：本地/隧道媒体源，静态资源缺失时回源
  GATEWAY?: DurableObjectNamespace; // 可选：sync-worker 的 DiscordGateway（REALTIME_GATEWAY），新消息实时推给访客
}

// 运行时配置：每个请求开始时由 configure(env) 写入（同一 Worker 的 env 不变）
let GUILD_ID = '';
let GUILD_NAME = 'Discord Archive';
let GUILD_ICON: string | null = null;
let GUILD_OWNER_ID = '0';
let VISITOR_NAME = 'Visitor';
let LOCALE = 'en-US';
let COUNTRY_CODE = 'US';

function configure(env: Env): void {
  GUILD_ID = (env.DISCORD_GUILD_ID || '').trim();
  GUILD_NAME = (env.GUILD_NAME || '').trim() || 'Discord Archive';
  GUILD_ICON = (env.GUILD_ICON || '').trim() || null;
  GUILD_OWNER_ID = (env.GUILD_OWNER_ID || '').trim() || '0';
  VISITOR_NAME = (env.VISITOR_NAME || '').trim() || 'Visitor';
  LOCALE = (env.LOCALE || '').trim() || 'en-US';
  COUNTRY_CODE = (env.COUNTRY_CODE || '').trim().toUpperCase() || 'US';
}

const MEDIA_RESET_COOKIE = 'media_reset';
const MEDIA_RESET_VERSION = '20261018-avatar-size';
const AUTH_COOKIE = 'archive_auth';
// 官方客户端以这个"访客"身份登录（假用户，不对应任何真实账号）。shell 写入 localStorage 的令牌首段 = base64(VISITOR_USER_ID)，
// 见 scripts/fetch-client.mjs；令牌只用来让客户端进入已登录状态，访问控制靠站点口令 cookie
const VISITOR_USER_ID = '100000000000000001';

// 登录后和 / 的落点：HOME_CHANNEL_ID，否则频道元数据里第一个文字频道
async function officialHome(env: Env): Promise<string> {
  let channel = (env.HOME_CHANNEL_ID || '').trim();
  if (!channel) {
    for (const group of await readChannelMetadata(env)) {
      const first = (group.channels || []).find((c: any) => Number(c.type ?? 0) === 0);
      if (first) { channel = first.id; break; }
    }
  }
  return channel ? `/channels/${GUILD_ID}/${channel}` : `/channels/${GUILD_ID}`;
}
const loginFailures = new Map<string, { count: number; resetAt: number }>();

interface Message {
  id: string;
  channel_id: string;
  channel_name?: string;
  author_id: string;
  author: string;
  username: string;
  avatar?: string;
  color?: string;
  content: string;
  created_at: string;
  owner: boolean;
  reply_author?: string;
  reply_content?: string;
  reply_channel_id?: string;
  reply_message_id?: string;
  attachments?: Attachment[];
  embeds?: Array<{ title: string; description: string; url: string; footer: string }>;
  stickers?: Array<{ id: string; name: string; format_type: number; url?: string }>;
  message_type?: number;
  is_bot?: boolean;
  system_text?: string;
  remote?: boolean;
  reply_author_id?: string;
  reply_author_avatar?: string;
  mention_users?: any[];
  snapshots?: ArchiveSnapshot[];
}

interface Attachment {
  id?: string;
  filename: string;
  url: string;
  content_type?: string;
  size?: number;
  width?: number;
  height?: number;
}

function toUint8Array(val: unknown): Uint8Array {
  if (val instanceof Uint8Array) return val;
  if (val instanceof ArrayBuffer) return new Uint8Array(val);
  if (Array.isArray(val)) return new Uint8Array(val);
  if (typeof val === 'string') return new TextEncoder().encode(val);
  if (typeof val === 'object' && val !== null) {
    const obj = val as Record<string, unknown>;
    if (obj.data && Array.isArray(obj.data)) {
      return new Uint8Array(obj.data);
    }
    return new Uint8Array(Object.values(obj) as number[]);
  }
  throw new Error(`无法解析的 Blob 格式: ${typeof val}`);
}

function unpack(payload: unknown): any {
  if (typeof payload === 'string') {
    try {
      return JSON.parse(payload);
    } catch {
      // 继续尝试二进制解码
    }
  }
  const bytes = toUint8Array(payload);
  // 判断 zstd 魔数: 0xFD2FB528 (little endian: 0x28, 0xB5, 0x2F, 0xFD)
  if (bytes.length >= 4 && bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) {
    const decompressed = decompress(bytes);
    const jsonStr = new TextDecoder().decode(decompressed);
    return JSON.parse(jsonStr);
  }
  try {
    const jsonStr = new TextDecoder().decode(bytes);
    return JSON.parse(jsonStr);
  } catch {
    const decompressed = decompress(bytes);
    const jsonStr = new TextDecoder().decode(decompressed);
    return JSON.parse(jsonStr);
  }
}

interface ChannelMeta {
  id: string;
  name: string;
  count: number;
  type: number;
}

interface ChannelGroup {
  id: string;
  name: string;
  channels: ChannelMeta[];
}

async function readChannelMetadata(env: Env): Promise<ChannelGroup[]> {
  const row = await env.DB.prepare('SELECT payload FROM metadata WHERE name = ?')
    .bind('channels')
    .first<{ payload: unknown }>();
  if (!row?.payload) return [];
  const data = unpack(row.payload);
  return Array.isArray(data) ? data : [];
}

function lower(text: string): string {
  return text.toLowerCase();
}

function searchText(m: Message): string {
  const parts = [m.content || '', m.author || '', m.username || ''];
  let snapshots = '';
  for (const s of m.snapshots || []) {
    snapshots += ' ' + (s.content || '');
    for (const e of s.embeds || []) {
      snapshots += ' ' + (e.title || '') + ' ' + (e.description || '');
    }
  }
  return lower(parts.join(' ') + ' ' + snapshots);
}

let messageCacheReady = false;
let messageCachePromise: Promise<void> | null = null;

async function ensureMessageCache(env: Env): Promise<void> {
  if (messageCacheReady) return;
  if (!messageCachePromise) {
    messageCachePromise = env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS message_cache(' +
      'channel TEXT NOT NULL, message_id TEXT NOT NULL, created_at TEXT NOT NULL, payload BLOB NOT NULL, ' +
      'inserted_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(channel, message_id)) WITHOUT ROWID'
    ).run().then(() => {
      messageCacheReady = true;
    }).finally(() => {
      messageCachePromise = null;
    });
  }
  return messageCachePromise;
}

// Discord API 的 sticker_items → 归档格式（与本地导出的 stickers 字段一致，静态文件缺失时 /stickers/ 会回源 Discord CDN）
function stickersFromDiscord(raw: any): any[] {
  return (raw?.sticker_items || []).map((st: any) => ({
    id: String(st.id),
    name: st.name || 'sticker',
    format_type: Number(st.format_type) || 1,
    url: `/stickers/${st.id}.${Number(st.format_type) === 3 ? 'json' : Number(st.format_type) === 4 ? 'gif' : 'png'}`
  }));
}

function normalizeDiscordMessage(raw: any, channelId: string): Message | null {
  if (!raw?.id) return null;
  if (raw.created_at && typeof raw.owner === 'boolean') {
    return { ...raw, channel_id: raw.channel_id || channelId };
  }

  const author = raw.author && typeof raw.author === 'object' ? raw.author : {};
  const authorId = String(author.id || raw.author_id || '');
  const authorName = author.global_name || author.username || raw.author || '用户';
  const atts = (Array.isArray(raw.attachments) ? raw.attachments : []).map((a: any) => ({
    id: a.id ? String(a.id) : undefined,
    filename: a.filename || '附件',
    url: a.url || a.proxy_url || `/attachments/${raw.id}_${a.id}.bin`,
    content_type: a.content_type || 'application/octet-stream',
    size: a.size || 0,
    width: a.width,
    height: a.height
  }));
  const ems = (Array.isArray(raw.embeds) ? raw.embeds : []).map((e: any) => ({
    title: e.title || '',
    description: e.description || '',
    url: e.url || '',
    footer: e.footer?.text || ''
  }));

  return {
    id: String(raw.id),
    channel_id: String(raw.channel_id || channelId),
    author_id: authorId,
    author: authorName,
    username: author.username || authorName,
    avatar: author.avatar
      ? `https://cdn.discordapp.com/avatars/${authorId}/${author.avatar}.webp?size=64`
      : (raw.avatar || ''),
    content: raw.content || '',
    created_at: raw.timestamp || raw.created_at || new Date().toISOString(),
    owner: authorId === GUILD_OWNER_ID,
    ...(isForward(raw) ? { snapshots: snapshotsFromDiscord(raw) } : {
      reply_author: raw.referenced_message?.author?.global_name || raw.referenced_message?.author?.username,
      reply_author_id: raw.referenced_message?.author?.id,
      reply_content: raw.referenced_message?.content,
      reply_channel_id: raw.message_reference?.channel_id,
      reply_message_id: raw.message_reference?.message_id
    }),
    attachments: atts,
    embeds: ems,
    stickers: stickersFromDiscord(raw),
    message_type: Number(raw.type || 0)
  };
}

function uniqueSortedMessages(messages: Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const message of messages) {
    if (message?.id && !byId.has(message.id)) byId.set(message.id, message);
  }
  return [...byId.values()].sort((a, b) => a.id === b.id ? 0 : (a.id < b.id ? -1 : 1));
}

async function discordJson(url: string, env: Env): Promise<any> {
  if (!env.DISCORD_TOKEN) throw new Error('DISCORD_TOKEN 未配置');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);
  let response: Response;
  try {
    response = await discordFetch(env, url, {
      signal: controller.signal,
      headers: {
        Authorization: env.DISCORD_TOKEN,
        Accept: 'application/json',
        'User-Agent': 'Discord-Archive-Client/1.0'
      }
    });
  } finally {
    clearTimeout(timeout);
  }
  if (response.status === 429) {
    const data: any = await response.json().catch(() => ({}));
    const error: any = new Error(`Discord 官方频率限制: 需等待 ${data.retry_after || 5} 秒`);
    error.status = 429;
    error.retryAfter = Number(data.retry_after || 5);
    throw error;
  }
  if (!response.ok) {
    const error: any = new Error(`Discord API 异常 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function searchResultMessages(data: any, channelId: string): Message[] {
  const users = new Map<string, any>(
    (Array.isArray(data?.users) ? data.users : []).map((user: any) => [String(user.id), user])
  );
  const rawResults: any[] = [];
  for (const item of (Array.isArray(data?.messages) ? data.messages : [])) {
    const raw = Array.isArray(item) ? item[0] : item;
    if (!raw) continue;
    rawResults.push(raw.author ? raw : { ...raw, author: users.get(String(raw.author_id)) });
  }
  return uniqueSortedMessages(rawResults
    .map((raw) => normalizeDiscordMessage(raw, channelId))
    .filter((message): message is Message => Boolean(message)));
}

async function searchArchivedGuildMessages(query: string, env: Env, limit: number, channelId?: string): Promise<Message[]> {
  const [channelGroups, rows] = await Promise.all([
    readChannelMetadata(env),
    // ponytail: bounded recent-block scan; add FTS only when full-history local search is required.
    channelId
      ? env.DB.prepare('SELECT channel, payload FROM blocks WHERE channel = ? ORDER BY seq DESC LIMIT 128').bind(channelId)
        .all<{ channel: string; payload: unknown }>()
      : env.DB.prepare('SELECT channel, payload FROM blocks ORDER BY channel, seq DESC LIMIT 128')
        .all<{ channel: string; payload: unknown }>()
  ]);
  const channelNames = new Map<string, string>();
  for (const group of channelGroups) {
    for (const channel of group.channels || []) channelNames.set(channel.id, channel.name);
  }
  const matches: Message[] = [];
  for (const row of rows.results || []) {
    let messages: Message[] = [];
    try { messages = unpack(row.payload) as Message[]; } catch (_) { continue; }
    for (const message of messages) {
      if (!message?.id || !searchText(message).includes(query)) continue;
      matches.push({ ...message, channel_name: message.channel_name || channelNames.get(row.channel) || '未知频道' });
    }
  }
  return uniqueSortedMessages(matches).slice(-limit);
}

async function computeAuthToken(password: string): Promise<string> {
  const enc = new TextEncoder().encode(password + ':discord-archive-client');
  const digest = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function parseCookies(cookieHeader: string | null): Record<string, string> {
  const list: Record<string, string> = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach((cookie) => {
    const parts = cookie.split('=');
    const name = parts.shift()?.trim();
    if (!name) return;
    try {
      list[name] = decodeURIComponent(parts.join('='));
    } catch {
      list[name] = parts.join('=');
    }
  });
  return list;
}

function applySecurityHeaders(headers: Headers): Headers {
  headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'self' blob:; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; img-src 'self' https://cdn.discordapp.com https://media.discordapp.net https://*.discordapp.net data: blob:; media-src 'self' https://cdn.discordapp.com https://media.discordapp.net blob:; connect-src 'self' wss: ws: https://discord.com https://canary.discord.com https://cdn.discordapp.com https://media.discordapp.net https://*.pages.dev; style-src 'self' 'unsafe-inline' https://discord.com; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://discord.com https://cdn.discordapp.com; font-src 'self' https://discord.com https://cdn.discordapp.com data:; worker-src 'self' blob:;");
  return headers;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function renderLoginPage(error = ''): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex, nofollow, noarchive, nosnippet">
  <title>${escapeHtml(GUILD_NAME)} · 访问验证 / Sign in</title>
  <style>
    body {
      margin: 0; padding: 0; min-height: 100vh;
      background: #313338; color: #dbdee1;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      display: flex; align-items: center; justify-content: center;
    }
    .card {
      background: #2b2d31; border-radius: 8px; padding: 32px; width: 100%; max-width: 400px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.3); text-align: center;
    }
    .logo {
      width: 48px; height: 48px; background: #5865f2; border-radius: 16px;
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto 16px; font-weight: bold; font-size: 24px; color: white;
    }
    h2 { margin: 0 0 8px; font-size: 20px; color: #f2f3f5; }
    p { margin: 0 0 24px; font-size: 13px; color: #949ba4; }
    input[type="password"] {
      width: 100%; box-sizing: border-box; padding: 12px; border-radius: 4px;
      border: none; background: #1e1f22; color: #f2f3f5; font-size: 15px;
      margin-bottom: 16px; outline: none;
    }
    input[type="password"]:focus { box-shadow: 0 0 0 2px #5865f2; }
    button {
      width: 100%; padding: 12px; border-radius: 4px; border: none;
      background: #5865f2; color: white; font-size: 15px; font-weight: 500;
      cursor: pointer; transition: background 0.15s;
    }
    button:hover { background: #4752c4; }
    .error { color: #f23f43; font-size: 13px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">${escapeHtml(GUILD_NAME.slice(0, 1).toUpperCase())}</div>
    <h2>${escapeHtml(GUILD_NAME)}</h2>
    <p>该归档需要访问口令 · This archive is password protected</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    <form method="POST" action="/api/auth/login">
      <input type="password" name="password" placeholder="访问口令 / Password" autofocus required>
      <button type="submit">进入 / Enter</button>
    </form>
  </div>
</body>
</html>`;
}

const SYNC_PAGE_SIZE = 100;
const SYNC_MAX_PAGES = 5;
// 访客触发的增量同步冷却。sync-worker 每分钟把所有有新消息的频道同步一遍并刷新 last_refreshed_at，
// 冷却比 cron 间隔长，访客打开频道时就不会再额外请求 Discord（只有子区和 cron 停摆时才会触发）
const SYNC_COOLDOWN_MS = 90_000;

function maxSnowflake(a = '', b = ''): string {
  if (!a) return b;
  if (!b) return a;
  return a.length === b.length ? (a > b ? a : b) : (a.length > b.length ? a : b);
}

const ATTACHMENT_PROXY_PREFIX = '/attachments/cache/';
const MEDIA_CACHE_VERSION = 'media-v5';
const ATTACHMENT_HOSTS = new Set([
  'cdn.discordapp.com',
  'media.discordapp.net',
  'images-ext-1.discordapp.net',
  'images-ext-2.discordapp.net'
]);

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function attachmentSource(value: unknown): string {
  if (typeof value !== 'string' || !/^https:\/\//i.test(value)) return '';
  try {
    const parsed = new URL(value);
    return ATTACHMENT_HOSTS.has(parsed.hostname.toLowerCase()) ? parsed.toString() : '';
  } catch {
    return '';
  }
}

interface AttachmentDescriptor {
  version?: string;
  source?: string;
  channelId?: string;
  messageId?: string;
  attachmentId?: string;
  localPath?: string;
}

function attachmentIdFromUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  try {
    const path = new URL(value, 'https://local.invalid').pathname;
    return path.match(/\/attachments\/\d{15,22}\/(\d{15,22})\//)?.[1] || '';
  } catch {
    return '';
  }
}

function safeLocalMediaPath(value: unknown): string {
  if (typeof value !== 'string' || !/^\/(?:snapshot-)?attachments\/|^\/avatars\//.test(value)) return '';
  try {
    const path = new URL(value, 'https://local.invalid').pathname;
    const parts = path.split('/').filter(Boolean);
    if (!parts.length || !['attachments', 'snapshot-attachments', 'avatars'].includes(parts[0]) || parts.includes('..') || parts.includes('.')) return '';
    return `/${parts.join('/')}`;
  } catch {
    return '';
  }
}

function attachmentExtension(value: unknown): string {
  if (typeof value !== 'string') return '.bin';
  try {
    const name = decodeURIComponent(new URL(value, 'https://local.invalid').pathname.split('/').pop() || '');
    const match = name.match(/\.[a-z0-9]{1,12}$/i);
    return match ? match[0].toLowerCase() : '.bin';
  } catch {
    return '.bin';
  }
}

function attachmentLocalPath(value: unknown, messageId: string, attachmentId: string): string {
  const existing = safeLocalMediaPath(value);
  if (existing) return existing;
  if (!messageId || !attachmentId || !/^\d{15,22}$/.test(messageId) || !/^\d{15,22}$/.test(attachmentId)) return '';
  return `/attachments/${messageId}_${attachmentId}${attachmentExtension(value)}`;
}

function attachmentProxyUrl(
  value: unknown,
  messageId = '',
  channelId = '',
  attachmentId = '',
  localPath = ''
): string {
  const source = attachmentSource(value);
  const descriptor: AttachmentDescriptor = {
    version: MEDIA_CACHE_VERSION,
    ...(channelId ? { channelId } : {}),
    ...(messageId ? { messageId } : {}),
    ...(attachmentId ? { attachmentId } : {}),
    ...(localPath ? { localPath } : {})
  };
  return source || descriptor.localPath
    ? `${ATTACHMENT_PROXY_PREFIX}${base64UrlEncode(JSON.stringify(descriptor))}`
    : String(value || '');
}

function localAttachmentId(value: unknown, messageId: string): string {
  if (typeof value !== 'string' || !messageId || !/^\/(?:snapshot-)?attachments\//.test(value)) return '';
  try {
    const pathname = new URL(value, 'https://local.invalid').pathname;
    const filename = decodeURIComponent(pathname.split('/').pop() || '');
    const stem = filename.replace(/\.[^.]*$/, '');
    const prefix = `${messageId}_`;
    if (!stem.startsWith(prefix)) return '';
    const pieces = stem.slice(prefix.length).split('_');
    for (let i = pieces.length - 1; i >= 0; i--) {
      if (/^\d{15,22}$/.test(pieces[i])) return pieces[i];
    }
  } catch (_) {}
  return '';
}

function legacyAttachmentUrl(value: unknown, messageId: string, channelId: string): string {
  const attachmentId = localAttachmentId(value, messageId);
  if (!attachmentId || typeof value !== 'string') return String(value || '');
  const descriptor = base64UrlEncode(JSON.stringify({ channelId, messageId, attachmentId }));
  return `${value}${value.includes('?') ? '&' : '?'}r=${descriptor}`;
}

function localizedAttachmentUrl(value: unknown, messageId: string, channelId: string, attachment: any): string {
  let sourceValue = value;
  let previous: AttachmentDescriptor = {};
  if (typeof value === 'string' && value.startsWith(ATTACHMENT_PROXY_PREFIX)) {
    try {
      previous = decodeAttachmentDescriptor(value.slice(ATTACHMENT_PROXY_PREFIX.length));
      sourceValue = previous.source || previous.localPath || '';
    } catch (_) {}
  }
  const attachmentId = String(attachment?.id || previous.attachmentId || attachmentIdFromUrl(sourceValue) || localAttachmentId(sourceValue, messageId) || '');
  const localPath = attachmentLocalPath(previous.localPath || sourceValue, messageId, attachmentId);
  const localized = attachmentProxyUrl(previous.source || sourceValue, messageId, channelId, attachmentId, localPath);
  return localized === String(value || '') ? legacyAttachmentUrl(value, messageId, channelId) : localized;
}

// 归档导出把附件压成 [filename, url, content_type]；按对象读取会得到空链接，统一还原
function normalizeAttachment(attachment: any): any {
  if (!Array.isArray(attachment)) return attachment;
  const [filename, url, contentType] = attachment;
  return {
    id: attachmentIdFromUrl(url),
    filename: filename || '附件',
    url: url || '',
    content_type: contentType || 'application/octet-stream'
  };
}

// 去掉签名参数的 CDN 原始地址：refresh-urls 接受它并返回新的签名链接
function canonicalAttachmentSource(value: unknown): string {
  if (typeof value !== 'string' || !/^https:\/\//i.test(value)) return '';
  try {
    const parsed = new URL(value);
    if (!ATTACHMENT_HOSTS.has(parsed.hostname.toLowerCase()) || !/^\/attachments\/\d{15,22}\/\d{15,22}\//.test(parsed.pathname)) return '';
    return `https://cdn.discordapp.com${parsed.pathname}`;
  } catch {
    return '';
  }
}

// Discord 附件签名约 24 小时过期：批量换新签名（每次最多 50 个），结果写回 attachment_meta 供所有边缘节点复用
async function refreshAttachmentUrls(env: Env, items: Array<{ id: string; source: string }>): Promise<Map<string, string>> {
  const fresh = new Map<string, string>();
  if (!env.DISCORD_TOKEN) return fresh;
  for (let i = 0; i < items.length; i += 50) {
    const chunk = items.slice(i, i + 50);
    try {
      const resp = await discordFetch(env, 'https://discord.com/api/v9/attachments/refresh-urls', {
        method: 'POST',
        headers: {
          Authorization: env.DISCORD_TOKEN,
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
        },
        body: JSON.stringify({ attachment_urls: chunk.map((item) => item.source) }),
        signal: AbortSignal.timeout(5000)
      });
      if (!resp.ok) {
        console.warn(`[Media] refresh-urls 返回 ${resp.status}`);
        break;
      }
      const data: any = await resp.json();
      const idBySource = new Map(chunk.map((item) => [item.source, item.id]));
      const statements: D1PreparedStatement[] = [];
      for (const row of data?.refreshed_urls || []) {
        const id = idBySource.get(row?.original) || attachmentIdFromUrl(row?.original);
        if (!id || typeof row?.refreshed !== 'string') continue;
        const expiresAt = (Number.parseInt(new URL(row.refreshed).searchParams.get('ex') || '0', 16) * 1000) || Date.now() + 12 * 3_600_000;
        fresh.set(id, row.refreshed);
        statements.push(env.DB.prepare('UPDATE attachment_meta SET fresh_url = ?, fresh_expires = ? WHERE id = ?').bind(row.refreshed, expiresAt, id));
      }
      if (statements.length) await env.DB.batch(statements);
    } catch (err) {
      console.warn('[Media] refresh-urls 调用失败:', err);
      break;
    }
  }
  return fresh;
}

// 列表接口返回前：补齐宽高/大小（官方客户端据此内联显示图片），并为签名将过期的附件预先批量换链
// 转发消息的内容：D1 块导出时丢了 message_snapshots，块里只剩指向原消息的 reply_* 字段，两个界面都显示成空白消息。
// 表 snapshot_meta 由 scripts/build_snapshot_meta.py 从 ../raw 生成；转发没有正文和附件，只查这类消息
async function hydrateSnapshots(env: Env, messages: Message[]): Promise<void> {
  const ids = messages
    .filter((m) => !m.snapshots?.length && m.reply_message_id && !m.content && !m.attachments?.length && !m.stickers?.length)
    .map((m) => m.id);
  if (!ids.length) return;
  const found = new Map<string, ArchiveSnapshot[]>();
  try {
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      const rows = await env.DB.prepare(`SELECT message_id, payload FROM snapshot_meta WHERE message_id IN (${chunk.map(() => '?').join(',')})`)
        .bind(...chunk).all<{ message_id: string; payload: string }>();
      for (const row of rows.results || []) found.set(row.message_id, JSON.parse(row.payload));
    }
  } catch (_) {
    return; // snapshot_meta 尚未建表
  }
  for (const message of messages) {
    const snapshots = found.get(message.id);
    if (snapshots) message.snapshots = snapshots;
  }
}

async function hydrateAttachments(env: Env, messages: Message[]): Promise<Message[]> {
  await hydrateSnapshots(env, messages);
  const byId = new Map<string, any[]>();
  const collect = (list: any[] | undefined): any[] => (list || []).map((raw) => {
    const attachment = normalizeAttachment(raw);
    const id = String(attachment?.id || attachmentIdFromUrl(attachment?.url) || '');
    if (/^\d{15,22}$/.test(id)) {
      attachment.id = id;
      byId.set(id, [...(byId.get(id) || []), attachment]);
    }
    return attachment;
  });
  for (const message of messages) {
    message.attachments = collect(message.attachments);
    for (const snapshot of message.snapshots || []) snapshot.attachments = collect(snapshot.attachments);
  }
  if (!byId.size) return messages;

  const ids = [...byId.keys()];
  const known = new Map<string, { source: string; size: number | null; width: number | null; height: number | null; fresh_expires: number }>();
  try {
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      const rows = await env.DB.prepare(
        `SELECT id, source, size, width, height, fresh_expires FROM attachment_meta WHERE id IN (${chunk.map(() => '?').join(',')})`
      ).bind(...chunk).all<any>();
      for (const row of rows.results || []) known.set(String(row.id), row);
    }
  } catch (_) {
    return messages; // attachment_meta 尚未建表
  }

  const now = Date.now();
  const inserts: D1PreparedStatement[] = [];
  const stale: Array<{ id: string; source: string }> = [];
  for (const [id, list] of byId) {
    const meta = known.get(id);
    for (const attachment of list) {
      if (meta) {
        attachment.size ??= meta.size ?? undefined;
        attachment.width ??= meta.width ?? undefined;
        attachment.height ??= meta.height ?? undefined;
      }
    }
    const first = list[0];
    const source = meta?.source || canonicalAttachmentSource(first.url);
    if (!source) continue;
    if (!meta) {
      inserts.push(env.DB.prepare(
        'INSERT OR IGNORE INTO attachment_meta (id, source, filename, content_type, size, width, height) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(id, source, first.filename || '附件', first.content_type || 'application/octet-stream', first.size ?? null, first.width ?? null, first.height ?? null));
    }
    if (!meta || meta.fresh_expires < now + 10 * 60_000) stale.push({ id, source });
  }
  try {
    if (inserts.length) await env.DB.batch(inserts);
    if (stale.length) await refreshAttachmentUrls(env, stale.slice(0, 100));
  } catch (err) {
    console.warn('[Media] 附件元数据预取失败:', err);
  }
  return messages;
}

// 单个附件请求：优先用未过期的新签名，否则按原始地址现场换链
async function freshAttachmentUrl(env: Env, attachmentId: string): Promise<string> {
  if (!/^\d{15,22}$/.test(attachmentId)) return '';
  try {
    const row = await env.DB.prepare('SELECT source, fresh_url, fresh_expires FROM attachment_meta WHERE id = ?')
      .bind(attachmentId).first<{ source: string; fresh_url: string | null; fresh_expires: number }>();
    if (!row) return '';
    if (row.fresh_url && row.fresh_expires > Date.now() + 60_000) return row.fresh_url;
    return (await refreshAttachmentUrls(env, [{ id: attachmentId, source: row.source }])).get(attachmentId) || '';
  } catch (_) {
    return '';
  }
}

function localizeMessage(message: Message): Message {
  const attachments = message.attachments?.map(normalizeAttachment).map((attachment: any) => ({
    ...attachment,
    url: localizedAttachmentUrl(attachment.url, message.id, message.channel_id, attachment)
  }));
  const snapshots = message.snapshots?.map((snapshot) => ({
    ...snapshot,
    attachments: snapshot.attachments?.map(normalizeAttachment).map((attachment: any) => ({
      ...attachment,
      url: localizedAttachmentUrl(
        attachment.url,
        snapshot.source_message_id || message.id,
        snapshot.source_channel_id || message.channel_id,
        attachment
      )
    }))
  }));
  return { ...message, attachments, snapshots };
}

function getDomainProvider(url: string): { name: string; url?: string; color?: number } {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host.includes('youtube.com') || host.includes('youtu.be')) {
      return { name: 'YouTube', url: 'https://www.youtube.com', color: 16711680 };
    }
    if (host.includes('twitter.com') || host.includes('x.com')) {
      return { name: 'X (Twitter)', url: 'https://x.com', color: 1942002 };
    }
    if (host.includes('substack.com')) {
      return { name: 'Substack', url: 'https://substack.com', color: 16736000 };
    }
    if (host.includes('zoom.us')) {
      return { name: 'Zoom', url: 'https://zoom.us', color: 2969087 };
    }
    if (host.includes('drive.google.com')) {
      return { name: 'Google Drive', url: 'https://drive.google.com', color: 4289797 };
    }
    if (host.includes('github.com')) {
      return { name: 'GitHub', url: 'https://github.com', color: 2434341 };
    }
    if (host.includes('tenor.com')) {
      return { name: 'Tenor', url: 'https://tenor.com' };
    }
    const cleanHost = host.replace(/^www\./, '');
    const capitalized = cleanHost.charAt(0).toUpperCase() + cleanHost.slice(1);
    return { name: capitalized, url: `${parsed.protocol}//${cleanHost}` };
  } catch {
    return { name: 'Link' };
  }
}

export function normalizeDiscordEmbed(raw: any): any {
  if (!raw) return null;

  // Already a full Discord Embed object
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
    if (vMatch && !thumbnail) {
      thumbnail = `https://img.youtube.com/vi/${vMatch[1]}/hqdefault.jpg`;
    }
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

  const embed: any = {
    type,
    url: url || undefined
  };

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
  if (image) {
    embed.image = {
      url: image,
      proxy_url: image,
      width: 600,
      height: 400
    };
  }
  if (thumbnail) {
    embed.thumbnail = {
      url: thumbnail,
      proxy_url: thumbnail,
      width: 400,
      height: 300
    };
  }

  return embed;
}

function extractEmbedsFromContent(content: string): any[] {
  if (!content) return [];
  const urlMatches = content.match(/https?:\/\/[^\s<>()]+/g);
  if (!urlMatches) return [];
  const embeds: any[] = [];
  for (const rawUrl of urlMatches) {
    const cleanUrl = rawUrl.replace(/[.,!?;:]+$/, '');
    const emb = normalizeDiscordEmbed([ '', '', cleanUrl, '' ]);
    if (emb) embeds.push(emb);
  }
  return embeds;
}

function avatarHashOf(avatar?: string | null): string | null {
  if (!avatar) return null;
  const m = String(avatar).match(/\/avatars\/\d+\/([a-f0-9_]+)/i);
  return m ? m[1] : (avatar.includes('/') ? null : avatar);
}

function snowflakeIso(id: string): string | null {
  try {
    return new Date(Number((BigInt(id) >> 22n) + 1420070400000n)).toISOString();
  } catch (_) {
    return null;
  }
}

// 消息作者资料（scripts/build_user_meta.py 从 raw 生成 user_meta）。表里没有的新发言者，从实时缓存里找他最近一条消息。
interface UserMeta {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
  discriminator: string;
  bot: number;
  public_flags: number;
  banner: string | null;
  accent_color: number | null;
  first_message_id: string;
}

async function readUserMeta(env: Env, userId: string): Promise<UserMeta | null> {
  try {
    const row = await env.DB.prepare(
      'SELECT id, username, global_name, avatar, discriminator, bot, public_flags, banner, accent_color, first_message_id FROM user_meta WHERE id = ?'
    ).bind(userId).first<UserMeta>();
    if (row) return row;
  } catch (_) {}
  try {
    const row = await env.DB.prepare(
      'SELECT payload FROM message_cache WHERE payload LIKE ? ORDER BY inserted_at DESC LIMIT 1'
    ).bind(`%"author_id":"${userId}"%`).first<{ payload: unknown }>();
    if (row) {
      const m = unpack(row.payload) as Message;
      return {
        id: userId,
        username: m.username || m.author || '用户',
        global_name: m.author || m.username || null,
        avatar: avatarHashOf(m.avatar),
        discriminator: '0',
        bot: m.is_bot ? 1 : 0,
        public_flags: 0,
        banner: null,
        accent_color: null,
        first_message_id: m.id
      };
    }
  } catch (_) {}
  return null;
}

// 归档块里有的消息没有头像哈希（例如导出时缺失），官方界面会显示默认头像；按 user_meta 补上
async function fillAuthorAvatars(env: Env, messages: Message[]): Promise<Message[]> {
  const ids = [...new Set(messages.filter((m) => m.author_id && !avatarHashOf(m.avatar)).map((m) => m.author_id))].slice(0, 50);
  if (!ids.length) return messages;
  try {
    const rows = await env.DB.prepare(
      `SELECT id, avatar FROM user_meta WHERE avatar IS NOT NULL AND id IN (${ids.map(() => '?').join(',')})`
    ).bind(...ids).all<{ id: string; avatar: string }>();
    const byId = new Map((rows.results || []).map((r) => [r.id, r.avatar]));
    for (const m of messages) {
      const hash = byId.get(m.author_id);
      if (hash && !avatarHashOf(m.avatar)) m.avatar = `/avatars/${m.author_id}/${hash}.png`;
    }
  } catch (_) {}
  await fillReplyAuthors(env, messages);
  await fillMentions(env, messages);
  return messages;
}

// 正文里的 <@id>：官方 API 在 mentions 里带上被提及的用户，客户端才能把不在本地缓存里的人显示成名字而不是"@未知用户"
const MENTION_RE = /<@!?(\d{15,22})>/g;
async function fillMentions(env: Env, messages: Message[]): Promise<void> {
  const idsOf = (m: Message) => [m.content, ...(m.snapshots || []).map((s) => s.content)]
    .flatMap((text) => [...String(text || '').matchAll(MENTION_RE)].map((x) => x[1]));
  const ids = [...new Set(messages.flatMap(idsOf))].slice(0, 90);
  if (!ids.length) return;
  try {
    const rows = (await env.DB.prepare(`SELECT * FROM user_meta WHERE id IN (${ids.map(() => '?').join(',')})`)
      .bind(...ids).all<UserMeta>()).results || [];
    const byId = new Map(rows.map((row) => [row.id, userMetaToDiscord(row)]));
    for (const m of messages) {
      const users = [...new Set(idsOf(m))].map((id) => byId.get(id)).filter(Boolean);
      if (users.length) m.mention_users = users;
    }
  } catch (_) {}
}

// 归档的回复只存了被回复者的显示名，没有 ID；按 user_meta 的 global_name / username 反查（重名时不猜），
// 官方界面的回复条才能显示正确的头像、点开正确的用户卡片
async function fillReplyAuthors(env: Env, messages: Message[]): Promise<void> {
  const pending = messages.filter((m) => m.reply_message_id && m.reply_author && !m.reply_author_id && !m.snapshots?.length);
  const names = [...new Set(pending.map((m) => m.reply_author!))].slice(0, 40);
  if (!names.length) return;
  try {
    const marks = names.map(() => '?').join(',');
    const rows = (await env.DB.prepare(
      `SELECT id, username, global_name, avatar FROM user_meta WHERE global_name IN (${marks}) OR username IN (${marks})`
    ).bind(...names, ...names).all<{ id: string; username: string; global_name: string | null; avatar: string | null }>()).results || [];
    for (const name of names) {
      const byGlobal = rows.filter((r) => r.global_name === name);
      const matches = byGlobal.length ? byGlobal : rows.filter((r) => !r.global_name && r.username === name);
      if (matches.length !== 1) continue;
      for (const m of pending) {
        if (m.reply_author !== name) continue;
        m.reply_author_id = matches[0].id;
        if (matches[0].avatar) m.reply_author_avatar = matches[0].avatar;
      }
    }
  } catch (_) {}
}

function userMetaToDiscord(meta: UserMeta): any {
  return {
    id: meta.id,
    username: meta.username,
    global_name: meta.global_name,
    avatar: meta.avatar,
    discriminator: meta.discriminator || '0',
    public_flags: meta.public_flags || 0,
    flags: meta.public_flags || 0,
    bot: Boolean(meta.bot),
    banner: meta.banner,
    accent_color: meta.accent_color,
    avatar_decoration_data: null,
    collectibles: null,
    primary_guild: null,
    clan: null
  };
}

async function userProfileBody(env: Env, userId: string, guildId: string): Promise<{ status: number; body: unknown }> {
  const meta = await readUserMeta(env, userId);
  if (!meta) return { status: 404, body: { message: 'Unknown User', code: 10013 } };
  const user = userMetaToDiscord(meta);
  const emptyProfile = {
    bio: '',
    accent_color: meta.accent_color,
    banner: meta.banner,
    theme_colors: null,
    popout_animation_particle_type: null,
    emoji: null,
    profile_effect: null,
    pronouns: ''
  };
  return {
    status: 200,
    body: {
      user,
      user_profile: emptyProfile,
      badges: [],
      guild_badges: [],
      application_role_connections: [],
      mutual_guilds: [{ id: guildId, nick: null }],
      mutual_friends: [],
      mutual_friends_count: 0,
      widgets: [],
      wishlist_settings: {},
      connected_accounts: [],
      premium_since: null,
      premium_guild_since: null,
      premium_type: null,
      legacy_username: null,
      profile_themes_experiment_bucket: 4,
      // 归档里没有入群时间，用第一条发言的时间代替
      guild_member: {
        avatar: null,
        banner: null,
        communication_disabled_until: null,
        flags: 0,
        joined_at: snowflakeIso(meta.first_message_id),
        nick: null,
        pending: false,
        premium_since: null,
        roles: [],
        user,
        mute: false,
        deaf: false
      },
      guild_member_profile: { guild_id: guildId, ...emptyProfile, accent_color: null, banner: null }
    }
  };
}

function archiveMessageToDiscord(message: Message, origin = ''): any {
  const loc = localizeMessage(message);

  const avatarHash = avatarHashOf(message.avatar);

  const systemTypes = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15]);
  const rawType = Number(message.message_type || 0);
  const type = systemTypes.has(rawType) ? rawType : 0;

  let embeds: any[] = [];
  if (Array.isArray(message.embeds) && message.embeds.length > 0) {
    embeds = message.embeds.map(normalizeDiscordEmbed).filter(Boolean);
  }
  if (embeds.length === 0 && message.content) {
    embeds = extractEmbedsFromContent(message.content);
  }

  // 官方客户端用 new URL(proxy_url) 拼缩略图参数，相对路径会解析失败
  const toDiscordAttachment = (attachment: any) => {
    const mediaUrl = origin && String(attachment.url || '').startsWith('/') ? `${origin}${attachment.url}` : attachment.url;
    return {
      id: String(attachment.id || ''),
      filename: attachment.filename || '附件',
      url: mediaUrl,
      proxy_url: mediaUrl,
      content_type: attachment.content_type || 'application/octet-stream',
      size: attachment.size || 0,
      width: attachment.width || null,
      height: attachment.height || null
    };
  };
  const guildId = GUILD_ID;

  // 转发：内容在 message_snapshots，message_reference.type = 1（之前没输出，转发全显示成空白消息）
  const snapshots = loc.snapshots || [];
  const forward = snapshots.length > 0;
  // 回复：官方客户端只对 type 19 + message_reference 画回复条（之前是 type 0，所有回复都没有引用）
  const reply = !forward && Boolean(message.reply_message_id);
  const replyKnown = reply && Boolean(message.reply_author || message.reply_content);

  return {
    id: message.id,
    channel_id: message.channel_id,
    author: {
      id: message.author_id || GUILD_OWNER_ID,
      username: message.username || message.author || '用户',
      global_name: message.author || message.username || '用户',
      avatar: avatarHash,
      discriminator: '0',
      public_flags: 0,
      flags: 0,
      bot: Boolean(message.is_bot)
    },
    content: message.content || '',
    timestamp: message.created_at,
    edited_timestamp: null,
    tts: false,
    mention_everyone: /@everyone|@here/.test(message.content || ''),
    mentions: message.mention_users || [],
    mention_roles: [],
    attachments: (loc.attachments || []).map(toDiscordAttachment),
    embeds,
    sticker_items: (message.stickers || []).map((sticker) => ({
      id: String(sticker.id),
      name: sticker.name || 'sticker',
      format_type: Number(sticker.format_type) || 1
    })),
    pinned: false,
    flags: forward ? 16384 : 0, // HAS_SNAPSHOT
    type: reply && type === 0 ? 19 : type,
    ...(forward ? {
      message_reference: {
        type: MESSAGE_REFERENCE_FORWARD,
        channel_id: snapshots[0].source_channel_id || message.reply_channel_id || message.channel_id,
        message_id: snapshots[0].source_message_id || message.reply_message_id,
        guild_id: snapshots[0].source_guild_id || guildId
      },
      message_snapshots: snapshots.map((snapshot) => ({
        message: {
          type: Number(snapshot.type || 0),
          content: snapshot.content || '',
          embeds: (snapshot.embeds || []).map(normalizeDiscordEmbed).filter(Boolean),
          attachments: (snapshot.attachments || []).map(toDiscordAttachment),
          timestamp: snapshot.timestamp || message.created_at,
          edited_timestamp: snapshot.edited_timestamp ?? null,
          flags: Number(snapshot.flags || 0),
          mentions: (message.mention_users || []).filter((user) => (snapshot.content || '').includes(user.id)),
          mention_roles: [],
          components: [],
          sticker_items: snapshot.stickers || []
        }
      }))
    } : {}),
    ...(reply ? {
      message_reference: {
        type: 0,
        channel_id: message.reply_channel_id || message.channel_id,
        message_id: message.reply_message_id,
        guild_id: guildId
      },
      // 原消息已删除时归档里没有作者和内容，按官方返回 null（客户端显示"原始消息已被删除"）
      referenced_message: replyKnown ? {
        id: message.reply_message_id,
        channel_id: message.reply_channel_id || message.channel_id,
        content: message.reply_content || '',
        timestamp: snowflakeIso(message.reply_message_id || ''),
        edited_timestamp: null,
        type: 0,
        flags: 0,
        pinned: false,
        tts: false,
        mention_everyone: false,
        mentions: [],
        mention_roles: [],
        components: [],
        author: {
          id: message.reply_author_id || '0',
          username: message.reply_author || '用户',
          global_name: message.reply_author || '用户',
          discriminator: '0',
          avatar: avatarHashOf(message.reply_author_avatar) || null,
          bot: false
        },
        attachments: [],
        embeds: []
      } : null
    } : {})
  };
}

interface ThreadMeta {
  id: string;
  parent_id: string;
  name: string;
  owner_id: string;
  message_count: number;
  last_message_id: string;
  archived?: number; // 1 = 已归档（导出的帖子默认 1），云端同步按 threads/search 更新
}

// 帖子（thread）的真实父级：频道元数据把帖子并进了"未分类频道"且没有 parent_id，论坛频道因此列不出帖子
async function readThreadMeta(env: Env): Promise<ThreadMeta[]> {
  try {
    return (await env.DB.prepare('SELECT id, parent_id, name, owner_id, message_count, last_message_id, archived FROM thread_meta').all<ThreadMeta>()).results || [];
  } catch (_) {
    try { // archived 列还没迁移（scripts/thread_meta_archived.sql）
      return (await env.DB.prepare('SELECT id, parent_id, name, owner_id, message_count, last_message_id FROM thread_meta').all<ThreadMeta>()).results || [];
    } catch (_) {
      return [];
    }
  }
}

function threadChannelObject(thread: ThreadMeta, guildId: string): any {
  const created = new Date(Number(BigInt(thread.id) >> 22n) + 1420070400000).toISOString();
  return {
    id: thread.id,
    guild_id: guildId,
    parent_id: thread.parent_id,
    owner_id: thread.owner_id,
    type: 11,
    name: thread.name,
    last_message_id: thread.last_message_id,
    message_count: thread.message_count,
    total_message_sent: thread.message_count,
    member_count: 0,
    rate_limit_per_user: 0,
    flags: 0,
    applied_tags: [],
    thread_metadata: { archived: thread.archived === 1, auto_archive_duration: 10080, archive_timestamp: created, locked: false, create_timestamp: created }
  };
}

const compareIds = (a: string, b: string): number => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0);

// block_index 记录每块的首尾消息 ID：按游标定位块，而不是只读最新几块（否则官方 UI 只能翻到最近约两千条）
async function indexedBlockSeqs(env: Env, channelId: string, cursor: string, direction: 'before' | 'after', need: number): Promise<number[]> {
  const stmt = direction === 'before'
    ? (cursor
      ? env.DB.prepare('SELECT seq, count FROM block_index WHERE channel = ? AND first_id < CAST(? AS INTEGER) ORDER BY first_id DESC LIMIT 12').bind(channelId, cursor)
      : env.DB.prepare('SELECT seq, count FROM block_index WHERE channel = ? ORDER BY first_id DESC LIMIT 12').bind(channelId))
    : env.DB.prepare('SELECT seq, count FROM block_index WHERE channel = ? AND last_id > CAST(? AS INTEGER) ORDER BY first_id ASC LIMIT 12').bind(channelId, cursor);
  let rows: Array<{ seq: number; count: number }> = [];
  try {
    rows = (await stmt.all<{ seq: number; count: number }>()).results || [];
  } catch (_) {
    return []; // 索引表不存在时退回到未索引块
  }
  const seqs: number[] = [];
  let covered = 0;
  for (const row of rows) {
    seqs.push(row.seq);
    // 游标所在的第一块只有一部分消息落在游标一侧，不计入覆盖量
    if (cursor && seqs.length === 1) continue;
    covered += row.count;
    if (covered >= need) break;
  }
  return seqs;
}

// 尚未写入 block_index 的块（索引表缺失或旧代码追加的新块）始终读取最新的若干个
async function unindexedBlockSeqs(env: Env, channelId: string): Promise<number[]> {
  let maxIndexed = -1;
  try {
    const row = await env.DB.prepare('SELECT COALESCE(MAX(seq), -1) AS max_seq FROM block_index WHERE channel = ?')
      .bind(channelId).first<{ max_seq: number }>();
    maxIndexed = row?.max_seq ?? -1;
  } catch (_) {}
  const rows = await env.DB.prepare('SELECT seq FROM blocks WHERE channel = ? AND seq > ? ORDER BY seq DESC LIMIT 8')
    .bind(channelId, maxIndexed).all<{ seq: number }>();
  return (rows.results || []).map((row) => row.seq);
}

async function loadBlockMessages(env: Env, channelId: string, seqs: number[]): Promise<Message[]> {
  if (!seqs.length) return [];
  const rows = await env.DB.prepare(
    `SELECT payload FROM blocks WHERE channel = ? AND seq IN (${seqs.map(() => '?').join(',')})`
  ).bind(channelId, ...seqs).all<{ payload: unknown }>();
  const messages: Message[] = [];
  for (const row of rows.results || []) {
    try {
      const unpacked = unpack(row.payload) as Message[];
      if (Array.isArray(unpacked)) messages.push(...unpacked);
    } catch (_) {}
  }
  return messages;
}

// 只读游标附近的增量缓存，避免随 message_cache 增长而每次全量解码
async function cachedMessageWindow(env: Env, channelId: string, cursor: string, direction: 'before' | 'after', need: number): Promise<Message[]> {
  await ensureMessageCache(env);
  const stmt = direction === 'before'
    ? (cursor
      ? env.DB.prepare('SELECT payload FROM message_cache WHERE channel = ? AND message_id < ? ORDER BY message_id DESC LIMIT ?').bind(channelId, cursor, need)
      : env.DB.prepare('SELECT payload FROM message_cache WHERE channel = ? ORDER BY message_id DESC LIMIT ?').bind(channelId, need))
    : env.DB.prepare('SELECT payload FROM message_cache WHERE channel = ? AND message_id > ? ORDER BY message_id ASC LIMIT ?').bind(channelId, cursor, need);
  const rows = await stmt.all<{ payload: unknown }>();
  const messages: Message[] = [];
  for (const row of rows.results || []) {
    try {
      const message = unpack(row.payload) as Message;
      if (message?.id) messages.push(message);
    } catch (_) {}
  }
  return messages;
}

// 论坛帖子的首帖与帖子同 ID，位于帖子最早的数据块里（作者删帖时不存在，客户端会显示原帖已删除）
async function threadStarterMessages(env: Env, threads: ThreadMeta[], origin: string): Promise<any[]> {
  const starters: Message[] = [];
  for (const thread of threads) {
    // 云端同步新发现的帖子只在 message_cache 里，没有归档块
    const starter = await readArchiveMessage(env, thread.id, thread.id);
    if (starter) starters.push(starter);
  }
  await hydrateAttachments(env, starters);
  await fillAuthorAvatars(env, starters);
  return starters.map((message) => archiveMessageToDiscord(message, origin));
}

// 论坛列表的"最新回复"预览：只读帖子最新的块和增量缓存，不触发上游同步
async function threadLatestMessages(env: Env, threads: ThreadMeta[], origin: string): Promise<Map<string, any>> {
  const latest = new Map<string, any>();
  for (const thread of threads) {
    const seqs = await indexedBlockSeqs(env, thread.id, '', 'before', 1);
    const messages = uniqueSortedMessages([
      ...await loadBlockMessages(env, thread.id, seqs.slice(0, 1)),
      ...await cachedMessageWindow(env, thread.id, '', 'before', 1)
    ]).sort((a, b) => compareIds(a.id, b.id));
    const last = messages[messages.length - 1];
    if (!last) continue;
    await hydrateAttachments(env, [last]);
    await fillAuthorAvatars(env, [last]);
    latest.set(thread.id, archiveMessageToDiscord(last, origin));
  }
  return latest;
}

async function readOfficialArchiveMessages(channelId: string, url: URL, env: Env): Promise<any[]> {
  const requested = Number.parseInt(url.searchParams.get('limit') || '50', 10);
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(requested, 100)) : 50;
  const before = url.searchParams.get('before') || '';
  const after = url.searchParams.get('after') || '';
  const around = url.searchParams.get('around') || '';

  // 边缘端访问触发增量拉取：用户访问最新消息时，若配置了 DISCORD_TOKEN，则拉取上游最新消息
  if (!before && !after && !around && env.DISCORD_TOKEN) {
    try {
      await syncChannelMessages(channelId, env);
    } catch (e) {
      console.warn('[OfficialArchive] 自动增量刷新遇到非阻断错误:', e);
    }
  }

  const half = Math.ceil(limit / 2) + 1;
  const windows: Array<['before' | 'after', string, number]> = around
    ? [['before', (BigInt(around) + 1n).toString(), half], ['after', around, half]]
    : after
      ? [['after', after, limit]]
      : [['before', before, limit]];

  const seqs = new Set<number>(await unindexedBlockSeqs(env, channelId));
  const cached: Message[] = [];
  for (const [direction, cursor, need] of windows) {
    for (const seq of await indexedBlockSeqs(env, channelId, cursor, direction, need)) seqs.add(seq);
    cached.push(...await cachedMessageWindow(env, channelId, cursor, direction, need));
  }
  const messages = uniqueSortedMessages([...await loadBlockMessages(env, channelId, [...seqs]), ...cached])
    .sort((a, b) => compareIds(a.id, b.id));

  let page: Message[];
  if (around) {
    const pivot = messages.findIndex((m) => compareIds(m.id, around) >= 0);
    const start = Math.max(0, (pivot === -1 ? messages.length : pivot) - Math.floor(limit / 2));
    page = messages.slice(start, start + limit);
  } else if (after) {
    page = messages.filter((m) => compareIds(m.id, after) > 0).slice(0, limit);
  } else {
    page = (before ? messages.filter((m) => compareIds(m.id, before) < 0) : messages).slice(-limit);
  }
  await hydrateAttachments(env, page);
  await fillAuthorAvatars(env, page);
  return page.reverse().map((message) => archiveMessageToDiscord(message, url.origin));
}

function getMockUser() {
  return {
    id: VISITOR_USER_ID,
    username: VISITOR_NAME,
    global_name: VISITOR_NAME,
    discriminator: '0',
    avatar: null,
    bot: false,
    verified: true,
    flags: 476111,
    public_flags: 476111,
    premium: true,
    premium_type: 2,
    mfa_enabled: 1,
    phone: '+1234567890',
    email: 'visitor@example.invalid',
    locale: LOCALE,
    purchased_flags: 3,
    nsfw_allowed: true,
    age_verification_status: 3
  };
}

// 官方客户端的用户设置（protobuf，base64）。PATCH 只带改动的字段；protobuf 的合并语义等价于序列化字节直接拼接。
// 之前固定回空设置，客户端"已关闭的推广/引导"状态被清空，弹窗反复出现、反复 PATCH。所有访客共用同一个归档账号。
// 默认浅色主题：appearance(13) { theme(1) = LIGHT(2) }。默认值拼在已存设置前面，访客在设置里改过主题时以存储的为准
const DEFAULT_USER_SETTINGS: Record<number, string> = { 1: 'agIIAg==' };
// 默认已关闭的引导（DismissibleContent 编号）：548 CUSTOM_THEME_COACHMARK / 174 CLIENT_THEMES_COACHMARK，
// 访客账号带 Nitro，新访客一进频道右侧就弹出"自定义主题"侧栏
const DEFAULT_DISMISSED_CONTENTS = [174, 548];

function concatSettings(base: string, extra: string): string {
  if (!base) return extra;
  if (!extra) return base;
  const a = Uint8Array.from(atob(base), (c) => c.charCodeAt(0));
  const b = Uint8Array.from(atob(extra), (c) => c.charCodeAt(0));
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a);
  joined.set(b, a.length);
  return btoa(String.fromCharCode(...joined));
}

function protoVarint(bytes: Uint8Array, pos: number): [number, number] {
  let value = 0;
  for (let shift = 0; pos < bytes.length; shift += 7) {
    const b = bytes[pos++];
    value += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) return [value, pos];
  }
  throw new Error('truncated varint');
}

function* protoFields(bytes: Uint8Array): Generator<[number, number, Uint8Array]> {
  let pos = 0;
  while (pos < bytes.length) {
    const [key, p] = protoVarint(bytes, pos);
    const wire = key & 7;
    let end = p;
    if (wire === 0) end = protoVarint(bytes, p)[1];
    else if (wire === 1) end = p + 8;
    else if (wire === 5) end = p + 4;
    else if (wire === 2) {
      const [len, start] = protoVarint(bytes, p);
      yield [key >>> 3, wire, bytes.subarray(start, start + len)];
      pos = start + len;
      continue;
    } else throw new Error(`unsupported wire type ${wire}`);
    yield [key >>> 3, wire, bytes.subarray(p, end)];
    pos = end;
  }
}

function protoLen(n: number): number[] {
  const out: number[] = [];
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return out;
}

// user_content(4).dismissed_contents(1) 是位图 bytes，合并时后出现的整份覆盖前面的：取最后一份按位或上默认值，再追加到末尾
function withDismissedContents(settings: string, ids: number[]): string {
  const bytes = Uint8Array.from(atob(settings), (c) => c.charCodeAt(0));
  let last: Uint8Array = new Uint8Array(0);
  for (const [field, wire, value] of protoFields(bytes)) {
    if (field !== 4 || wire !== 2) continue;
    for (const [sub, subWire, subValue] of protoFields(value)) if (sub === 1 && subWire === 2) last = subValue;
  }
  const bits = new Uint8Array(Math.max(last.length, (Math.max(...ids) >> 3) + 1));
  bits.set(last);
  for (const id of ids) bits[id >> 3] |= 1 << (id & 7);
  if (bits.length === last.length && bits.every((b, i) => b === last[i])) return settings;
  const inner = [0x0a, ...protoLen(bits.length), ...bits];
  return concatSettings(settings, btoa(String.fromCharCode(0x22, ...protoLen(inner.length), ...inner)));
}

// 字节拼接 = protobuf 合并，重复字段会被追加。guild_folders(14) 里是服务器列表：客户端每次改动都发整份，
// 拼接后同一个服务器出现多次，新版客户端建服务器树时报 "[GUILDS TREE] Tried adding a node that already exists" 并不停重连。
// 这类字段按"后出现的整份替换前面的"处理，读和写都只保留最后一份（也修复已经存进 D1 的重复数据）
const REPLACE_ON_PATCH_FIELDS: Record<number, number[]> = { 1: [14] };

function keepLastTopLevel(settings: string, fields: number[]): string {
  if (!settings || !fields.length) return settings;
  const bytes = Uint8Array.from(atob(settings), (c) => c.charCodeAt(0));
  const spans: Array<[number, number, number]> = []; // [field, start, end]
  let pos = 0;
  while (pos < bytes.length) {
    const start = pos;
    const [key, p] = protoVarint(bytes, pos);
    const wire = key & 7;
    if (wire === 0) pos = protoVarint(bytes, p)[1];
    else if (wire === 1) pos = p + 8;
    else if (wire === 5) pos = p + 4;
    else if (wire === 2) { const [len, s0] = protoVarint(bytes, p); pos = s0 + len; }
    else throw new Error(`unsupported wire type ${wire}`);
    spans.push([key >>> 3, start, pos]);
  }
  const last = new Map<number, number>();
  spans.forEach(([field], i) => { if (fields.includes(field)) last.set(field, i); });
  const kept = spans.filter(([field], i) => !fields.includes(field) || last.get(field) === i);
  if (kept.length === spans.length) return settings;
  const out: number[] = [];
  for (const [, start, end] of kept) for (let i = start; i < end; i++) out.push(bytes[i]);
  return btoa(String.fromCharCode(...out));
}

function withDefaultSettings(type: number, stored: string): string {
  try {
    const merged = keepLastTopLevel(concatSettings(DEFAULT_USER_SETTINGS[type] || '', stored), REPLACE_ON_PATCH_FIELDS[type] || []);
    return type === 1 ? withDismissedContents(merged, DEFAULT_DISMISSED_CONTENTS) : merged;
  } catch (_) {
    return stored;
  }
}

async function storedUserSettings(env: Env, type: number): Promise<string> {
  try {
    const row = await env.DB.prepare('SELECT settings FROM user_settings WHERE type = ?').bind(type).first<{ settings: string }>();
    return row?.settings || '';
  } catch (_) {
    return '';
  }
}

async function readUserSettings(env: Env, type: number): Promise<string> {
  return withDefaultSettings(type, await storedUserSettings(env, type));
}

async function patchUserSettings(env: Env, type: number, patch: string): Promise<string> {
  const current = await storedUserSettings(env, type);
  if (!patch) return withDefaultSettings(type, current);
  let merged = patch;
  try {
    const joined = keepLastTopLevel(concatSettings(current, patch), REPLACE_ON_PATCH_FIELDS[type] || []);
    // 重复字段会随拼接增长；超过 16 KB 时只保留本次补丁
    if (joined.length <= 21_848) merged = joined;
  } catch (_) {
    merged = patch;
  }
  if (merged !== current) {
    try {
      await env.DB.prepare(
        'INSERT INTO user_settings (type, settings, updated_at) VALUES (?, ?, ?) ON CONFLICT(type) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at'
      ).bind(type, merged, Date.now()).run();
    } catch (err) {
      console.warn('[Settings] 用户设置保存失败:', err);
    }
  }
  return withDefaultSettings(type, merged);
}

type OfficialResult = { status: number; body: unknown };

function nowSnowflake(): string {
  return ((BigInt(Date.now()) - 1420070400000n) << 22n).toString();
}

// 归档只读：官方客户端的写操作（发消息、加反应、建邀请、改资料……）统一回 403 Missing Permissions。
// 之前这些请求落进兜底分支拿到 [] 或 {}，例如发消息的 POST /messages 回了整页消息数组，客户端整页崩溃。
const READ_ONLY: OfficialResult = { status: 403, body: { message: 'This archive is read-only (只读归档)', code: 50013 } };

// 不需要归档数据的端点，形状参照 DiscordBotClient（github.com/aiko-chan-ai/DiscordBotClient, src/AppCore/routes）。
// 必须和官方 API 一致：客户端拿到 {} 或 [] 会在对应 store 的 *_SUCCESS 里抛异常（贴纸、GIF、应用命令、置顶……）。
type StubFn = (match: RegExpMatchArray, url: URL, request?: Request) => unknown;
type StubBody = StubFn | Record<string, unknown> | unknown[] | null;
const OFFICIAL_STUBS: Array<[method: string, pattern: RegExp, body: StubBody, status?: number]> = [
  // 写操作里需要"成功"的：已读回执、在线心跳、引导问卷等，失败会在客户端反复重试或弹错
  ['POST', /^\/channels\/\d+\/messages\/\d+\/ack$/, { token: null }],
  ['POST', /^\/channels\/\d+\/pins\/ack$/, null, 204],
  ['POST', /^\/guilds\/\d+\/ack$/, null, 204],
  ['POST', /^\/channels\/\d+\/typing$/, null, 204],
  ['POST', /^\/read-states\/ack-bulk$/, null, 204],
  ['PATCH', /^\/channels\/\d+\/explicit-media$/, null, 204],
  ['POST', /^\/users\/@me\/meaningfully-online$/, null, 204],
  ['*', /^\/auth\/logout$/, null, 204],
  ['*', /^\/hypesquad\/online$/, null, 204],
  ['POST', /^\/guilds\/\d+\/migrate-command-scope$/, { integration_ids_with_app_commands: [] }],
  ['*', /^\/guilds\/(\d+)\/onboarding-responses$/, async (m, _url, request) => ({
    ...(request && request.method !== 'GET' ? await request.json<Record<string, unknown>>().catch(() => ({})) : {}),
    guild_id: m[1],
    user_id: VISITOR_USER_ID
  })],

  // 应用 / 活动 / 游戏
  ['GET', /^\/(channels|guilds|users)\/(\d+|@me)\/application-command-index$/, () => ({ applications: [], application_commands: [], version: nowSnowflake() })],
  ['GET', /^\/channels\/\d+\/application-commands\/search$/, { application_commands: [], applications: [], cursor: null }],
  ['GET', /^\/activities\/shelf$/, { activities: [], applications: [], assets: {} }],
  ['GET', /^\/applications-with-assets$/, { applications: [], assets: {} }],
  ['GET', /^\/application-directory-static\/collections$/, []],
  ['GET', /^\/app-recommendations$/, []],
  ['GET', /^\/applications\/(non-games\/)?detectable$/, []],
  ['GET', /^\/games(\/detectable\/exclusions)?$/, []],
  ['GET', /^\/applications\/\d+\/public$/, { message: 'Unknown Application', code: 10002 }, 404],
  ['GET', /^\/oauth2\/tokens$/, []],
  ['GET', /^\/teams$/, []],
  ['GET', /^\/__development\/build_overrides$/, {}],

  // 贴纸 / GIF / 表情
  ['GET', /^\/sticker-packs$/, { sticker_packs: [] }],
  ['GET', /^\/stickers\/\d+$/, { message: 'Unknown Sticker', code: 10060 }, 404],
  ['GET', /^\/gifs\/trending$/, { categories: [], gifs: [] }],
  ['GET', /^\/gifs\/(search|trending-gifs|suggest|trending-search)$/, []],
  ['GET', /^\/guilds\/\d+\/top-emojis$/, { items: [] }],

  // 服务器附属数据
  ['GET', /^\/guilds\/\d+\/admin-server-eligibility$/, { eligible_for_admin_server: false }],
  ['GET', /^\/guilds\/\d+\/analytics\/member-insights$/, { has_access_rate: false, access_rate: null, last_updated: null }],
  ['GET', /^\/guilds\/\d+\/(applications|entitlements|powerups|premium\/subscriptions|role-subscriptions\/group-listings|role-subscriptions\/trials|invites|webhooks|integrations|stickers|scheduled-events|templates|bans|auto-moderation\/rules)$/, []],
  ['GET', /^\/guilds\/\d+\/products\/listings$/, { listings: [] }],
  ['GET', /^\/guilds\/\d+\/top-games$/, { top_games: [] }],
  ['GET', /^\/guilds\/\d+\/soundboard-sounds$/, { items: [] }],
  ['GET', /^\/guilds\/(\d+)\/role-subscriptions\/settings$/, (m) => ({
    guild_id: m[1], full_server_gate: false, description: '', server_shop_tab_order: 0, store_page_primary_color: null,
    store_page_trailer_url: null, store_page_show_subscriber_count: false, store_page_guild_products_default_sort: 0,
    cover_image_asset: null, store_page_slug: null
  })],
  ['GET', /^\/guilds\/(\d+)\/onboarding$/, (m) => ({ guild_id: m[1], prompts: [], default_channel_ids: [], enabled: false, mode: 0, below_requirements: false, responses: [] })],
  ['GET', /^\/(users\/@me\/)?guilds\/integration-application-ids$/, {}],
  ['GET', /^\/(users\/@me\/)?guilds\/premium\/(subscription-slots|subscriptions)$/, []],
  ['GET', /^\/discoverable-guilds$/, { total: 0, guilds: [], offset: 0, limit: 100 }],
  ['GET', /^\/discoverable-guilds\/search$/, { guilds: [], total_count: 0, categories: [] }],
  ['GET', /^\/creator-monetization\/marketing\/nag-activate\/eligibility$/, { eligible_guilds: [] }],

  // 频道附属数据
  ['GET', /^\/channels\/\d+\/(invites|webhooks)$/, []],
  ['GET', /^\/channels\/\d+\/threads\/archived\/(public|private)$/, { threads: [], members: [], has_more: false }],
  ['GET', /^\/channels\/\d+\/users\/@me\/threads\/archived\/private$/, { threads: [], members: [], has_more: false }],

  // 当前用户
  ['GET', /^\/users\/@me\/affinities\/guilds$/, { guild_affinities: [] }],
  ['GET', /^\/users\/@me\/affinities\/users$/, { user_affinities: [], inverse_user_affinities: [] }],
  ['GET', /^\/users\/@me\/(channels|relationships|connections|mentions|inventory|library|scheduled-messages|activities\/statistics\/applications|video-filters\/assets|mfa\/webauthn\/credentials|outbound-promotions\/codes)$/, []],
  ['GET', /^\/users\/@me\/applications\/\d+\/entitlements$/, []],
  ['GET', /^\/users\/@me\/entitlements(\/gifts)?$/, []],
  ['GET', /^\/users\/@me\/avatars$/, { avatars: [] }],
  ['GET', /^\/users\/@me\/billing\/country-code$/, () => ({ country_code: COUNTRY_CODE })],
  ['GET', /^\/users\/@me\/billing\/location-info$/, () => ({ country_code: COUNTRY_CODE, subdivision_code: null })],
  ['GET', /^\/users\/@me\/billing\/campaign-context$/, [{ campaign: 2, is_eligible: false }]],
  ['GET', /^\/users\/@me\/billing\/(nitro-affinity|payment-sources|payments|subscriptions|invoices)$/, []],
  ['GET', /^\/users\/@me\/consent$/, { personalization: { consented: false }, usage_statistics: { consented: false } }],
  ['GET', /^\/users\/@me\/custom-themes$/, null, 204],
  ['GET', /^\/users\/@me\/email-settings$/, {
    categories: { social: true, communication: true, recommendations_and_events: false, tips: false, updates_and_announcements: false },
    initialized: true
  }],
  ['GET', /^\/users\/@me\/gift-intent-dismissals$/, { dismissals: [] }],
  ['GET', /^\/users\/@me\/harvest$/, null, 204],
  ['GET', /^\/users\/@me\/notes$/, {}],
  ['GET', /^\/users\/@me\/notes\/\d+$/, { message: 'Unknown User', code: 10013 }, 404],
  ['GET', /^\/users\/@me\/notification-center\/items$/, () => ({ limit: 20, items: [], cursor: nowSnowflake(), has_more: false })],
  ['GET', /^\/users\/@me\/program-rewards$/, { rewards: [] }],
  ['GET', /^\/users\/@me\/referrals\/eligibility$/, {
    referrals_remaining: 0, sent_user_ids: [], refresh_at: null, has_eligible_friends: false, recipient_status: {},
    is_eligible_for_incentive: false, is_qualified_for_incentive: false, referral_incentive_status: 0
  }],
  ['GET', /^\/users\/@me\/referrals\/eligible-users$/, { users: [], next_index: 0 }],
  ['GET', /^\/users\/@me\/referrals\/\d+\/preview$/, { is_eligible: false }],
  // 旧版客户端读 results，新版读 reminders / bookmark_ids（缺了会在打开资料卡的流程里抛异常，资料卡打不开）
  ['GET', /^\/users\/@me\/saved-messages$/, { results: [], reminders: [], bookmark_ids: [] }],
  ['GET', /^\/users\/@me\/survey$/, { survey: null }],
  ['GET', /^\/users\/@me\/unclaimed-games$/, {}],
  ['GET', /^\/users\/@me\/virtual-currency\/balance$/, { balance: 0 }],
  ['GET', /^\/users\/@me\/widgets\/application-widget-application-ids$/, { application_configs: [] }],
  ['GET', /^\/users\/@me\/widgets\/suggested-games$/, { suggested_games: [], suggested_wishlist_games: [] }],
  ['GET', /^\/users\/(\d+|@me|%40me)\/badges$/, []],
  ['GET', /^\/users\/(\d+|@me|%40me)\/badges\/\d+$/, { message: 'Unknown Badge', code: 10000 }, 404],
  ['GET', /^\/family-center\/@me$/, { linked_users: [], users: [], teen_audit_log: null, age_group: 'adult' }],
  ['GET', /^\/safety-hub\/@me$/, { classifications: [], guild_classifications: [], account_standing: { state: 100 } }],
  ['GET', /^\/auth\/location-metadata$/, () => ({ consent_required: false, country_code: COUNTRY_CODE, promotional_email_opt_in: { required: false, pre_checked: false } })],
  ['GET', /^\/auth\/sessions$/, () => ({
    user_sessions: [{
      id_hash: 'archive-visitor',
      approx_last_used_time: new Date().toISOString(),
      client_info: { os: 'Web', platform: 'Discord Archive Client', location: 'Cloudflare' }
    }]
  })],
  ['GET', /^\/content-inventory\/users\/@me$/, () => ({
    request_id: nowSnowflake(),
    entries: [],
    entries_hash: 0,
    expired_at: new Date(Date.now() + 600_000).toISOString(),
    refresh_stale_inbox_after_ms: 3_000_000,
    refresh_token: btoa(JSON.stringify({ created_at: new Date().toISOString(), content_hash: '' })),
    wait_ms_until_next_fetch: 3_000_000
  })],
  ['GET', /^\/content-inventory\/users\/\d+\/outbox$/, { entries: [] }],
  ['GET', /^\/users\/\d+\/application-identities$/, { identities: [] }],
  ['GET', /^\/widget-configs\/featured$/, { applications: [], configs: [] }],

  // 商店 / Nitro / 收藏品 / 任务
  ['GET', /^\/(users\/@me\/)?collectibles-marketing$/, { marketings: {} }],
  ['GET', /^\/(users\/@me\/)?collectibles-purchases$/, []],
  ['GET', /^\/collectibles-shop$/, { shop_blocks: [], categories: [] }],
  ['GET', /^\/collectibles-categories$/, []],
  ['GET', /^\/collectibles-categories\/v2$/, { categories: [], collections: [] }],
  ['GET', /^\/premium-marketing$/, []],
  ['GET', /^\/(bogo-)?promotions$/, []],
  ['GET', /^\/outbound-promotions$/, []],
  ['GET', /^\/storefront\/promotions$/, { promotions: [] }],
  ['GET', /^\/partner-sdk\/storefront-config$/, { promotional_sku_ids: [], promotion_end_datetime: null }],
  ['GET', /^\/store\/published-listings\/skus$/, []],
  ['GET', /^\/store\/published-listings\/(skus|applications)\/\d+\/subscription-plans$/, []],
  ['GET', /^\/quests\/@me$/, { quests: [], excluded_quests: [], quest_enrollment_blocked_until: null }],
  ['GET', /^\/quests\/@me\/claimed$/, { quests: [] }],
  ['GET', /^\/quests\/decision$/, { quest: null }],
  ['GET', /^\/quests\/get-decisions$/, () => ({ request_id: nowSnowflake(), decisions: [] })],
  ['GET', /^\/streams\/[^/]+\/preview$/, { message: 'Unknown Stream', code: 10049 }, 404],

  // 状态页（客户端请求 status.discord.com，official-shell.html 把它改写到本站 /api/v2/）
  ['GET', /^\/scheduled-maintenances\/(upcoming|active)\.json$/, { scheduled_maintenances: [] }],
  ['GET', /^\/incidents\/unresolved\.json$/, { incidents: [] }],
  // 更新日志配置（cdn.discordapp.com/changelogs，official-shell.html 改写过来）：空配置 = 不弹"新功能"
  ['GET', /^\/changelogs\/config_\d+\.json$/, {}],
  ['GET', /^\/soundboard-default-sounds$/, []],
  ['POST', /^\/beaker$/, null, 204],
  // 新版客户端请服务端挑选要展示的引导/推广（coachmark）；空列表 = 只显示客户端自己的，不弹推广
  ['POST', /^\/dismissible-content\/arbitrate$/, { candidates: [] }]
];

async function officialStub(path: string, url: URL, request?: Request): Promise<OfficialResult | null> {
  const method = (request?.method || 'GET').toUpperCase();
  for (const [m, pattern, body, status] of OFFICIAL_STUBS) {
    if (m !== '*' && m !== method) continue;
    const match = path.match(pattern);
    if (!match) continue;
    return { status: status ?? 200, body: typeof body === 'function' ? await (body as StubFn)(match, url, request) : body };
  }
  return null;
}

// 单条归档消息（回复引用、置顶列表）：只读包含该 ID 的块和增量缓存
async function readArchiveMessage(env: Env, channelId: string, messageId: string): Promise<Message | null> {
  const cursor = (BigInt(messageId) + 1n).toString();
  const seqs = new Set<number>([
    ...await indexedBlockSeqs(env, channelId, cursor, 'before', 1),
    ...await unindexedBlockSeqs(env, channelId)
  ]);
  const messages = [
    ...await loadBlockMessages(env, channelId, [...seqs]),
    ...await cachedMessageWindow(env, channelId, cursor, 'before', 1)
  ];
  return messages.find((message) => message.id === messageId) || null;
}

// 置顶消息：表 pin_meta 由 scripts/build_pin_meta.py 从 ../raw 生成。客户端读 body.items[].{pinned_at, message}
async function pinnedMessagesBody(env: Env, channelId: string, url: URL): Promise<OfficialResult> {
  let rows: Array<{ message_id: string; pinned_at: string }> = [];
  try {
    rows = (await env.DB.prepare('SELECT message_id, pinned_at FROM pin_meta WHERE channel = ? ORDER BY pinned_at DESC')
      .bind(channelId).all<{ message_id: string; pinned_at: string }>()).results || [];
  } catch (_) {}
  const before = url.searchParams.get('before');
  if (before) rows = rows.filter((row) => Date.parse(row.pinned_at) < Date.parse(before));
  const limit = Math.min(50, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '25', 10) || 25));
  const page = rows.slice(0, limit);
  const found: Array<[string, Message]> = [];
  for (const row of page) {
    const message = await readArchiveMessage(env, channelId, row.message_id);
    if (message) found.push([row.pinned_at, message]);
  }
  await hydrateAttachments(env, found.map(([, message]) => message));
  await fillAuthorAvatars(env, found.map(([, message]) => message));
  return {
    status: 200,
    body: {
      items: found.map(([pinnedAt, message]) => ({ pinned_at: pinnedAt, message: { ...archiveMessageToDiscord(message, url.origin), pinned: true } })),
      has_more: rows.length > limit
    }
  };
}

// 官方客户端的消息搜索（服务器搜索框、帖子内搜索）。查询参数原样转给 Discord 搜索：作者、频道、has、日期范围、
// 排序、offset 翻页都由 Discord 处理。之前只转 content，再按正文二次过滤，按作者/频道筛选和翻页都不生效，结果还是正序。
// Discord 不可用（无令牌、避让中、索引未就绪）时退回归档内的正文搜索。
const SEARCH_FORWARD_PARAMS = new Set([
  'content', 'author_id', 'author_type', 'mentions', 'mention_everyone', 'has', 'min_id', 'max_id', 'channel_id', 'pinned',
  'offset', 'limit', 'sort_by', 'sort_order', 'include_nsfw', 'embed_type', 'embed_provider', 'link_hostname',
  'attachment_filename', 'attachment_extension'
]);

async function officialSearchBody(url: URL, env: Env, scope: 'guilds' | 'channels', scopeId: string): Promise<OfficialResult> {
  const desc = url.searchParams.get('sort_order') !== 'asc';
  const toHits = (messages: Message[]) => messages.map((message) => [{ ...archiveMessageToDiscord(message, url.origin), hit: true }]);
  if (env.DISCORD_TOKEN) {
    try {
      const forward = new URLSearchParams();
      for (const [key, value] of url.searchParams) if (SEARCH_FORWARD_PARAMS.has(key)) forward.append(key, value);
      const data = await discordJson(`https://discord.com/api/v10/${scope}/${scopeId}/messages/search?${forward}`, env);
      if (Array.isArray(data?.messages)) {
        const byId = new Map(searchResultMessages(data, scope === 'channels' ? scopeId : '').map((message) => [message.id, message]));
        const ordered = data.messages
          .map((item: any) => byId.get(String((Array.isArray(item) ? item[0] : item)?.id)))
          .filter((message: Message | undefined): message is Message => Boolean(message));
        await fillAuthorAvatars(env, ordered);
        return {
          status: 200,
          body: {
            analytics_id: nowSnowflake(),
            doing_deep_historical_index: false,
            total_results: Number(data.total_results) || ordered.length,
            messages: toHits(ordered),
            threads: Array.isArray(data.threads) ? data.threads : [],
            members: Array.isArray(data.members) ? data.members : []
          }
        };
      }
    } catch (error: any) {
      if (error.status !== 429) console.warn('[Search] Discord 搜索不可用，改用归档搜索:', error.message || error);
    }
  }
  const content = lower((url.searchParams.get('content') || '').trim());
  const channels = scope === 'channels' ? [scopeId] : url.searchParams.getAll('channel_id');
  const authors = url.searchParams.getAll('author_id');
  let results = content ? await searchArchivedGuildMessages(content, env, 500, channels.length === 1 ? channels[0] : undefined) : [];
  if (channels.length) results = results.filter((message) => channels.includes(message.channel_id || ''));
  if (authors.length) results = results.filter((message) => authors.includes(message.author_id || ''));
  if (desc) results.reverse();
  const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0);
  const page = results.slice(offset, offset + 25);
  await hydrateAttachments(env, page);
  await fillAuthorAvatars(env, page);
  return { status: 200, body: { analytics_id: nowSnowflake(), doing_deep_historical_index: false, total_results: results.length, messages: toHits(page) } };
}

function officialGuildObject(guildId: string) {
  return {
    id: guildId,
    name: GUILD_NAME,
    icon: GUILD_ICON,
    splash: null,
    banner: null,
    owner_id: GUILD_OWNER_ID,
    permissions: '2147483647',
    roles: [
      {
        id: guildId,
        name: '@everyone',
        color: 0,
        hoist: false,
        position: 0,
        permissions: '1071698660929',
        managed: false,
        mentionable: false,
        flags: 0
      }
    ],
    emojis: [],
    features: ['COMMUNITY', 'NEWS', 'THREADS_ENABLED'],
    verification_level: 0,
    default_message_notifications: 0,
    explicit_content_filter: 0,
    mfa_level: 0
  };
}

async function officialApiBody(url: URL, env: Env, request?: Request): Promise<{ status: number; body: unknown } | null> {
  const path = url.pathname.replace(/^\/api\/v\d+/, '') || '/';
  if (!path.startsWith('/')) return null;

  const guildId = GUILD_ID;
  const userObj = getMockUser();
  const method = (request?.method || 'GET').toUpperCase();

  const stub = await officialStub(path, url, request);
  if (stub) return stub;

  // 1. Gateway
  if (path === '/gateway' || path === '/gateway/bot') {
    const wsOrigin = url.origin.replace(/^http/, 'ws');
    const gatewayUrl = `${wsOrigin}/gateway`;
    if (path === '/gateway/bot') {
      return {
        status: 200,
        body: {
          url: gatewayUrl,
          shards: 1,
          session_start_limit: { total: 1000, remaining: 999, reset_after: 14400000, max_concurrency: 1 }
        }
      };
    }
    return { status: 200, body: { url: gatewayUrl } };
  }

  // 2. Experiments
  if (path === '/experiments') {
    return { status: 200, body: { fingerprint: '', assignments: [], guild_experiments: [] } };
  }

  // 3. Current User @me
  if (path === '/users/@me') {
    return method === 'GET' ? { status: 200, body: userObj } : READ_ONLY;
  }

  // 4. User Profile（用户卡片里的 application-identities / widget-configs / outbox 在 OFFICIAL_STUBS）
  const otherUser = path.match(/^\/users\/(\d+)(\/profile)?$/);
  if (otherUser && otherUser[1] !== userObj.id) {
    if (otherUser[2]) return userProfileBody(env, otherUser[1], url.searchParams.get('guild_id') || guildId);
    const meta = await readUserMeta(env, otherUser[1]);
    return meta ? { status: 200, body: userMetaToDiscord(meta) } : { status: 404, body: { message: 'Unknown User', code: 10013 } };
  }

  if (path === '/users/@me/profile' || path === '/users/%40me/profile' || path === `/users/${userObj.id}/profile`) {
    if (method !== 'GET') return READ_ONLY;
    const profileGuild = url.searchParams.get('guild_id');
    const userProfile = {
      bio: `${GUILD_NAME} archive visitor`,
      accent_color: null,
      banner: null,
      theme_colors: null,
      popout_animation_particle_type: null,
      emoji: null,
      profile_effect: null,
      pronouns: null,
      collectibles: []
    };
    return {
      status: 200,
      body: {
        application_role_connections: [],
        user: userObj,
        user_profile: userProfile,
        badges: [
          { id: 'nitro', description: 'Nitro 订阅者', icon: '2ba85e8026a8614b640c2837bcd2177c' }
        ],
        guild_badges: [],
        guild_member: profileGuild
          ? { user: userObj, roles: [], joined_at: '2024-01-01T00:00:00.000000+00:00', nick: null, avatar: null, banner: null, flags: 0, pending: false, deaf: false, mute: false }
          : null,
        guild_member_profile: profileGuild ? { guild_id: profileGuild, ...userProfile, bio: null } : null,
        legacy_username: null,
        mutual_guilds: [],
        mutual_friends: [],
        mutual_friends_count: 0,
        connected_accounts: [],
        premium_since: '2020-01-01T00:00:00.000000+00:00',
        premium_guild_since: '2020-01-01T00:00:00.000000+00:00',
        premium_type: 2,
        profile_themes_experiment_bucket: 4,
        widgets: [],
        wishlist_settings: {}
      }
    };
  }

  // 5. User Settings & Protobuf
  if (path === '/users/@me/settings') {
    return {
      status: 200,
      body: {
        locale: LOCALE,
        theme: 'light',
        render_embeds: true,
        render_reactions: true,
        animate_emoji: true,
        enable_tts_command: false,
        message_display_compact: false,
        inline_attachment_media: true,
        inline_embed_media: true,
        gif_auto_play: true,
        custom_status: null
      }
    };
  }
  const settingsMatch = path.match(/^\/users\/@me\/settings-proto\/(\d+)$/);
  if (settingsMatch) {
    const type = Number(settingsMatch[1]);
    if (request?.method === 'PATCH') {
      const body: any = await request.json().catch(() => ({}));
      return { status: 200, body: { settings: await patchUserSettings(env, type, typeof body?.settings === 'string' ? body.settings : '') } };
    }
    return { status: 200, body: { settings: await readUserSettings(env, type) } };
  }
  if (path.startsWith('/users/@me/settings-proto')) {
    return { status: 200, body: { settings: '' } };
  }

  // 6-7. affinities / billing 在 OFFICIAL_STUBS

  // 8. Guilds List for @me
  if (path === '/users/@me/guilds' && method === 'GET') {
    return {
      status: 200,
      body: [
        {
          id: guildId,
          name: GUILD_NAME,
          icon: GUILD_ICON,
          owner: true,
          permissions: '2147483647',
          features: ['COMMUNITY', 'NEWS', 'THREADS_ENABLED']
        }
      ]
    };
  }

  // 9. Guild Member @me
  const selfMember = path.match(/^\/guilds\/(\d+)\/members\/@me$/);
  if (selfMember) {
    // 客户端打开频道时如果频道还没进 store（READY 之前），会以 lurker 身份 PUT 加入服务器；访客已是成员，按官方返回服务器对象
    if (method === 'PUT') {
      return { status: 200, body: { ...officialGuildObject(selfMember[1]), join_request: null, show_verification_form: false, welcome_screen: null } };
    }
    if (method !== 'GET') return READ_ONLY;
    return {
      status: 200,
      body: {
        user: userObj,
        roles: [],
        joined_at: '2024-01-01T00:00:00.000000+00:00',
        deaf: false,
        mute: false,
        flags: 0
      }
    };
  }
  const otherMember = path.match(/^\/guilds\/(\d+)\/members\/(\d+)$/);
  if (otherMember && method === 'GET') {
    const profile = await userProfileBody(env, otherMember[2], otherMember[1]);
    return profile.status === 200
      ? { status: 200, body: (profile.body as any).guild_member }
      : { status: 404, body: { message: 'Unknown Member', code: 10007 } };
  }

  // 10. Guild Details, Channels, Roles, Members
  const guildMatch = path.match(/^\/guilds\/(\d+)(?:\/(channels|members|roles|messages\/search|member-ids|preview))?$/);
  if (guildMatch && method !== 'GET') return READ_ONLY;
  if (guildMatch) {
    const targetGuildId = guildMatch[1];
    const sub = guildMatch[2];
    if (sub === 'messages/search') return officialSearchBody(url, env, 'guilds', targetGuildId);
    const groups = await readChannelMetadata(env);
    if (sub === 'channels') {
      const channels: any[] = [];
      let pos = 0;
      for (const group of groups) {
        if (group.id) {
          channels.push({
            id: group.id,
            guild_id: targetGuildId,
            name: group.name,
            type: 4,
            position: pos++,
            parent_id: null,
            permission_overwrites: [],
            flags: 0
          });
        }
        for (const ch of group.channels || []) {
          if (ch.type === 11 || ch.type === 12) continue; // 帖子走 guild.threads / threads/search
          channels.push({
            ...(ch.type === 15 ? { available_tags: [], default_reaction_emoji: null, default_sort_order: null, default_forum_layout: 0 } : {}),
            id: ch.id,
            guild_id: targetGuildId,
            name: ch.name,
            type: ch.type ?? 0,
            position: pos++,
            parent_id: group.id || null,
            permission_overwrites: [],
            topic: null,
            nsfw: false,
            rate_limit_per_user: 0,
            last_message_id: null,
            flags: 0
          });
        }
      }
      return { status: 200, body: channels };
    }
    if (sub === 'roles') {
      return {
        status: 200,
        body: [
          {
            id: targetGuildId,
            name: '@everyone',
            color: 0,
            hoist: false,
            position: 0,
            permissions: '1071698660929',
            managed: false,
            mentionable: false,
            flags: 0
          }
        ]
      };
    }
    if (sub === 'members' || sub === 'member-ids') {
      const member = {
        user: userObj,
        roles: [],
        joined_at: '2024-01-01T00:00:00.000000+00:00',
        deaf: false,
        mute: false,
        flags: 0
      };
      return { status: 200, body: sub === 'members' ? [member] : [userObj.id] };
    }
    if (!sub || sub === 'preview') return { status: 200, body: officialGuildObject(targetGuildId) };
  }

  // 11. Channels & Messages
  const channelMatch = path.match(/^\/channels\/(\d+)(?:\/(messages|threads\/search|post-data|messages\/pins|messages\/search|messages\/(\d+)))?$/);
  // 只有论坛卡片数据 post-data 是 POST 读接口；其余写操作（发消息、编辑、删除、改频道）一律只读
  if (channelMatch && method !== 'GET' && channelMatch[2] !== 'post-data') return READ_ONLY;
  if (channelMatch) {
    const channelId = channelMatch[1];
    const sub = channelMatch[2];
    if (sub === 'messages') {
      return { status: 200, body: await readOfficialArchiveMessages(channelId, url, env) };
    }
    if (sub === 'messages/pins') return pinnedMessagesBody(env, channelId, url);
    if (sub === 'messages/search') return officialSearchBody(url, env, 'channels', channelId);
    if (channelMatch[3]) {
      const message = await readArchiveMessage(env, channelId, channelMatch[3]);
      if (!message) return { status: 404, body: { message: 'Unknown Message', code: 10008 } };
      await hydrateAttachments(env, [message]);
      await fillAuthorAvatars(env, [message]);
      return { status: 200, body: archiveMessageToDiscord(message, url.origin) };
    }
    if (sub === 'threads/search') {
      // 客户端的论坛列表/子区面板用 archived=true 取已归档的，活跃的来自 READY guild.threads
      const archived = url.searchParams.get('archived');
      const threads = (await readThreadMeta(env))
        .filter((thread) => thread.parent_id === channelId)
        .filter((thread) => archived === null || (thread.archived === 1) === (archived === 'true'))
        .sort((a, b) => compareIds(b.last_message_id, a.last_message_id));
      const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const limit = Math.min(25, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '25', 10) || 25));
      const page = threads.slice(offset, offset + limit);
      return {
        status: 200,
        body: {
          threads: page.map((thread) => threadChannelObject(thread, guildId)),
          members: [],
          has_more: offset + limit < threads.length,
          total_results: threads.length,
          first_messages: await threadStarterMessages(env, page, url.origin),
          application_commands: []
        }
      };
    }
    if (sub === 'post-data') {
      // 论坛帖子卡片数据（客户端 LOAD_FORUM_POSTS 对 threads 做 Object.values，缺失会抛错）
      const threads = (await readThreadMeta(env)).filter((thread) => thread.parent_id === channelId);
      const starters = await threadStarterMessages(env, threads, url.origin);
      const latest = await threadLatestMessages(env, threads, url.origin);
      const posts: Record<string, any> = {};
      for (const thread of threads) {
        posts[thread.id] = {
          first_message: starters.find((message) => message.id === thread.id) ?? null,
          most_recent_message: latest.get(thread.id) ?? null
        };
      }
      return { status: 200, body: { threads: posts } };
    }
    const threadMeta = (await readThreadMeta(env)).find((thread) => thread.id === channelId);
    if (threadMeta) return { status: 200, body: threadChannelObject(threadMeta, guildId) };
    // Single channel query
    const groups = await readChannelMetadata(env);
    let found: any = null;
    for (const group of groups) {
      if (group.id === channelId) {
        found = { id: group.id, guild_id: guildId, name: group.name, type: 4, position: 0, parent_id: null, permission_overwrites: [] };
        break;
      }
      for (const ch of group.channels || []) {
        if (ch.id === channelId) {
          found = { id: ch.id, guild_id: guildId, name: ch.name, type: ch.type ?? 0, position: 0, parent_id: group.id || null, permission_overwrites: [] };
          break;
        }
      }
      if (found) break;
    }
    return {
      status: 200,
      body: found || { id: channelId, guild_id: guildId, name: '归档频道', type: 0, position: 0, parent_id: null, permission_overwrites: [] }
    };
  }

  // 12. 遥测（/api/v9/science 等；不带 /api 前缀的在 fetch 入口处理）
  if (/^\/(science|metrics|track|error-reporting-proxy)(\/|$)/.test(path)) return { status: 204, body: null };

  // 13. 兜底：写操作按只读拒绝；未适配的读接口回 404（和官方一样），不再回 [] 或 {}——
  // 形状不对的"成功"会在客户端 store 里抛异常，404 只会走客户端自己的失败分支
  if (method !== 'GET' && method !== 'HEAD') return READ_ONLY;
  console.warn(`[OfficialAPI] 未适配的端点: GET ${path}`);
  return { status: 404, body: { message: '404: Not Found', code: 0 } };
}

const connectedGateways = new Set<WebSocket>();

function broadcastGatewayMessage(message: Message): void {
  const d = archiveMessageToDiscord(message);
  const payload = JSON.stringify({
    op: 0,
    t: 'MESSAGE_CREATE',
    d
  });
  for (const ws of connectedGateways) {
    try {
      ws.send(payload);
    } catch (_) {
      connectedGateways.delete(ws);
    }
  }
}

// 网关帧：客户端带 compress=zlib-stream 时，整条连接共用一个 deflate 上下文，每条消息 Z_SYNC_FLUSH（以 00 00 ff ff 结尾）
// 以二进制帧发出，和 Discord 一致。新版客户端收到文本帧会抛 "Expected array buffer, but got string" 并一直重连
function gatewaySender(server: WebSocket, request: Request): (text: string) => void {
  if (new URL(request.url).searchParams.get('compress') !== 'zlib-stream') return (text) => server.send(text);
  const deflate = new Deflate();
  let chunks: Uint8Array[] = [];
  deflate.onData = (chunk: Uint8Array) => { chunks.push(chunk); };
  return (text) => {
    deflate.push(text, 2); // Z_SYNC_FLUSH
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    chunks = [];
    server.send(out);
  };
}

function officialGateway(request: Request, env: Env, ctx: ExecutionContext): Response | null {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return null;
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  const send = gatewaySender(server, request);
  const origin = new URL(request.url).origin;
  // 按入库时间推送：定时同步每分钟才写入，用消息自身的 created_at 比较会漏掉入库滞后的新消息
  let lastInsertedAt = Date.now();
  // 已经推过的消息（实时推送和心跳轮询都会碰到同一条，只发一次）
  const pushed = new Set<string>();
  const push = (type: string, message: Message) => {
    if (!message?.id || (type === 'MESSAGE_CREATE' && pushed.has(message.id))) return;
    pushed.add(message.id);
    if (pushed.size > 2000) pushed.delete(pushed.values().next().value as string);
    send(JSON.stringify({ op: 0, t: type, d: archiveMessageToDiscord(message, origin) }));
  };

  // 实时：订阅 sync-worker 的 DiscordGateway（它连着 Discord 官方网关），收到新消息/编辑立刻推给这个访客
  if (env.GATEWAY && GUILD_ID) {
    ctx.waitUntil((async () => {
      try {
        const resp = await env.GATEWAY!.get(env.GATEWAY!.idFromName(GUILD_ID)).fetch('https://gateway/subscribe', { headers: { Upgrade: 'websocket' } });
        const hub = resp.webSocket;
        if (!hub) return;
        hub.accept();
        hub.addEventListener('message', (event) => {
          try {
            const { t, record } = JSON.parse(String(event.data));
            if (t === 'MESSAGE_CREATE' || t === 'MESSAGE_UPDATE') push(t, record);
          } catch (_) {}
        });
        server.addEventListener('close', () => { try { hub.close(1000, 'visitor left'); } catch (_) {} });
        await new Promise((resolve) => { hub.addEventListener('close', resolve); server.addEventListener('close', resolve); });
      } catch (err) {
        console.warn('[Gateway] 订阅实时消息失败，退回心跳轮询:', err);
      }
    })());
  }

  server.addEventListener('close', () => {
    connectedGateways.delete(server);
  });
  server.addEventListener('error', () => {
    connectedGateways.delete(server);
  });

  send(JSON.stringify({
    op: 10,
    d: { heartbeat_interval: 41_250, _trace: ['archive-gateway'] }
  }));

  server.addEventListener('message', (event) => {
    (async () => {
      let packet: any;
      try { packet = JSON.parse(String(event.data)); } catch (_) { return; }

      if (packet?.op === 6) { // RESUME：归档网关没有可重放的事件，直接确认恢复，避免客户端卡在 RESUMING 后重新全量 IDENTIFY
        send(JSON.stringify({ op: 0, t: 'RESUMED', s: Number(packet?.d?.seq || 0) + 1, d: { _trace: ['archive-gateway'] } }));
        return;
      }

      if (packet?.op === 1 || packet?.op === 40) { // Heartbeat；新版客户端用 op 40 (QoS heartbeat)，不回 op 11 会 ACK TIMEOUT 重连
        send(JSON.stringify({ op: 11, d: null }));
        // 自适应检查 D1 中云端定时同步入库的新消息并实时推送到客户端
        try {
          const rows = await env.DB.prepare(
            'SELECT payload, inserted_at FROM message_cache WHERE inserted_at > ? ORDER BY inserted_at ASC LIMIT 50'
          ).bind(lastInsertedAt).all<{ payload: unknown; inserted_at: number }>();
          for (const row of rows.results || []) {
            lastInsertedAt = Math.max(lastInsertedAt, Number(row.inserted_at) || 0);
            try {
              push('MESSAGE_CREATE', unpack(row.payload) as Message);
            } catch (_) {}
          }
        } catch (_) {}
        return;
      }

      if (packet?.op === 2) { // IDENTIFY
        const guildId = GUILD_ID;
        const user = getMockUser();
        const groups = await readChannelMetadata(env);
        const threadMetas = await readThreadMeta(env);
        const channels: any[] = [];
        let pos = 0;
        for (const group of groups) {
          if (group.id) {
            channels.push({
              id: group.id,
              guild_id: guildId,
              name: group.name,
              type: 4,
              position: pos++,
              parent_id: null,
              permission_overwrites: [],
              flags: 0
            });
          }
          for (const ch of group.channels || []) {
            if (ch.type === 11 || ch.type === 12) continue; // 帖子走 guild.threads / threads/search
            channels.push({
              ...(ch.type === 15 ? { available_tags: [], default_reaction_emoji: null, default_sort_order: null, default_forum_layout: 0 } : {}),
              id: ch.id,
              guild_id: guildId,
              name: ch.name,
              type: ch.type ?? 0,
              position: pos++,
              parent_id: group.id || null,
              permission_overwrites: [],
              topic: null,
              nsfw: false,
              rate_limit_per_user: 0,
              last_message_id: null,
              flags: 0
            });
          }
        }

        const guildProperties = {
          id: guildId,
          name: GUILD_NAME,
          description: `${GUILD_NAME} archive`,
          icon: GUILD_ICON,
          splash: null,
          banner: null,
          home_header: null,
          features: ['COMMUNITY', 'NEWS', 'THREADS_ENABLED'],
          preferred_locale: LOCALE,
          owner_id: GUILD_OWNER_ID,
          application_id: null,
          afk_channel_id: null,
          afk_timeout: 300,
          system_channel_id: null,
          verification_level: 0,
          explicit_content_filter: 0,
          default_message_notifications: 0,
          mfa_level: 0,
          vanity_url_code: null,
          premium_tier: 0,
          premium_progress_bar_enabled: false,
          system_channel_flags: 0,
          discovery_splash: null,
          rules_channel_id: null,
          public_updates_channel_id: null,
          safety_alerts_channel_id: null,
          max_video_channel_users: 25,
          max_members: 100000,
          nsfw_level: 0,
          hub_type: null,
          latest_onboarding_question_id: null,
          incidents_data: null,
          inventory_settings: null,
          embed_enabled: false,
          embed_channel_id: null
        };

        const fullGuild = {
          id: guildId,
          properties: guildProperties,
          name: GUILD_NAME,
          icon: GUILD_ICON,
          splash: null,
          banner: null,
          description: `${GUILD_NAME} archive`,
          owner_id: GUILD_OWNER_ID,
          permissions: '2147483647',
          roles: [
            {
              id: guildId,
              name: '@everyone',
              color: 0,
              hoist: false,
              position: 0,
              permissions: '1071698660929',
              managed: false,
              mentionable: false,
              flags: 0
            }
          ],
          emojis: [],
          stickers: [],
          features: ['COMMUNITY', 'NEWS', 'THREADS_ENABLED'],
          channels,
          members: [
            {
              user,
              roles: [],
              joined_at: '2024-01-01T00:00:00.000000+00:00',
              deaf: false,
              mute: false,
              flags: 0
            }
          ],
          threads: threadMetas.filter((thread) => thread.archived !== 1).map((thread) => threadChannelObject(thread, guildId)),
          stage_instances: [],
          guild_scheduled_events: [],
          joined_at: '2024-01-01T00:00:00.000000+00:00',
          large: false,
          unavailable: false,
          member_count: 1,
          voice_states: [],
          system_channel_flags: 0,
          system_channel_id: null,
          afk_timeout: 300,
          afk_channel_id: null,
          verification_level: 0,
          default_message_notifications: 0,
          explicit_content_filter: 0,
          mfa_level: 0,
          application_id: null,
          premium_tier: 0,
          premium_subscription_count: 0,
          vanity_url_code: null,
          preferred_locale: LOCALE,
          rules_channel_id: null,
          public_updates_channel_id: null,
          presences: [],
          guild_hashes: {},
          discovery_splash: null,
          max_video_channel_users: 25
        };

        const origin = new URL(request.url).origin;
        const resumeGatewayUrl = origin.replace(/^http/, 'ws') + '/gateway';

        // 1. Send READY (aligned with Discord Web Build 589596)
        send(JSON.stringify({
          op: 0,
          t: 'READY',
          s: 1,
          d: {
            v: packet?.d?.v || 9,
            user,
            guilds: [fullGuild],
            session_id: 'archive-session-01',
            session_type: 'normal',
            resume_gateway_url: resumeGatewayUrl,
            private_channels: [],
            merged_members: [
              [
                {
                  user_id: user.id,
                  roles: [],
                  joined_at: '2024-01-01T00:00:00.000000+00:00',
                  deaf: false,
                  mute: false,
                  flags: 0
                }
              ]
            ],
            users: [user],
            relationships: [],
            game_relationships: [],
            presences: [],
            read_state: { entries: [], partial: false, version: 1 },
            user_guild_settings: {
              entries: [
                {
                  guild_id: guildId,
                  channel_overrides: [],
                  muted: false,
                  message_notifications: 1,
                  suppress_everyone: true,
                  suppress_roles: false,
                  mobile_push: true
                }
              ],
              version: 0,
              partial: false
            },
            notification_settings: {
              flags: 0
            },
            auth: {
              authenticator_types: [2, 3]
            },
            consents: {
              personalization: {
                consented: false
              }
            },
            user_settings: {
              locale: LOCALE,
              theme: 'light',
              explicit_content_filter: 0,
              animate_emoji: true,
              gif_auto_play: true,
              render_reactions: true,
              animate_stickers: 1,
              enable_tts_command: false,
              message_display_compact: false,
              convert_emoticons: false,
              inline_attachment_media: true,
              inline_embed_media: true,
              status: 'online'
            },
            user_settings_proto: await readUserSettings(env, 1),
            connected_accounts: [],
            analytics_token: null,
            experiments: [],
            guild_experiments: guildExperiments,
            apex_experiments: {
              assignments: {
                '1': {
                  [user.id]: apexExperiments,
                },
              },
            },
            tutorial: null,
            friend_suggestion_count: 0,
            sessions: [
              {
                session_id: 'archive-session-01',
                status: 'online',
                client_info: { client: 'web', os: 'mac', version: 0 },
                activities: []
              }
            ],
            auth_session_id_hash: 'archive-hash',
            country_code: 'US',
            subdivision_code: 'CA',
            api_code_version: 1,
            explicit_content_scan_version: 4,
            ad_personalization_toggles_disabled: true,
            regional_feature_config: {
              age_gated_features: 0,
              teen_by_default_settings: 0
            },
            guild_join_requests: [],
            linked_users: [],
            _trace: ['archive-gateway']
          }
        }));

        // 2. Send READY_SUPPLEMENTAL
        send(JSON.stringify({
          op: 0,
          t: 'READY_SUPPLEMENTAL',
          s: 2,
          d: {
            guilds: [
              {
                id: guildId,
                voice_states: [],
                embedded_activities: []
              }
            ],
            merged_members: [[]],
            merged_presences: { guilds: [[]], friends: [] },
            lazy_private_channels: [],
            disclose: []
          }
        }));
        return;
      }

      if (packet?.op === 14) { // LAZY_REQUEST
        const targetGuildId = packet?.d?.guild_id;
        if (targetGuildId) {
          send(JSON.stringify({
            op: 0,
            t: 'GUILD_MEMBER_LIST_UPDATE',
            s: 3,
            d: {
              id: 'everyone',
              guild_id: targetGuildId,
              ops: [
                {
                  op: 'SYNC',
                  range: [0, 99],
                  items: [
                    {
                      member: {
                        user: getMockUser(),
                        roles: [],
                        presence: { status: 'online', activities: [], client_status: { web: 'online' } }
                      }
                    }
                  ]
                }
              ],
              groups: [{ id: 'online', count: 1 }],
              online_count: 1,
              member_count: 1
            }
          }));
        }
        return;
      }
    })().catch((err) => {
      console.warn('[Official Gateway] Error processing message:', err);
    });
  });

  return new Response(null, { status: 101, webSocket: client });
}

async function discordAttachmentSourceFromDescriptor(parsed: AttachmentDescriptor, env: Env): Promise<string> {
  if (!env.DISCORD_TOKEN ||
      !/^\d{15,22}$/.test(parsed.channelId || '') ||
      !/^\d{15,22}$/.test(parsed.messageId || '') ||
      !/^\d{15,22}$/.test(parsed.attachmentId || '')) return '';
  const channelId = parsed.channelId!;
  const messageId = parsed.messageId!;
  const attachmentId = parsed.attachmentId!;
  try {
    const headers = {
      Authorization: env.DISCORD_TOKEN,
      'User-Agent': 'Discord-Archive-Client/1.0',
      Accept: 'application/json'
    };
    const exactResp = await discordFetch(
      env,
      `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
      { headers }
    );
    let data: any = exactResp.ok ? await exactResp.json() : null;
    if (!data) {
      const aroundUrl = new URL(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`);
      aroundUrl.searchParams.set('around', messageId);
      aroundUrl.searchParams.set('limit', '100');
      const aroundResp = await discordFetch(env, aroundUrl.toString(), { headers });
      if (!aroundResp.ok) {
        console.warn(`[Media] Discord 附件消息查询失败: exact=${exactResp.status}, around=${aroundResp.status}`);
        return '';
      }
      const around = await aroundResp.json();
      data = Array.isArray(around) ? around.find((item: any) => String(item?.id) === messageId) : null;
    }
    const attachment = (data?.attachments || []).find((item: any) => String(item.id) === attachmentId);
    return attachmentSource(attachment?.url || attachment?.proxy_url);
  } catch (err) {
    console.warn('[Media] Discord 附件索引查询失败:', err);
    return '';
  }
}

function decodeAttachmentDescriptor(token: string): AttachmentDescriptor {
  const decoded = base64UrlDecode(token);
  try {
    const parsed = JSON.parse(decoded) as AttachmentDescriptor;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // Older proxy URLs encoded the source URL directly.
  }
  const source = attachmentSource(decoded);
  return source ? { source } : {};
}

// 头像/表情/贴纸等按 ?size= 回源 Discord CDN：尺寸参数必须进缓存键。之前整个 query 被换成版本号，
// 同一头像第一次被请求的尺寸（常常是回复条里的 32px）会被当成所有尺寸返回，资料卡、大头像都是糊的
const MEDIA_VARIANT_PARAMS = ['size', 'quality', 'animated', 'format', 'passthrough'];

function mediaCacheKey(requestUrl: string, source = '', localPath = ''): Request {
  const key = new URL(requestUrl);
  const variant = MEDIA_VARIANT_PARAMS
    .filter((name) => key.searchParams.has(name))
    .map((name) => `&${name}=${encodeURIComponent(key.searchParams.get(name) || '')}`)
    .join('');
  if (localPath) key.pathname = localPath;
  else if (source) {
    const parsed = new URL(source);
    key.pathname = `/cdn/${parsed.hostname}${parsed.pathname}`;
  }
  key.search = `?v=${MEDIA_CACHE_VERSION}${source ? '' : variant}`;
  return new Request(key.toString(), { method: 'GET' });
}

function mediaHeaders(source: Headers, size?: number): Headers {
  const headers = new Headers();
  for (const name of ['content-type', 'content-language', 'content-disposition', 'cache-control', 'etag', 'last-modified', 'accept-ranges', 'content-range', 'content-encoding']) {
    const value = source.get(name);
    if (value) headers.set(name, value);
  }
  if (size !== undefined) headers.set('content-length', String(size));
  applySecurityHeaders(headers);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  return headers;
}

async function releaseSyncLock(channelId: string, env: Env): Promise<void> {
  try {
    await env.DB.prepare(
      'UPDATE sync_status SET in_flight = 0, lock_expires_at = 0 WHERE channel_id = ?'
    ).bind(channelId).run();
  } catch (_) {
    // Older databases do not have sync_status; the refresh path remains usable.
  }
}

/**
 * 执行频道刷新与消息增量解析入库
 */
async function syncChannelMessages(
  channelId: string,
  env: Env,
  requestedAfter = ''
): Promise<{
  ok: boolean;
  status: string;
  channel_id: string;
  new_count: number;
  messages: Message[];
  refreshed_at: string;
  complete: boolean;
  next_after?: string;
  fetched_count: number;
  message?: string;
  cooldown_remaining_sec?: number;
}> {
  const now = Date.now();
  const continuation = Boolean(requestedAfter);
  let syncRow: {
    last_refreshed_at: number;
    latest_message_id?: string;
    in_flight: number;
    lock_expires_at: number;
  } | undefined;

  // 0a. sync-worker 刚检查过且已是最新的频道，不再请求 Discord
  if (!continuation) {
    try {
      const beat = await env.DB.prepare("SELECT payload FROM metadata WHERE name = 'cron_heartbeat'").first<{ payload: unknown }>();
      const parsed = beat ? unpack(beat.payload) as { at: number; channels: string[] } : null;
      if (parsed && now - parsed.at < SYNC_COOLDOWN_MS && parsed.channels?.includes(channelId)) {
        return {
          ok: true,
          status: 'cooldown',
          channel_id: channelId,
          message: `云端定时同步 ${Math.max(1, Math.floor((now - parsed.at) / 1000))} 秒前已检查过该频道，数据已是最新`,
          cooldown_remaining_sec: Math.ceil((SYNC_COOLDOWN_MS - (now - parsed.at)) / 1000),
          new_count: 0,
          messages: [],
          refreshed_at: new Date(parsed.at).toISOString(),
          complete: true,
          fetched_count: 0
        };
      }
    } catch (_) {}
  }

  // 0. 从 D1 查询跨节点分布式冷却与执行锁状态
  try {
    const row = await env.DB.prepare(
      'SELECT last_refreshed_at, latest_message_id, in_flight, lock_expires_at FROM sync_status WHERE channel_id = ?'
    ).bind(channelId).first<NonNullable<typeof syncRow>>();
    syncRow = row || undefined;

    if (syncRow) {
      if (syncRow.in_flight === 1 && syncRow.lock_expires_at > now) {
        return {
          ok: true,
          status: 'cooldown',
          channel_id: channelId,
          message: '其他访客正在同步该频道，请稍候查看',
          cooldown_remaining_sec: Math.ceil((syncRow.lock_expires_at - now) / 1000),
          new_count: 0,
          messages: [],
          refreshed_at: new Date(syncRow.last_refreshed_at || now).toISOString(),
          complete: false,
          fetched_count: 0
        };
      }

      const elapsed = now - (syncRow.last_refreshed_at || 0);
      if (!continuation && elapsed < SYNC_COOLDOWN_MS) {
        const remainingSec = Math.ceil((SYNC_COOLDOWN_MS - elapsed) / 1000);
        return {
          ok: true,
          status: 'cooldown',
          channel_id: channelId,
          message: `频道在 ${Math.max(1, Math.floor(elapsed / 1000))} 秒前已完成刷新，数据已是最新`,
          cooldown_remaining_sec: remainingSec,
          new_count: 0,
          messages: [],
          refreshed_at: new Date(syncRow.last_refreshed_at).toISOString(),
          complete: true,
          fetched_count: 0
        };
      }
    }

    // 原子化写入分布式执行锁 (有效期 15 秒)
    await env.DB.prepare(
      'INSERT INTO sync_status (channel_id, last_refreshed_at, in_flight, lock_expires_at) ' +
      'VALUES (?, 0, 1, ?) ' +
      'ON CONFLICT(channel_id) DO UPDATE SET in_flight=1, lock_expires_at=excluded.lock_expires_at'
    ).bind(channelId, now + 15_000).run();
  } catch (d1Err) {
    console.warn('[Sync] 检查 D1 分布式锁异常:', d1Err);
  }

  // 1. 获取当前频道在 D1 中的最新消息 ID
  let latestMessageId = syncRow?.latest_message_id || '';
  try {
    const latestBlock = await env.DB.prepare(
      'SELECT payload FROM blocks WHERE channel = ? ORDER BY seq DESC LIMIT 1'
    ).bind(channelId).first<{ payload: unknown }>();

    if (latestBlock && latestBlock.payload) {
      const msgs: Message[] = unpack(latestBlock.payload);
      for (const msg of msgs) {
        latestMessageId = maxSnowflake(latestMessageId, msg.id);
      }
    }
  } catch (e) {
    console.warn('[Sync] 查询最新消息 ID 异常:', e);
  }
  latestMessageId = maxSnowflake(latestMessageId, requestedAfter);

  // 2. 上游数据获取策略 (Discord API Direct 或 Origin Tunnel Fallback)
  let rawMessages: any[] = [];
  let upstreamSuccess = false;
  let syncErrorMsg = '';
  let complete = true;
  let nextAfter = latestMessageId;
  let fetchedCount = 0;

  if (env.DISCORD_TOKEN) {
    try {
      // 策略 A: 边缘直连 Discord API。Worker 单次只取有限页，前端用游标继续。
      let currentAfter = latestMessageId;
      for (let round = 0; round < SYNC_MAX_PAGES; round++) {
        const discordUrl = new URL(`https://discord.com/api/v10/channels/${channelId}/messages`);
        discordUrl.searchParams.set('limit', String(SYNC_PAGE_SIZE));
        if (currentAfter) {
          discordUrl.searchParams.set('after', currentAfter);
        }

        let resp: Response;
        try {
          resp = await discordFetch(env, discordUrl.toString(), {
            headers: {
              Authorization: env.DISCORD_TOKEN,
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
              'Accept': '*/*',
              'Accept-Language': `${LOCALE},en;q=0.8`
            }
          });
        } catch (limitErr: any) {
          // 已经拿到的页先入库，剩下的下次用游标继续
          if (limitErr.status !== 429 || !rawMessages.length) throw limitErr;
          complete = false;
          syncErrorMsg = limitErr.message;
          break;
        }

        if (resp.ok) {
          const batch: any[] = await resp.json();
          upstreamSuccess = true;
          if (Array.isArray(batch) && batch.length > 0) {
            rawMessages.push(...batch);
            fetchedCount += batch.length;
            let maxId = currentAfter;
            for (const b of batch) {
              if (b.id) maxId = maxSnowflake(maxId, b.id);
            }
            if (maxId === currentAfter) {
              complete = false;
              nextAfter = currentAfter;
              syncErrorMsg = '上游游标没有前进，已暂停本次刷新';
              break;
            }
            currentAfter = maxId;
            nextAfter = currentAfter;
            complete = batch.length < SYNC_PAGE_SIZE;
            if (complete) break;
          } else {
            complete = true;
            break;
          }
        } else {
          const text = await resp.text();
          console.warn(`[Sync] Discord API direct error (${resp.status}):`, text.slice(0, 150));
          syncErrorMsg = `Discord API 异常 (${resp.status})`;
          complete = false;
          break;
        }
      }
    } catch (dErr: any) {
      if (dErr.status === 429) {
        await releaseSyncLock(channelId, env);
        throw dErr;
      }
      syncErrorMsg = dErr.message || 'Discord 连接超时';
      complete = false;
      console.warn('[Sync] Discord API direct exception:', dErr);
    }
  }

  // 策略 B: 若策略 A 未成功或无 Token，降级尝试穿透回源至 Origin Tunnel / 本地抓取网关
  if (!upstreamSuccess && env.ORIGIN_URL) {
    const origin = env.ORIGIN_URL.replace(/\/+$/, '');
    const originFetchUrl = `${origin}/api/sync/refresh?channel=${encodeURIComponent(channelId)}&after=${encodeURIComponent(latestMessageId)}`;
    
    try {
      const resp = await fetch(originFetchUrl, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Cloudflare-Worker-Sync-Dispatcher/1.0'
        }
      });
      if (resp.ok) {
        const data: any = await resp.json();
        if (data && Array.isArray(data.messages)) {
          rawMessages = data.messages;
          upstreamSuccess = true;
          fetchedCount = Number(data.fetched_count ?? data.messages.length);
          complete = data.complete !== false;
          nextAfter = data.next_after || nextAfter;
        } else if (data && typeof data.new_count === 'number') {
          await releaseSyncLock(channelId, env);
          return {
            ok: true,
            status: 'success',
            channel_id: channelId,
            new_count: data.new_count,
            messages: (data.messages || []).map(localizeMessage),
            refreshed_at: new Date().toISOString(),
            complete: data.complete !== false,
            next_after: data.next_after,
            fetched_count: Number(data.fetched_count || data.new_count)
          };
        }
      } else {
        syncErrorMsg = `回源网关异常 (${resp.status})`;
      }
    } catch (originErr: any) {
      syncErrorMsg = syncErrorMsg || '上游同步通道与本地网关均未连接';
      console.warn('[Sync] 回源抓取未响应:', originErr);
    }
  }

  // 严禁吞掉错误并伪造“已是最新”！
  if (!upstreamSuccess) {
    await releaseSyncLock(channelId, env);
    return {
      ok: false,
      status: 'upstream_unavailable',
      channel_id: channelId,
      new_count: 0,
      messages: [],
      message: syncErrorMsg || '上游同步通道暂时不可用，已呈现最新离线缓存',
      refreshed_at: new Date().toISOString(),
      complete: false,
      fetched_count: fetchedCount
    };
  }

  // 3. 数据规整与差量去重
  const newMessages: Message[] = [];
  const seenIds = new Set<string>();
  if (Array.isArray(rawMessages) && rawMessages.length > 0) {
    for (const raw of rawMessages) {
      if (!raw.id || raw.id === latestMessageId || seenIds.has(raw.id)) continue;
      seenIds.add(raw.id);
      // 若消息已有标准格式
      if (raw.created_at && typeof raw.owner === 'boolean') {
        newMessages.push(raw);
        continue;
      }

      // 从原始 Discord API 格式转换
      const authorId = raw.author?.id || '';
      const authorName = raw.author?.global_name || raw.author?.username || '用户';
      const isOwner = authorId === GUILD_OWNER_ID;
      const avatarUrl = raw.author?.avatar
        ? `https://cdn.discordapp.com/avatars/${authorId}/${raw.author.avatar}.webp?size=64`
        : (raw.avatar || '');

      const atts = (raw.attachments || []).map((a: any) => ({
        id: a.id ? String(a.id) : undefined,
        filename: a.filename || '附件',
        url: a.url || a.proxy_url || `/attachments/${raw.id}_${a.id}.bin`,
        content_type: a.content_type || 'application/octet-stream',
        size: a.size || 0,
        width: a.width,
        height: a.height
      }));

      const ems = (raw.embeds || []).map(normalizeDiscordEmbed).filter(Boolean);

      newMessages.push({
        id: raw.id,
        channel_id: raw.channel_id || channelId,
        author_id: authorId,
        author: authorName,
        username: raw.author?.username || authorName,
        avatar: avatarUrl,
        content: raw.content || '',
        created_at: raw.timestamp || raw.created_at || new Date().toISOString(),
        owner: isOwner,
        reply_author: raw.referenced_message?.author?.global_name || raw.referenced_message?.author?.username,
        reply_content: raw.referenced_message?.content,
        reply_channel_id: raw.message_reference?.channel_id,
        reply_message_id: raw.message_reference?.message_id,
        attachments: atts,
        embeds: ems,
        stickers: stickersFromDiscord(raw)
      });
    }
  }

  // 按时间升序排列
  newMessages.sort((a, b) => (a.id < b.id ? -1 : 1));
  for (let i = 0; i < newMessages.length; i++) {
    newMessages[i] = localizeMessage(newMessages[i]);
  }

  // 4. 若有新消息，原子化追加写入 D1
  if (newMessages.length > 0) {
    try {
      const maxSeqRow = await env.DB.prepare(
        'SELECT COALESCE(MAX(seq), -1) as max_seq FROM blocks WHERE channel = ?'
      ).bind(channelId).first<{ max_seq: number }>();
      const nextSeq = (maxSeqRow?.max_seq ?? -1) + 1;

      const blockPayload = JSON.stringify(newMessages);
      const payloadBytes = new TextEncoder().encode(blockPayload);

      // 写入新块
      await env.DB.prepare(
        'INSERT INTO blocks (channel, seq, count, raw_bytes, payload) VALUES (?, ?, ?, ?, ?)'
      ).bind(channelId, nextSeq, newMessages.length, payloadBytes.byteLength, payloadBytes).run();
      try {
        await env.DB.prepare(
          'INSERT OR REPLACE INTO block_index (channel, seq, first_id, last_id, count) VALUES (?, ?, CAST(? AS INTEGER), CAST(? AS INTEGER), ?)'
        ).bind(channelId, nextSeq, newMessages[0].id, newMessages[newMessages.length - 1].id, newMessages.length).run();
      } catch (indexErr) {
        console.warn('[Sync] block_index 写入失败，该块将按未索引块读取:', indexErr);
      }

      // 更新频道总消息计数元数据
      const channelsMeta = await env.DB.prepare(
        'SELECT payload FROM metadata WHERE name = ?'
      ).bind('channels').first<{ payload: unknown }>();

      if (channelsMeta && channelsMeta.payload) {
        const categories = unpack(channelsMeta.payload);
        let updated = false;
        for (const cat of categories) {
          const targetCh = cat.channels?.find((c: any) => c.id === channelId);
          if (targetCh) {
            targetCh.count = (targetCh.count || 0) + newMessages.length;
            updated = true;
            break;
          }
        }
        if (updated) {
          const updatedJson = new TextEncoder().encode(JSON.stringify(categories));
          await env.DB.prepare('UPDATE metadata SET payload = ? WHERE name = ?')
            .bind(updatedJson, 'channels')
            .run();
        }
      }

      // 更新同步记录
      const newestMsg = newMessages[newMessages.length - 1];
      nextAfter = maxSnowflake(nextAfter, newestMsg.id);
      await env.DB.prepare(
        'INSERT INTO sync_status (channel_id, last_refreshed_at, latest_message_id, in_flight, lock_expires_at) ' +
        'VALUES (?, ?, ?, 0, 0) ' +
        'ON CONFLICT(channel_id) DO UPDATE SET ' +
        'last_refreshed_at=CASE WHEN excluded.last_refreshed_at > 0 THEN excluded.last_refreshed_at ELSE sync_status.last_refreshed_at END, ' +
        'latest_message_id=excluded.latest_message_id, in_flight=0, lock_expires_at=0'
      ).bind(channelId, complete ? Date.now() : 0, nextAfter).run();

      // 实时推送到已连接的官方客户端 WebSocket
      for (const msg of newMessages) {
        broadcastGatewayMessage(msg);
      }
    } catch (writeErr) {
      console.error('[Sync] 写入 D1 数据库失败:', writeErr);
    }
  } else {
    // 只有完整核验才更新时间戳；分页未完成时必须保留“待继续”状态。
    try {
      await env.DB.prepare(
        'INSERT INTO sync_status (channel_id, last_refreshed_at, latest_message_id, in_flight, lock_expires_at) ' +
        'VALUES (?, ?, ?, 0, 0) ' +
        'ON CONFLICT(channel_id) DO UPDATE SET ' +
        'last_refreshed_at=CASE WHEN excluded.last_refreshed_at > 0 THEN excluded.last_refreshed_at ELSE sync_status.last_refreshed_at END, ' +
        'latest_message_id=excluded.latest_message_id, in_flight=0, lock_expires_at=0'
      ).bind(channelId, complete ? Date.now() : 0, nextAfter).run();
    } catch (_) {}
  }

  await releaseSyncLock(channelId, env);

  return {
    ok: true,
    status: 'success',
    channel_id: channelId,
    new_count: newMessages.length,
    messages: newMessages,
    refreshed_at: new Date().toISOString(),
    complete,
    next_after: complete ? undefined : nextAfter,
    fetched_count: fetchedCount
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    configure(env);
    if (!GUILD_ID) {
      return new Response('DISCORD_GUILD_ID 未配置 / DISCORD_GUILD_ID is not set', {
        status: 503,
        headers: applySecurityHeaders(new Headers({ 'Content-Type': 'text/plain; charset=utf-8' }))
      });
    }
    const publicAccess = env.PUBLIC_ACCESS === 'true';
    const password = env.ACCESS_PASSWORD || '';
    if (!password && !publicAccess) {
      return new Response('ACCESS_PASSWORD 未配置（或设置 PUBLIC_ACCESS = "true" 公开访问） / Set ACCESS_PASSWORD, or PUBLIC_ACCESS = "true"', {
        status: 503,
        headers: applySecurityHeaders(new Headers({ 'Content-Type': 'text/plain; charset=utf-8' }))
      });
    }
    const expectedToken = password ? await computeAuthToken(password) : '';

    // 0. 爬虫协议：全网禁止抓取收录
    if (url.pathname === '/robots.txt') {
      return new Response("User-agent: *\nDisallow: /\n", {
        headers: { 'Content-Type': 'text/plain', 'X-Robots-Tag': 'noindex, nofollow, noarchive' }
      });
    }

    // 0.5 官方客户端静态资产（无需认证）；缺失的分片向 discord.com / canary 回源
    if (url.pathname.startsWith('/assets/')) {
      const local = await env.ASSETS.fetch(request);
      const localType = local.headers.get('content-type') || '';
      if (local.status === 200 && !localType.includes('text/html')) {
        const headers = new Headers(local.headers);
        applySecurityHeaders(headers);
        headers.set('Cache-Control', 'public, max-age=31536000, immutable');
        return new Response(request.method === 'HEAD' ? null : local.body, { status: 200, headers });
      }
      const debugLogs: any[] = [];
      for (const originBase of ['https://discord.com', 'https://canary.discord.com']) {
        try {
          const originUrl = new URL(`${originBase}${url.pathname}${url.search}`);
          const originResp = await fetch(new Request(originUrl, {
            method: request.method,
            headers: new Headers({
              Accept: request.headers.get('Accept') || '*/*',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
            })
          }));
          const originType = originResp.headers.get('content-type') || '';
          const errBody = originResp.status >= 400 ? await originResp.text() : ""; debugLogs.push({ originBase, status: originResp.status, type: originType, errBody: errBody.slice(0, 200) });
          if (originResp.ok && !originType.includes('text/html')) {
            const headers = new Headers(originResp.headers);
            applySecurityHeaders(headers);
            headers.set('Cache-Control', 'public, max-age=31536000, immutable');
            return new Response(request.method === 'HEAD' ? null : originResp.body, { status: originResp.status, headers });
          }
        } catch (error: any) {
          debugLogs.push({ originBase, error: error?.message || String(error) });
        }
      }
      return new Response('Asset not found: ' + JSON.stringify(debugLogs), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    // 1. 免密 URL 参数快捷授权支持 (例如 https://...?auth=YOUR_PASSWORD)
    const urlAuth = url.searchParams.get('auth');
    if (urlAuth === password) {
      const cleanUrl = new URL(request.url);
      cleanUrl.searchParams.delete('auth');
          const headers = new Headers({
            Location: cleanUrl.toString(),
            'Set-Cookie': `${AUTH_COOKIE}=${expectedToken}; Path=/; Max-Age=2592000; SameSite=Lax; Secure; HttpOnly`
      });
      applySecurityHeaders(headers);
      return new Response(null, { status: 302, headers });
    }

    // 2. 身份校验拦截中间件
    const cookies = parseCookies(request.headers.get('Cookie'));
    const queryPass = url.searchParams.get('auth') || url.searchParams.get('pwd') || '';
    const queryAuthed = Boolean(password && queryPass === password);
    // 官方客户端与站点同源，XHR 和网关 WebSocket 握手都会带上口令 cookie，所以 /api/v9 和 /gateway 不需要任何豁免
    const isAuthed =
      publicAccess ||
      queryAuthed ||
      (Boolean(expectedToken) && cookies[AUTH_COOKIE] === expectedToken) ||
      (Boolean(password) && request.headers.get('Authorization') === `Bearer ${password}`) ||
      url.pathname.startsWith('/detectables/');

    // 表单提交登录验证
    if (url.pathname === '/api/auth/login' && request.method === 'POST') {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const now = Date.now();
      const failure = loginFailures.get(ip);
      if (failure && failure.resetAt > now && failure.count >= 5) {
        const retryAfter = Math.ceil((failure.resetAt - now) / 1000);
        const headers = applySecurityHeaders(new Headers({
          'Content-Type': 'text/html; charset=utf-8',
          'Retry-After': String(retryAfter)
        }));
        return new Response(renderLoginPage(`尝试次数过多，请 ${retryAfter} 秒后重试`), {
          status: 429,
          headers
        });
      }
      const formData = await request.formData();
      const enteredPass = formData.get('password');
      if (enteredPass === password) {
        loginFailures.delete(ip);
        const headers = new Headers({
          Location: await officialHome(env),
          'Set-Cookie': `${AUTH_COOKIE}=${expectedToken}; Path=/; Max-Age=2592000; SameSite=Lax; Secure; HttpOnly`
        });
        applySecurityHeaders(headers);
        return new Response(null, { status: 302, headers });
      } else {
        const next = failure && failure.resetAt > now
          ? { count: failure.count + 1, resetAt: failure.resetAt }
          : { count: 1, resetAt: now + 15 * 60_000 };
        loginFailures.set(ip, next);
        const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8' });
        applySecurityHeaders(headers);
        return new Response(renderLoginPage('密码错误，请重新输入'), { status: 401, headers });
      }
    }

    // 未登录访客拦截 (含 /app, /login, /channels/* 页面访问)
    if (!isAuthed) {
      if (
        url.pathname === '/' ||
        url.pathname === '/app' ||
        url.pathname.startsWith('/app/') ||
        url.pathname === '/login' ||
        url.pathname === '/official' ||
        url.pathname === '/archive' ||
        url.pathname.endsWith('.html') ||
        url.pathname.startsWith('/channels/')
      ) {
        const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8' });
        applySecurityHeaders(headers);
        return new Response(renderLoginPage(), { status: 401, headers });
      }
      return new Response(JSON.stringify({ error: 'Unauthorized: Access password required' }), {
        status: 401,
        headers: applySecurityHeaders(new Headers({ 'Content-Type': 'application/json' }))
      });
    }

    // 3. OPTIONS 跨域预检
    if (request.method === 'OPTIONS') {
      const headers = new Headers({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      });
      applySecurityHeaders(headers);
      return new Response(null, { status: 204, headers });
    }

    // Telemetry, Error Reporting Proxy, Metrics (Discord client analytics)
    if (
      url.pathname.startsWith('/error-reporting-proxy') ||
      url.pathname.startsWith('/science') ||
      url.pathname.startsWith('/metrics') ||
      url.pathname.startsWith('/track')
    ) {
      const headers = new Headers({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      });
      applySecurityHeaders(headers);
      return new Response(null, { status: 204, headers });
    }

    const gateway = (url.pathname === '/gateway' || url.pathname === '/gateway/') ? officialGateway(request, env, ctx) : null;
    if (gateway) return gateway;

    const wrapJson = (data: unknown, status = 200) => {
      const headers = new Headers({
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
      });
      applySecurityHeaders(headers);
      if (status === 204 || status === 205 || status === 304) {
        return new Response(null, { status, headers });
      }
      headers.set('Content-Type', 'application/json; charset=utf-8');
      return new Response(JSON.stringify(data), { status, headers });
    };

    if (url.pathname.startsWith('/detectables/')) {
      return wrapJson([]);
    }

    // Official Discord Web compatibility surface. The UI stays official; archive data is adapted here.
    if (/^\/api\/v\d+\//.test(url.pathname)) {
      try {
        const official = await officialApiBody(url, env, request);
        if (official) return wrapJson(official.body, official.status);
      } catch (err: any) {
        return wrapJson({ message: err.message || 'Official UI API failed' }, err.status || 502);
      }
    }

    // 自研阅读器（/、/archive）及其 /api/channels|users|search|messages|cache/around|position|sync/refresh 已下线，只保留官方界面

    if (url.pathname === '/api/sync/push' && request.method === 'POST') {
      try {
        const body: any = await request.json();
        const incomingMessages: any[] = Array.isArray(body?.messages) ? body.messages : (body ? [body] : []);
        if (!incomingMessages.length) {
          return wrapJson({ ok: true, count: 0 }, 200);
        }

        const channelId = incomingMessages[0].channel_id || url.searchParams.get('channel') || '';
        const normalizedList: Message[] = [];
        let maxId = '';

        for (const raw of incomingMessages) {
          if (!raw.id) continue;
          const authorId = raw.author_id || raw.author?.id || '';
          const authorName = raw.author?.global_name || raw.author?.username || raw.author || '用户';
          const isOwner = raw.owner ?? (authorId === GUILD_OWNER_ID);
          const avatarUrl = raw.author?.avatar
            ? `https://cdn.discordapp.com/avatars/${authorId}/${raw.author.avatar}.webp?size=64`
            : (raw.avatar || '');

          const atts = (raw.attachments || []).map((a: any) => ({
            id: a.id ? String(a.id) : undefined,
            filename: a.filename || '附件',
            url: a.url || a.proxy_url || `/attachments/${raw.id}_${a.id}.bin`,
            content_type: a.content_type || 'application/octet-stream',
            size: a.size || 0,
            width: a.width,
            height: a.height
          }));

          const ems = (raw.embeds || []).map(normalizeDiscordEmbed).filter(Boolean);

          const msg: Message = {
            id: String(raw.id),
            channel_id: raw.channel_id || channelId,
            author_id: authorId,
            author: authorName,
            username: raw.username || raw.author?.username || authorName,
            avatar: avatarUrl,
            content: raw.content || '',
            created_at: raw.created_at || raw.timestamp || new Date().toISOString(),
            owner: Boolean(isOwner),
            reply_author: raw.reply_author || raw.referenced_message?.author?.global_name || raw.referenced_message?.author?.username,
            reply_content: raw.reply_content || raw.referenced_message?.content,
            reply_channel_id: raw.reply_channel_id || raw.referenced_message?.channel_id,
            reply_message_id: raw.reply_message_id || raw.referenced_message?.id,
            attachments: atts,
            embeds: ems,
            stickers: raw.stickers || stickersFromDiscord(raw),
            message_type: Number(raw.message_type || raw.type || 0),
            remote: true
          };

          normalizedList.push(msg);
          maxId = maxSnowflake(maxId, msg.id);

          // 写入 D1 message_cache
          const payload = new TextEncoder().encode(JSON.stringify(msg));
          await env.DB.prepare(
            'INSERT INTO message_cache (channel, message_id, created_at, payload, inserted_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(channel, message_id) DO UPDATE SET created_at = excluded.created_at, payload = excluded.payload'
          ).bind(msg.channel_id, msg.id, msg.created_at, payload, Date.now()).run();

          // 实时推送到所有已连接的官方 UI 客户端
          broadcastGatewayMessage(msg);
        }

        if (channelId && maxId) {
          await env.DB.prepare(
            'INSERT INTO sync_status (channel_id, last_refreshed_at, latest_message_id, in_flight, lock_expires_at) ' +
            'VALUES (?, ?, ?, 0, 0) ' +
            'ON CONFLICT(channel_id) DO UPDATE SET last_refreshed_at = excluded.last_refreshed_at, latest_message_id = MAX(sync_status.latest_message_id, excluded.latest_message_id), in_flight = 0, lock_expires_at = 0'
          ).bind(channelId, Date.now(), maxId).run();
        }

        return wrapJson({ ok: true, count: normalizedList.length }, 200);
      } catch (err: any) {
        return wrapJson({ error: err.message }, 500);
      }
    }

    // 9. 媒体附件交付：本地归档优先，Discord CDN 兜底，HEAD/Range 不污染完整对象缓存。
    if (
      url.pathname.startsWith('/attachments/') ||
      url.pathname.startsWith('/snapshot-attachments/') ||
      url.pathname.startsWith('/stickers/') ||
      url.pathname.startsWith('/emojis/') ||
      url.pathname.startsWith('/avatars/')
    ) {
      const isProxyAttachment = url.pathname.startsWith(ATTACHMENT_PROXY_PREFIX);
      const proxyToken = isProxyAttachment ? url.pathname.slice(ATTACHMENT_PROXY_PREFIX.length) : '';
      const legacyToken = !isProxyAttachment ? (url.searchParams.get('r') || '') : '';
      let descriptor: AttachmentDescriptor = {};
      try {
        descriptor = proxyToken ? decodeAttachmentDescriptor(proxyToken) : (legacyToken ? decodeAttachmentDescriptor(legacyToken) : {});
      } catch (_) {}
      let proxySource = attachmentSource(descriptor.source);
      let proxyLocalPath = safeLocalMediaPath(descriptor.localPath);
      if (!proxyLocalPath && descriptor.messageId && descriptor.attachmentId) {
        proxyLocalPath = attachmentLocalPath('', descriptor.messageId, descriptor.attachmentId);
      }
      const isAttachmentProxy = isProxyAttachment || Boolean(legacyToken);
      if ((isProxyAttachment || legacyToken) && descriptor.version !== MEDIA_CACHE_VERSION) {
        return new Response('附件 URL 已失效，请刷新页面获取最新 URL', { status: 410, headers: applySecurityHeaders(new Headers()) });
      }
      const range = request.method === 'GET' ? request.headers.get('Range') : '';
      const cacheable = !range;
      const cache = caches.default;
      const cacheKey = mediaCacheKey(request.url, proxySource, proxyLocalPath || safeLocalMediaPath(url.pathname));
      const mediaKey = `${MEDIA_CACHE_VERSION}/${new URL(cacheKey.url).pathname.replace(/^\/+/, '')}`;

      const deliver = (
        originResp: Response,
        source: string,
        fromLocalOrigin = false,
        refreshedByDiscord = false
      ): Response | null => {
        if (!originResp.ok) return null;
        const status = originResp.status;
        const length = Number(originResp.headers.get('content-length') || '');
        const headers = mediaHeaders(originResp.headers, Number.isFinite(length) && length >= 0 ? length : undefined);
        headers.set('X-Media-Cache', source);
        if (fromLocalOrigin) headers.set('X-Origin-Fallback', 'HIT-ORIGIN');
        if (refreshedByDiscord) headers.set('X-Media-Refresh', 'DISCORD-API');
        if (cacheable && status === 200) {
          const copy = originResp.clone();
          ctx.waitUntil((async () => {
            await cache.put(cacheKey, new Response(copy.body, { status: 200, headers }));
            if (env.MEDIA) {
              await env.MEDIA.put(mediaKey, originResp.clone().body, {
                httpMetadata: {
                  contentType: originResp.headers.get('content-type') || 'application/octet-stream',
                  contentDisposition: originResp.headers.get('content-disposition') || undefined
                }
              });
            }
          })().catch((cacheErr) => console.warn('[Media] 附件缓存写入失败:', cacheErr)));
        }
        return new Response(request.method === 'HEAD' ? null : originResp.body, { status, headers });
      };

      const originBase = (env.ORIGIN_URL || '').replace(/\/+$/, '');
      const fetchOriginPath = async (path: string): Promise<Response> => {
        if (!originBase) return new Response(null, { status: 404 }); // 未配置 ORIGIN_URL
        const headers = new Headers({
          Accept: request.headers.get('Accept') || '*/*',
          'User-Agent': 'Cloudflare-Worker-Origin-Fallback/1.0'
        });
        if (range) headers.set('Range', range);
        return fetch(new Request(`${originBase}${path}`, { method: 'GET', headers }));
      };

      // 9.1 优先检查 Pages Static Assets 静态包（排除 Pages 404 SPA 回退的 text/html）
      const assetResp = await env.ASSETS.fetch(request);
      const ct = assetResp.headers.get('content-type') || '';
      if (assetResp.status === 200 && !ct.includes('text/html')) {
        const h = new Headers(assetResp.headers);
        applySecurityHeaders(h);
        h.set('Cache-Control', 'public, max-age=31536000, immutable');
        h.set('X-Edge-Source', 'PAGES_ASSET');
        return new Response(request.method === 'HEAD' ? null : assetResp.body, { status: 200, headers: h });
      }

      // 9.2 可选的 R2 持久对象缓存；未绑定时继续使用 Cache API。
      if (env.MEDIA && cacheable) {
        try {
          const object = await env.MEDIA.get(mediaKey);
          if (object) {
            const h = mediaHeaders(new Headers({
              'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
              'Content-Disposition': object.httpMetadata?.contentDisposition || ''
            }), object.size);
            h.set('ETag', object.httpEtag);
            h.set('X-Media-Cache', 'R2');
            return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers: h });
          }
        } catch (r2Err) {
          console.warn('[Media] R2 读取失败，继续走边缘缓存:', r2Err);
        }
      }

      // 9.3 检查带版本的完整对象缓存；Range 请求必须回源以返回正确的 Content-Range。
      const cachedResp = cacheable ? await cache.match(cacheKey) : null;
      if (cachedResp) {
        const h = new Headers(cachedResp.headers);
        h.set('X-Media-Cache', 'EDGE-HIT');
        return new Response(request.method === 'HEAD' ? null : cachedResp.body, { status: cachedResp.status, headers: h });
      }

      // 9.35 attachment_meta 里的新签名（或现场 refresh-urls 换链）直连 Discord CDN
      if (isAttachmentProxy && descriptor.attachmentId) {
        const refreshed = await freshAttachmentUrl(env, descriptor.attachmentId);
        if (refreshed) {
          try {
            const cdnHeaders = new Headers({ Accept: request.headers.get('Accept') || '*/*', 'User-Agent': 'Discord-Archive-Client/1.0' });
            if (range) cdnHeaders.set('Range', range);
            const delivered = deliver(await fetch(new Request(refreshed, { method: 'GET', headers: cdnHeaders })), 'DISCORD-REFRESHED', false, true);
            if (delivered) return delivered;
          } catch (refreshErr) {
            console.warn('[Media] 新签名链接回源失败:', refreshErr);
          }
        }
      }

      // 9.4 代理 URL 先从本地归档取；缓存缺失时只向 Discord API 取最新附件 URL。
      if (isAttachmentProxy && proxyLocalPath) {
        try {
          const localResp = await fetchOriginPath(proxyLocalPath);
          const delivered = deliver(localResp, 'MISS-ORIGIN', true);
          if (delivered) return delivered;
        } catch (originErr) {
          console.warn(`[Media] 本地附件回源失败 (${proxyLocalPath}):`, originErr);
        }
      }

      if (isAttachmentProxy || legacyToken) {
        if (!descriptor.channelId || !descriptor.messageId || !descriptor.attachmentId) {
          return new Response('附件缺少 Discord 定位信息，无法刷新官方 URL', { status: 410, headers: applySecurityHeaders(new Headers()) });
        }
        const latestSource = await discordAttachmentSourceFromDescriptor(descriptor, env);
        if (!latestSource) {
          return new Response('无法从 Discord 获取最新附件 URL', { status: 502, headers: applySecurityHeaders(new Headers()) });
        }
        try {
          const cdnHeaders = new Headers({
            Accept: request.headers.get('Accept') || '*/*',
            'User-Agent': 'Discord-Archive-Client/1.0'
          });
          if (range) cdnHeaders.set('Range', range);
          const originResp = await fetch(new Request(latestSource, { method: 'GET', headers: cdnHeaders }));
          const delivered = deliver(originResp, 'MISS-ORIGIN', false, true);
          if (delivered) return delivered;
          console.warn(`[Media] Discord CDN 返回 ${originResp.status}: ${latestSource}`);
        } catch (mediaErr) {
          console.warn(`[Media] Discord CDN 回源失败: ${latestSource}`, mediaErr);
        }
        return new Response('附件回源失败', { status: 502, headers: applySecurityHeaders(new Headers()) });
      }

      // 9.5 兼容已有本地路径：按需从 Origin Tunnel 回源。
      try {
        const originResp = await fetchOriginPath(url.pathname);
        const delivered = deliver(originResp, 'MISS-ORIGIN', true);
        if (delivered) return delivered;
      } catch (originErr) {
        console.warn(`[Origin Fallback] 回源失败 (${originBase}${url.pathname}):`, originErr);
      }

      // 9.6 针对头像、表情、图标、贴纸等静态资产直接由边缘回源至 Discord CDN 并入缓存
      if (
        url.pathname.startsWith('/avatars/') ||
        url.pathname.startsWith('/emojis/') ||
        url.pathname.startsWith('/icons/') ||
        url.pathname.startsWith('/stickers/') ||
        url.pathname.startsWith('/guilds/')
      ) {
        try {
          const discordCdnUrl = `https://cdn.discordapp.com${url.pathname}${url.search}`;
          const cdnHeaders = new Headers({
            Accept: request.headers.get('Accept') || '*/*',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
          });
          const cdnResp = await fetch(discordCdnUrl, { headers: cdnHeaders });
          const delivered = deliver(cdnResp, 'DISCORD-CDN', false);
          if (delivered) return delivered;
        } catch (cdnErr) {
          console.warn(`[CDN Fallback] 无法拉取 Discord CDN (${url.pathname}):`, cdnErr);
        }
      }

      return new Response('附件不存在于服务器缓存', { status: 404, headers: applySecurityHeaders(new Headers()) });
    }


    // 10. 只有官方界面：/、/archive（原自研阅读器，已下线）、/official、/app 都直接进入服务器频道（否则官方客户端落在 Friends 页）
    if (['/', '/archive', '/archive/', '/official', '/official/', '/app', '/app/'].includes(url.pathname)) {
      const headers = new Headers({ Location: await officialHome(env), 'Cache-Control': 'no-store' });
      applySecurityHeaders(headers);
      return new Response(null, { status: 302, headers });
    }

    // 11.1 Official Discord Web snapshot: 访问 /channels 等路径时交付官方镜像 Shell
    const isOfficialShell =
      url.pathname.startsWith('/app/') ||
      url.pathname === '/login' ||
      (url.pathname.startsWith('/channels/') && !/\.[a-zA-Z0-9]+$/.test(url.pathname));

    if (isOfficialShell) {
      const officialReq = new Request(new URL('/official-shell', request.url), request);
      const officialResp = await env.ASSETS.fetch(officialReq);
      const headers = new Headers(officialResp.headers);
      applySecurityHeaders(headers);
      // 浏览器里已经按"一年不变"缓存了错尺寸的头像（见 mediaCacheKey），URL 不变就不会重新请求：每个浏览器清一次本站 HTTP 缓存
      if (cookies[MEDIA_RESET_COOKIE] !== MEDIA_RESET_VERSION) {
        headers.set('Clear-Site-Data', '"cache"');
        headers.append('Set-Cookie', `${MEDIA_RESET_COOKIE}=${MEDIA_RESET_VERSION}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`);
      }
      return new Response(officialResp.body, { status: officialResp.status, headers });
    }

    // 13. 默认交付普通静态资源
    const assetResp = await env.ASSETS.fetch(request);
    const newHeaders = new Headers(assetResp.headers);
    applySecurityHeaders(newHeaders);
    return new Response(assetResp.body, {
      status: assetResp.status,
      statusText: assetResp.statusText,
      headers: newHeaders
    });
  }
};
