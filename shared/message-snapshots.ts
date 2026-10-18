// 转发消息：Discord 把被转发的内容放在 message_snapshots[].message，message_reference.type = 1 指向原消息。
// 归档格式存成 snapshots（source_* 指向原消息），reply_* 字段只留给真正的回复。
// Pages Worker、sync-worker 和导入脚本 scripts/import_export.py 生成同一种结构。

export interface ArchiveSnapshot {
  content: string;
  timestamp?: string;
  edited_timestamp?: string | null;
  type?: number;
  flags?: number;
  source_guild_id?: string;
  source_channel_id?: string;
  source_channel_name?: string;
  source_message_id?: string;
  attachments?: any[];
  embeds?: any[];
  stickers?: Array<{ id: string; name: string; format_type: number }>;
}

export const MESSAGE_REFERENCE_FORWARD = 1;

export function isForward(raw: any): boolean {
  return Number(raw?.message_reference?.type) === MESSAGE_REFERENCE_FORWARD;
}

export function snapshotsFromDiscord(raw: any): ArchiveSnapshot[] {
  const ref = raw?.message_reference || {};
  return (Array.isArray(raw?.message_snapshots) ? raw.message_snapshots : []).map((item: any) => {
    const m = item?.message || {};
    return {
      content: m.content || '',
      timestamp: m.timestamp,
      edited_timestamp: m.edited_timestamp ?? null,
      type: Number(m.type || 0),
      flags: Number(m.flags || 0),
      source_guild_id: ref.guild_id ? String(ref.guild_id) : undefined,
      source_channel_id: ref.channel_id ? String(ref.channel_id) : undefined,
      source_message_id: ref.message_id ? String(ref.message_id) : undefined,
      attachments: (Array.isArray(m.attachments) ? m.attachments : []).map((a: any) => ({
        id: a.id ? String(a.id) : undefined,
        filename: a.filename || '附件',
        url: a.url || a.proxy_url || '',
        content_type: a.content_type || 'application/octet-stream',
        size: a.size || 0,
        width: a.width,
        height: a.height
      })),
      embeds: Array.isArray(m.embeds) ? m.embeds : [],
      stickers: (Array.isArray(m.sticker_items) ? m.sticker_items : []).map((st: any) => ({
        id: String(st.id),
        name: st.name || 'sticker',
        format_type: Number(st.format_type) || 1
      }))
    };
  });
}
