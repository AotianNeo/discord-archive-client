# Data format

## Export directory (input of `scripts/import_export.py`)

```
export/
  guild.json               Discord guild object (optional; owner_id is used for the owner flag, roles/features for the role list)
  members.json             optional: server member objects (normally filled after import by scripts/backfill_members.mjs)
  channels.json            array of Discord channel objects: GET /guilds/:id/channels
                           + thread / forum-post channel objects (type 11/12, with parent_id and thread_metadata)
  messages/<channel>.json  array of Discord message objects (GET /channels/:id/messages), any order
```

`scripts/export_guild.py` writes this layout. Anything that produces raw Discord API objects works; file names may
have a suffix (`<channel id>_<name>.json`).

## Archive message format (D1 `blocks` payloads and `message_cache` rows)

The importer (`to_record` in `scripts/import_export.py`) and the sync worker (`toRecord` in `sync-worker/src/index.ts`)
write the same shape:

```jsonc
{
  "id": "…", "channel_id": "…",
  "author_id": "…", "author": "display name", "username": "…", "avatar": "https://cdn.discordapp.com/avatars/…",
  "content": "…", "created_at": "ISO timestamp", "owner": false, "is_bot": false, "message_type": 0,
  "attachments": [{ "id": "…", "filename": "…", "url": "…", "content_type": "…", "size": 0, "width": null, "height": null }],
  "embeds": [ /* Discord embed objects */ ],
  "stickers": [{ "id": "…", "name": "…", "format_type": 1, "url": "/stickers/<id>.png" }],
  // replies
  "reply_message_id": "…", "reply_channel_id": "…", "reply_author": "…", "reply_author_id": "…", "reply_content": "…",
  // forwards (message_reference.type = 1): see shared/message-snapshots.ts
  "snapshots": [{ "content": "…", "timestamp": "…", "source_channel_id": "…", "source_message_id": "…", "attachments": [], "embeds": [] }]
}
```

The Pages worker converts this back to Discord message objects (`archiveMessageToDiscord`), adding
`message_reference` / `referenced_message` (type 19) for replies and `message_snapshots` for forwards.

## Tables

See `scripts/schema.sql`. In short:

| Table | Filled by | Used for |
|---|---|---|
| `metadata` | importer, sync | channel groups (`channels`), user names (`users`), roles (`guild_roles`), cron heartbeat, sync state |
| `blocks`, `block_index` | importer | archived history, paged by message id |
| `message_cache`, `sync_status` | sync worker, on-demand sync | messages newer than the import |
| `attachment_meta` | importer, Pages worker | canonical CDN path + freshly signed URL per attachment |
| `user_meta` | importer | profile cards, avatars, mentions, reply authors |
| `member_meta` | backfill_members.mjs (gateway, in bulk), importer | roles, server nickname and avatar per user |
| `thread_meta` | importer, sync worker | threads / forum posts and their archived state |
| `pin_meta` | importer | pinned messages |
| `snapshot_meta` | (legacy archives) | forwarded content for blocks written without `snapshots` |
| `user_settings` | Pages worker | the visitor's client settings (shared by all visitors) |
| `discord_rate` | both workers | shared Discord request budget and back-off |
