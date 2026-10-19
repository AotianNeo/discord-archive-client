#!/usr/bin/env python3
"""Exports a Discord server's channels, threads and message history into an export directory for import_export.py.

    DISCORD_TOKEN='Bot <token>' python3 scripts/export_guild.py --guild <server id> --out export/

DISCORD_TOKEN is a bot token ("Bot ..." — the bot needs View Channels + Read Message History) or a user token.
Automating a user account is against Discord's Terms of Service; prefer a bot you added to the server.

Writes export/guild.json, export/channels.json and export/messages/<channel id>.json (Discord message objects).
With --members it also writes export/members.json: roles, server nickname/avatar and server profile of every message author
(one request per author; the sync worker fills these in on its own too, a few per run).
Re-running resumes: channels that already have a file only fetch messages newer than the newest one saved.
Requests are sequential and paced by Discord's rate-limit headers.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

API = 'https://discord.com/api/v10'
TOKEN = os.environ.get('DISCORD_TOKEN', '').strip()
IS_BOT = TOKEN.lower().startswith('bot ')
MIN_GAP = 0.6  # seconds between requests, on top of rate-limit waits
_last = 0.0


def get(path):
    """GET with rate-limit handling; returns parsed JSON, or None on 403/404."""
    global _last
    while True:
        wait = _last + MIN_GAP - time.time()
        if wait > 0:
            time.sleep(wait)
        _last = time.time()
        req = urllib.request.Request(API + path, headers={'Authorization': TOKEN, 'User-Agent': 'DiscordBot (discord-archive-client, 1.0)'})
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                body = json.loads(res.read())
                if res.headers.get('X-RateLimit-Remaining') == '0':
                    time.sleep(float(res.headers.get('X-RateLimit-Reset-After') or 1))
                return body
        except urllib.error.HTTPError as err:
            if err.code == 429:
                retry = json.loads(err.read() or b'{}').get('retry_after', 5)
                print(f'  rate limited, waiting {retry}s', file=sys.stderr)
                time.sleep(float(retry) + 0.5)
                continue
            if err.code in (403, 404):
                return None
            if err.code == 401:
                sys.exit('401 Unauthorized: check DISCORD_TOKEN (bot tokens need the "Bot " prefix)')
            raise


def threads_of(channel):
    """Active + archived threads (forum posts) of one channel."""
    found = {}
    if IS_BOT:
        before = ''
        while True:
            page = get(f"/channels/{channel['id']}/threads/archived/public?limit=100{'&before=' + before if before else ''}")
            if not page or not page.get('threads'):
                break
            for t in page['threads']:
                found[t['id']] = t
            if not page.get('has_more'):
                break
            before = page['threads'][-1]['thread_metadata']['archive_timestamp']
    else:
        for archived in ('false', 'true'):
            offset = 0
            while True:
                page = get(f"/channels/{channel['id']}/threads/search?archived={archived}&sort_by=last_message_time&sort_order=desc&limit=25&offset={offset}")
                if not page or not page.get('threads'):
                    break
                for t in page['threads']:
                    found[t['id']] = t
                if not page.get('has_more'):
                    break
                offset += len(page['threads'])
    return list(found.values())


def export_messages(channel_id, path):
    """Fetches the full history (or only messages newer than the saved ones) into path."""
    saved = json.load(open(path, encoding='utf-8')) if os.path.exists(path) else []
    newest = max((int(m['id']) for m in saved), default=0)
    fresh = []
    if newest:
        after = str(newest)
        while True:
            page = get(f'/channels/{channel_id}/messages?limit=100&after={after}')
            if not page:
                break
            fresh += page
            after = max(page, key=lambda m: int(m['id']))['id']
            if len(page) < 100:
                break
    else:
        before = ''
        while True:
            page = get(f"/channels/{channel_id}/messages?limit=100{'&before=' + before if before else ''}")
            if not page:
                break
            fresh += page
            before = min(page, key=lambda m: int(m['id']))['id']
            if len(page) < 100:
                break
            if len(fresh) % 5000 < 100:
                print(f'  {len(fresh)} messages…', file=sys.stderr)
    merged = {m['id']: m for m in saved + fresh}
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(sorted(merged.values(), key=lambda m: int(m['id'])), fh, ensure_ascii=False)
    return len(fresh)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--guild', required=True)
    ap.add_argument('--out', default='export')
    ap.add_argument('--channels', help='comma-separated channel ids (default: every readable channel)')
    ap.add_argument('--members', action='store_true', help='also export the roles and server profile of every message author')
    args = ap.parse_args()
    if not TOKEN:
        sys.exit('set DISCORD_TOKEN')
    os.makedirs(os.path.join(args.out, 'messages'), exist_ok=True)

    guild = get(f'/guilds/{args.guild}')
    if not guild:
        sys.exit('server not found or not accessible with this token')
    json.dump(guild, open(os.path.join(args.out, 'guild.json'), 'w', encoding='utf-8'), ensure_ascii=False)
    channels = get(f'/guilds/{args.guild}/channels') or []
    wanted = set(args.channels.split(',')) if args.channels else None
    readable = [c for c in channels if c['type'] in (0, 5, 15, 16) and (not wanted or c['id'] in wanted)]

    threads = {}
    if IS_BOT:
        for t in (get(f'/guilds/{args.guild}/threads/active') or {}).get('threads', []):
            threads[t['id']] = t
    for c in readable:
        for t in threads_of(c):
            threads[t['id']] = t
    threads = {k: t for k, t in threads.items() if not wanted or t.get('parent_id') in wanted}
    json.dump(channels + list(threads.values()), open(os.path.join(args.out, 'channels.json'), 'w', encoding='utf-8'), ensure_ascii=False)
    print(f"{guild['name']}: {len(readable)} channels, {len(threads)} threads", file=sys.stderr)

    for c in [c for c in readable if c['type'] in (0, 5)] + list(threads.values()):
        n = export_messages(c['id'], os.path.join(args.out, 'messages', f"{c['id']}.json"))
        print(f"#{c.get('name')}: +{n}", file=sys.stderr)

    if args.members:
        authors = set()
        for name in os.listdir(os.path.join(args.out, 'messages')):
            for m in json.load(open(os.path.join(args.out, 'messages', name), encoding='utf-8')):
                if (m.get('author') or {}).get('id'):
                    authors.add(m['author']['id'])
        members = []
        for i, uid in enumerate(sorted(authors)):
            if IS_BOT:  # bots have no profile endpoint: roles, nickname and server avatar only
                found = get(f'/guilds/{args.guild}/members/{uid}')
            else:
                found = get(f'/users/{uid}/profile?with_mutual_guilds=false&with_mutual_friends=false&guild_id={args.guild}')
            if found:
                members.append(found)
            if (i + 1) % 100 == 0:
                print(f'  {i + 1}/{len(authors)} members…', file=sys.stderr)
        json.dump(members, open(os.path.join(args.out, 'members.json'), 'w', encoding='utf-8'), ensure_ascii=False)
        print(f'{len(members)} member profiles of {len(authors)} authors', file=sys.stderr)


if __name__ == '__main__':
    main()
