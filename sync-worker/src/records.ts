// Discord 消息对象 → 归档格式（scripts/import_export.py 的 to_record 与此一致），以及写入 message_cache 的公共代码。
// 定时同步（index.ts）和实时网关（gateway.ts）都走这里。
import { isForward, snapshotsFromDiscord } from '../../shared/message-snapshots';

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

export function compareSnowflake(a: string, b: string): number {
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function toRecord(raw: any, channelId: string, ownerId = '0') {
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
    owner: authorId === ownerId,
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

export type ArchiveRecord = ReturnType<typeof toRecord>;

// 写入 message_cache（按 (channel, message_id) 覆盖）并推进该频道的 sync_status
export function writeRecords(db: D1Database, channelId: string, records: ArchiveRecord[], now = Date.now()): D1PreparedStatement[] {
  if (!records.length) return [];
  const maxId = records.reduce((max, r) => (compareSnowflake(r.id, max) > 0 ? r.id : max), records[0].id);
  return [
    ...records.map((r) => db.prepare(
      'INSERT INTO message_cache (channel, message_id, created_at, payload, inserted_at) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(channel, message_id) DO UPDATE SET created_at = excluded.created_at, payload = excluded.payload'
    ).bind(r.channel_id, r.id, r.created_at, new TextEncoder().encode(JSON.stringify(r)), now)),
    db.prepare(
      'INSERT INTO sync_status (channel_id, last_refreshed_at, latest_message_id) VALUES (?, ?, ?) ' +
      'ON CONFLICT(channel_id) DO UPDATE SET last_refreshed_at = excluded.last_refreshed_at, latest_message_id = MAX(sync_status.latest_message_id, excluded.latest_message_id)'
    ).bind(channelId, now, maxId)
  ];
}
