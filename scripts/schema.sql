-- D1 schema for discord-archive-client. Apply once:
--   npx wrangler d1 execute <db> --remote --file=scripts/schema.sql
-- Archive data (blocks + side tables) comes from scripts/import_export.py; the sync worker keeps message_cache,
-- sync_status and thread_meta current; the Pages worker creates discord_rate on demand.

-- Channel groups and user names (zstd-compressed JSON): name = 'channels' | 'users'; also cron_heartbeat etc.
CREATE TABLE IF NOT EXISTS metadata (
    name TEXT PRIMARY KEY,
    payload BLOB NOT NULL
);

-- Archived messages, ~150 per block, zstd-compressed JSON arrays in archive format (see docs/data-format.md)
CREATE TABLE IF NOT EXISTS blocks (
    channel TEXT NOT NULL,
    seq INTEGER NOT NULL,
    count INTEGER NOT NULL,
    raw_bytes INTEGER NOT NULL,
    payload BLOB NOT NULL,
    PRIMARY KEY (channel, seq)
) WITHOUT ROWID;

-- First/last message id of every block, so paging (before/after/around) reads only the blocks it needs
CREATE TABLE IF NOT EXISTS block_index (
    channel TEXT NOT NULL,
    seq INTEGER NOT NULL,
    first_id INTEGER NOT NULL,
    last_id INTEGER NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (channel, seq)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS block_index_first ON block_index (channel, first_id);
CREATE INDEX IF NOT EXISTS block_index_last ON block_index (channel, last_id);

-- Messages synced after the import (sync worker / on-demand sync), one row per message, JSON payload
CREATE TABLE IF NOT EXISTS message_cache (
    channel TEXT NOT NULL,
    message_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    payload BLOB NOT NULL,
    inserted_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel, message_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS message_cache_inserted ON message_cache (inserted_at);

-- Per-channel sync cursor and the cross-instance sync lock
CREATE TABLE IF NOT EXISTS sync_status (
    channel_id TEXT PRIMARY KEY,
    last_refreshed_at INTEGER NOT NULL DEFAULT 0,
    latest_message_id TEXT NOT NULL DEFAULT '',
    in_flight INTEGER NOT NULL DEFAULT 0,
    lock_expires_at INTEGER NOT NULL DEFAULT 0
);

-- Attachment canonical CDN URL + freshly signed URL (Discord CDN links expire after ~24h; re-signed via refresh-urls)
CREATE TABLE IF NOT EXISTS attachment_meta (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    filename TEXT,
    content_type TEXT,
    size INTEGER,
    width INTEGER,
    height INTEGER,
    fresh_url TEXT,
    fresh_expires INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

-- One row per message author: profile cards, avatars, mention and reply-author lookup
CREATE TABLE IF NOT EXISTS user_meta (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    global_name TEXT,
    avatar TEXT,
    discriminator TEXT NOT NULL DEFAULT '0',
    bot INTEGER NOT NULL DEFAULT 0,
    public_flags INTEGER NOT NULL DEFAULT 0,
    banner TEXT,
    accent_color INTEGER,
    first_message_id TEXT NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS user_meta_global_name ON user_meta (global_name);
CREATE INDEX IF NOT EXISTS user_meta_username ON user_meta (username);

-- Server member per user: roles, server nickname and avatar, fetched in bulk by scripts/backfill_members.mjs
-- (or members.json at import). profile = { user, guild_member } (member object without user); in_guild = 0: left the server
CREATE TABLE IF NOT EXISTS member_meta (
    user_id TEXT PRIMARY KEY,
    in_guild INTEGER NOT NULL DEFAULT 0,
    nick TEXT,
    profile TEXT,
    fetched_at INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

-- Threads and forum posts (parent channel, archived flag); READY lists archived = 0 as active threads
CREATE TABLE IF NOT EXISTS thread_meta (
    id TEXT PRIMARY KEY,
    parent_id TEXT NOT NULL,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    last_message_id TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 1
) WITHOUT ROWID;

-- Pinned messages (GET /channels/:id/messages/pins)
CREATE TABLE IF NOT EXISTS pin_meta (
    channel TEXT NOT NULL,
    message_id TEXT NOT NULL,
    pinned_at TEXT NOT NULL,
    PRIMARY KEY (channel, message_id)
) WITHOUT ROWID;

-- Forwarded-message content for archives whose blocks lack it (the importer writes snapshots into blocks directly)
CREATE TABLE IF NOT EXISTS snapshot_meta (
    message_id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    payload TEXT NOT NULL
) WITHOUT ROWID;

-- The visitor's client settings (protobuf, base64), shared by all visitors
CREATE TABLE IF NOT EXISTS user_settings (
    type INTEGER PRIMARY KEY,
    settings TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0
);

-- Shared Discord request budget / back-off state (shared/discord-guard.ts)
CREATE TABLE IF NOT EXISTS discord_rate (
    scope TEXT PRIMARY KEY,
    blocked_until INTEGER NOT NULL DEFAULT 0,
    window_start INTEGER NOT NULL DEFAULT 0,
    window_count INTEGER NOT NULL DEFAULT 0,
    note TEXT
) WITHOUT ROWID;
