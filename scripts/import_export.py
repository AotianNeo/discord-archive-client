#!/usr/bin/env python3
"""Builds D1 SQL from an export directory (see docs/data-format.md) and optionally applies it with wrangler.

    python3 scripts/import_export.py --export export/ --out build/d1 [--owner <user id>] [--apply local|remote --db <name>]

Export directory:
    channels.json            Discord channel objects (GET /guilds/:id/channels) plus thread / forum-post channel objects
    messages/<channel>.json  Discord message objects (GET /channels/:id/messages), any order, one file per channel or thread
                             (file names may carry a suffix: <channel>_<name>.json)
    guild.json (optional)    Discord guild object; owner_id is used when --owner is not given, roles/features become the role list
    members.json (optional)  server member objects (with user): roles, server nickname and avatar. Normally filled after
                             import by scripts/backfill_members.mjs instead

Output (applied in file-name order):
    00_schema.sql, 01_metadata.sql, 02_blocks_NNN.sql, 03_block_index.sql, 04_side_tables.sql

Requires: pip install zstandard
"""
import argparse
import glob
import json
import os
import subprocess
import sys
import time
from collections import defaultdict
from urllib.parse import urlsplit

try:
    import zstandard
except ImportError:
    sys.exit('pip install zstandard')

HERE = os.path.dirname(os.path.abspath(__file__))
MAX_BLOCK = 30_000      # compressed bytes per block: D1 rejects SQL statements over ~100 KB (hex doubles the size)
BLOCK_MESSAGES = 150
BLOCKS_PER_FILE = 40
cctx = zstandard.ZstdCompressor(level=9)


def lit(v):
    if v is None:
        return 'NULL'
    if isinstance(v, bool):
        return '1' if v else '0'
    if isinstance(v, (int, float)):
        return str(int(v))
    return "'" + str(v).replace("'", "''") + "'"


def sticker_url(st):
    ext = {3: 'json', 4: 'gif'}.get(int(st.get('format_type') or 1), 'png')
    return f"/stickers/{st['id']}.{ext}"


def attachment(a):
    return {
        'id': str(a['id']) if a.get('id') else None,
        'filename': a.get('filename') or 'file',
        'url': a.get('url') or a.get('proxy_url') or '',
        'content_type': a.get('content_type') or 'application/octet-stream',
        'size': a.get('size') or 0,
        'width': a.get('width'),
        'height': a.get('height'),
    }


def snapshots(raw, channel_names):
    """Same structure as snapshotsFromDiscord() in shared/message-snapshots.ts (+ source_channel_name)."""
    ref = raw.get('message_reference') or {}
    out = []
    for item in raw.get('message_snapshots') or []:
        m = item.get('message') or {}
        src = str(ref.get('channel_id') or '')
        out.append({
            'content': m.get('content') or '',
            'timestamp': m.get('timestamp'),
            'edited_timestamp': m.get('edited_timestamp'),
            'type': int(m.get('type') or 0),
            'flags': int(m.get('flags') or 0),
            'source_guild_id': str(ref['guild_id']) if ref.get('guild_id') else None,
            'source_channel_id': src or None,
            'source_channel_name': channel_names.get(src),
            'source_message_id': str(ref['message_id']) if ref.get('message_id') else None,
            'attachments': [attachment(a) for a in m.get('attachments') or []],
            'embeds': m.get('embeds') or [],
            'stickers': [{'id': str(s['id']), 'name': s.get('name') or 'sticker', 'format_type': int(s.get('format_type') or 1)}
                         for s in m.get('sticker_items') or []],
        })
    return out


def to_record(raw, channel_id, owner_id, channel_names):
    """Archive message format; mirrors toRecord() in sync-worker/src/index.ts."""
    author = raw.get('author') or {}
    aid = str(author.get('id') or '')
    name = author.get('global_name') or author.get('username') or 'user'
    rec = {
        'id': str(raw['id']),
        'channel_id': str(raw.get('channel_id') or channel_id),
        'author_id': aid,
        'author': name,
        'username': author.get('username') or name,
        'avatar': f"https://cdn.discordapp.com/avatars/{aid}/{author['avatar']}.webp?size=64" if author.get('avatar') else '',
        'content': raw.get('content') or '',
        'created_at': raw.get('timestamp'),
        'owner': bool(owner_id) and aid == owner_id,
        'attachments': [attachment(a) for a in raw.get('attachments') or []],
        'embeds': raw.get('embeds') or [],
        'stickers': [{'id': str(s['id']), 'name': s.get('name') or 'sticker', 'format_type': int(s.get('format_type') or 1),
                      'url': sticker_url(s)} for s in raw.get('sticker_items') or []],
        'message_type': int(raw.get('type') or 0),
        'is_bot': bool(author.get('bot')),
    }
    ref = raw.get('message_reference') or {}
    if ref.get('type') == 1 and raw.get('message_snapshots'):
        rec['snapshots'] = snapshots(raw, channel_names)
    elif ref.get('message_id'):
        replied = raw.get('referenced_message') or {}
        replied_author = replied.get('author') or {}
        rec.update({
            'reply_author': replied_author.get('global_name') or replied_author.get('username') or '',
            'reply_author_id': str(replied_author['id']) if replied_author.get('id') else None,
            'reply_content': replied.get('content') or '',
            'reply_channel_id': str(ref.get('channel_id') or ''),
            'reply_message_id': str(ref['message_id']),
        })
    return rec


def load_messages(export):
    by_channel = defaultdict(dict)
    for f in sorted(glob.glob(os.path.join(export, 'messages', '*.json'))):
        cid = os.path.basename(f)[:-5].split('_', 1)[0]
        data = json.load(open(f, encoding='utf-8'))
        for m in data if isinstance(data, list) else data.get('messages', []):
            if m.get('id'):
                by_channel[str(m.get('channel_id') or cid)][str(m['id'])] = m
    return {cid: sorted(msgs.values(), key=lambda m: int(m['id'])) for cid, msgs in by_channel.items()}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--export', required=True)
    ap.add_argument('--out', default='build/d1')
    ap.add_argument('--owner', default='', help='server owner user id (messages get the owner flag)')
    ap.add_argument('--apply', choices=['local', 'remote'])
    ap.add_argument('--db', help='D1 database name (with --apply)')
    args = ap.parse_args()

    channels = json.load(open(os.path.join(args.export, 'channels.json'), encoding='utf-8'))
    guild_file = os.path.join(args.export, 'guild.json')
    guild = json.load(open(guild_file, encoding='utf-8')) if os.path.exists(guild_file) else {}
    owner = args.owner or guild.get('owner_id', '')
    channel_names = {str(c['id']): c.get('name') or '' for c in channels}
    messages = load_messages(args.export)
    os.makedirs(args.out, exist_ok=True)
    for old in glob.glob(os.path.join(args.out, '*.sql')):
        os.remove(old)

    # 00 schema
    with open(os.path.join(HERE, 'schema.sql'), encoding='utf-8') as src, open(os.path.join(args.out, '00_schema.sql'), 'w', encoding='utf-8') as dst:
        dst.write(src.read())

    # 01 metadata: channel groups (categories -> channels; threads live in thread_meta), user names, sync cursors
    threads = [c for c in channels if c.get('type') in (10, 11, 12)]
    categories = {str(c['id']): c for c in channels if c.get('type') == 4}
    groups = {}
    for c in sorted(channels, key=lambda c: c.get('position', 0)):
        if c.get('type') not in (0, 2, 5, 13, 15, 16):
            continue
        cat = categories.get(str(c.get('parent_id') or ''))
        gid = str(cat['id']) if cat else ''
        group = groups.setdefault(gid, {'id': gid, 'name': cat['name'] if cat else 'Uncategorized',
                                        'position': cat.get('position', 0) if cat else -1, 'channels': []})
        group['channels'].append({'id': str(c['id']), 'name': c.get('name') or '', 'type': c.get('type', 0),
                                  'count': len(messages.get(str(c['id']), [])), 'position': c.get('position', 0)})
    meta_channels = sorted(groups.values(), key=lambda g: g['position'])
    users, user_rows = {}, {}
    for cid, msgs in messages.items():
        for m in msgs:
            a = m.get('author') or {}
            if not a.get('id'):
                continue
            uid = str(a['id'])
            users[uid] = a.get('global_name') or a.get('username') or uid
            row = user_rows.setdefault(uid, {'first': m['id'], 'count': 0, 'author': a, 'last': m['id']})
            row['count'] += 1
            if int(m['id']) < int(row['first']):
                row['first'] = m['id']
            if int(m['id']) >= int(row['last']):
                row['last'], row['author'] = m['id'], a
    with open(os.path.join(args.out, '01_metadata.sql'), 'w', encoding='utf-8') as fh:
        for name, payload in (('channels', meta_channels), ('users', users)):
            blob = cctx.compress(json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode())
            fh.write(f"INSERT OR REPLACE INTO metadata (name, payload) VALUES ('{name}', X'{blob.hex()}');\n")
        if guild.get('roles'):
            # plain JSON with fetched_at 0: the sync worker refreshes it on its first run
            roles = json.dumps({'roles': guild['roles'], 'features': guild.get('features') or [], 'fetched_at': 0}, ensure_ascii=False)
            fh.write(f"INSERT OR REPLACE INTO metadata (name, payload) VALUES ('guild_roles', {lit(roles)});\n")
        for cid, msgs in messages.items():
            if msgs:
                fh.write(f"INSERT OR REPLACE INTO sync_status (channel_id, last_refreshed_at, latest_message_id) VALUES ({lit(cid)}, 0, {lit(msgs[-1]['id'])});\n")

    # 02 blocks + 03 block_index
    blocks = []
    for cid, msgs in messages.items():
        records = [to_record(m, cid, owner, channel_names) for m in msgs]
        seq, i = 0, 0
        while i < len(records):
            step = BLOCK_MESSAGES
            while True:
                chunk = records[i:i + step]
                raw = json.dumps(chunk, ensure_ascii=False, separators=(',', ':')).encode()
                blob = cctx.compress(raw)
                if len(blob) <= MAX_BLOCK or step == 1:
                    break
                step = max(1, step // 2)
            blocks.append((cid, seq, chunk[0]['id'], chunk[-1]['id'], len(chunk), len(raw), blob))
            seq += 1
            i += len(chunk)
    for n in range(0, len(blocks), BLOCKS_PER_FILE):
        with open(os.path.join(args.out, f'02_blocks_{n // BLOCKS_PER_FILE + 1:03d}.sql'), 'w', encoding='utf-8') as fh:
            for cid, seq, first, last, count, raw_len, blob in blocks[n:n + BLOCKS_PER_FILE]:
                fh.write(f"INSERT OR REPLACE INTO blocks (channel, seq, count, raw_bytes, payload) VALUES ({lit(cid)}, {seq}, {count}, {raw_len}, X'{blob.hex()}');\n")
    with open(os.path.join(args.out, '03_block_index.sql'), 'w', encoding='utf-8') as fh:
        for cid, seq, first, last, count, _, _ in blocks:
            fh.write(f'INSERT OR REPLACE INTO block_index (channel, seq, first_id, last_id, count) VALUES ({lit(cid)}, {seq}, {first}, {last}, {count});\n')

    # 04 side tables: users, attachments (canonical CDN path for re-signing), threads, pins
    with open(os.path.join(args.out, '04_side_tables.sql'), 'w', encoding='utf-8') as fh:
        for uid, u in user_rows.items():
            a = u['author']
            fh.write('INSERT OR REPLACE INTO user_meta (id, username, global_name, avatar, discriminator, bot, public_flags, banner, '
                     'accent_color, first_message_id, message_count) VALUES (' + ','.join(lit(x) for x in (
                         uid, a.get('username') or '', a.get('global_name'), a.get('avatar'), a.get('discriminator') or '0',
                         bool(a.get('bot')), a.get('public_flags') or 0, a.get('banner'), a.get('accent_color'), u['first'], u['count'])) + ');\n')
        seen = set()
        for msgs in messages.values():
            for m in msgs:
                atts = list(m.get('attachments') or [])
                for snap in m.get('message_snapshots') or []:
                    atts += (snap.get('message') or {}).get('attachments') or []
                for a in atts:
                    path = urlsplit(a.get('url') or '').path
                    if not a.get('id') or a['id'] in seen or not path.startswith('/attachments/'):
                        continue
                    seen.add(a['id'])
                    fh.write('INSERT OR IGNORE INTO attachment_meta (id, source, filename, content_type, size, width, height) VALUES (' + ','.join(lit(x) for x in (
                        str(a['id']), 'https://cdn.discordapp.com' + path, a.get('filename') or 'file',
                        a.get('content_type') or 'application/octet-stream', a.get('size'), a.get('width'), a.get('height'))) + ');\n')
        for t in threads:
            msgs = messages.get(str(t['id']), [])
            owner_id = t.get('owner_id') or ((msgs[0].get('author') or {}).get('id') if msgs else '') or '0'
            archived = 1 if (t.get('thread_metadata') or {}).get('archived', True) else 0
            fh.write('INSERT OR REPLACE INTO thread_meta (id, parent_id, name, owner_id, message_count, last_message_id, archived) VALUES (' + ','.join(lit(x) for x in (
                str(t['id']), str(t.get('parent_id') or ''), t.get('name') or '', str(owner_id), len(msgs),
                msgs[-1]['id'] if msgs else str(t.get('last_message_id') or t['id']), archived)) + ');\n')
        members_file = os.path.join(args.export, 'members.json')
        members = json.load(open(members_file, encoding='utf-8')) if os.path.exists(members_file) else []
        now = int(time.time() * 1000)
        for m in members:
            uid = str((m.get('user') or {}).get('id') or '')
            if not uid:
                continue
            member = {k: v for k, v in m.items() if k not in ('user', 'unusual_dm_activity_until')}
            profile = json.dumps({'user': m['user'], 'guild_member': member}, ensure_ascii=False)
            fh.write('INSERT OR REPLACE INTO member_meta (user_id, in_guild, nick, profile, fetched_at) VALUES (' + ','.join(lit(x) for x in (
                uid, 1, member.get('nick'), profile, now)) + ');\n')
        for cid, msgs in messages.items():
            notices = {(m.get('message_reference') or {}).get('message_id'): m.get('timestamp') for m in msgs if m.get('type') == 6}
            for m in msgs:
                if m.get('pinned'):
                    fh.write(f"INSERT OR REPLACE INTO pin_meta (channel, message_id, pinned_at) VALUES ({lit(cid)}, {lit(m['id'])}, {lit(notices.get(m['id']) or m.get('timestamp'))});\n")

    total = sum(len(m) for m in messages.values())
    print(f'{total} messages in {len(messages)} channels/threads -> {len(blocks)} blocks, {len(user_rows)} users, '
          f'{len(seen)} attachments, {len(threads)} threads, {len(guild.get("roles") or [])} roles, {len(members)} members; '
          f'SQL in {args.out}', file=sys.stderr)

    if args.apply:
        if not args.db:
            sys.exit('--apply needs --db <D1 database name>')
        pages = os.path.join(HERE, '..', 'pages')
        for f in sorted(glob.glob(os.path.join(os.path.abspath(args.out), '*.sql'))):
            print(f'applying {os.path.basename(f)}', file=sys.stderr)
            subprocess.run(['npx', 'wrangler', 'd1', 'execute', args.db, f'--{args.apply}', f'--file={f}', '-y'], cwd=pages, check=True,
                           stdout=subprocess.DEVNULL)


if __name__ == '__main__':
    main()
