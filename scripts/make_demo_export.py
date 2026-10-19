#!/usr/bin/env python3
"""Writes a small fictional server in export format, for trying the project without real data.

    python3 scripts/make_demo_export.py --out demo-export

All names, ids and messages are made up. Ids are snowflakes generated from timestamps, so dates look realistic.
"""
import argparse
import json
import os
from datetime import datetime, timedelta, timezone

EPOCH = 1420070400000
START = datetime(2025, 3, 1, 9, 0, tzinfo=timezone.utc)
_counter = 0


def snowflake(ts):
    global _counter
    _counter += 1
    return str(((int(ts.timestamp() * 1000) - EPOCH) << 22) | (_counter & 0xFFF))


def iso(ts):
    return ts.isoformat(timespec='milliseconds').replace('+00:00', '+00:00')


GUILD = snowflake(START - timedelta(days=30))
USERS = [
    {'id': snowflake(START - timedelta(days=400)), 'username': 'demo_alice', 'global_name': 'Alice (demo)', 'avatar': None, 'discriminator': '0', 'public_flags': 0},
    {'id': snowflake(START - timedelta(days=380)), 'username': 'demo_bob', 'global_name': 'Bob (demo)', 'avatar': None, 'discriminator': '0', 'public_flags': 0},
    {'id': snowflake(START - timedelta(days=360)), 'username': 'demo_carol', 'global_name': 'Carol (demo)', 'avatar': None, 'discriminator': '0', 'public_flags': 0},
    {'id': snowflake(START - timedelta(days=340)), 'username': 'demo_bot', 'global_name': None, 'avatar': None, 'discriminator': '0', 'public_flags': 0, 'bot': True},
]
OWNER = USERS[0]


def channel(name, type_, parent=None, position=0, **extra):
    return {'id': snowflake(START - timedelta(days=29)), 'guild_id': GUILD, 'name': name, 'type': type_, 'parent_id': parent,
            'position': position, 'permission_overwrites': [], **extra}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='demo-export')
    args = ap.parse_args()
    os.makedirs(os.path.join(args.out, 'messages'), exist_ok=True)

    info = channel('Information', 4, position=0)
    chat = channel('Chat', 4, position=1)
    welcome = channel('welcome', 0, info['id'], 0, topic='Start here')
    general = channel('general', 0, chat['id'], 1)
    links = channel('links', 0, chat['id'], 2)
    forum = channel('resources', 15, chat['id'], 3, available_tags=[])
    channels = [info, chat, welcome, general, links, forum]
    messages = {c['id']: [] for c in (welcome, general, links)}
    ts = START

    def post(ch, author, content='', minutes=7, **extra):
        nonlocal ts
        ts += timedelta(minutes=minutes)
        m = {'id': snowflake(ts), 'channel_id': ch['id'], 'type': 0, 'content': content, 'timestamp': iso(ts), 'edited_timestamp': None,
             'author': author, 'attachments': [], 'embeds': [], 'mentions': [], 'pinned': False, 'flags': 0, **extra}
        messages.setdefault(ch['id'], []).append(m)
        return m

    rules = post(welcome, OWNER, 'Welcome to the **Demo Server** archive. Be kind, stay on topic.')
    rules['pinned'] = True
    post(welcome, OWNER, '', minutes=1, type=6, message_reference={'channel_id': welcome['id'], 'message_id': rules['id'], 'guild_id': GUILD})
    post(welcome, USERS[3], 'Archive bot reporting for duty.')

    first = post(general, USERS[1], 'Morning! Anyone tried the new release yet?')
    post(general, USERS[2], 'Yes — upgrade went smoothly here.')
    post(general, USERS[0], f'<@{USERS[1]["id"]}> it fixed the paging bug for me too.', mentions=[USERS[1]])
    post(general, USERS[1], 'Nice, thanks!', type=19,
         message_reference={'type': 0, 'channel_id': general['id'], 'message_id': first['id'], 'guild_id': GUILD},
         referenced_message={'id': first['id'], 'content': first['content'], 'author': USERS[1]})
    for day in range(1, 40):
        ts += timedelta(hours=9)
        for i, u in enumerate(USERS[:3]):
            post(general, u, f'Day {day}: update #{i + 1} — {["shipping", "testing", "reviewing"][i]} things.', minutes=3)

    tip = post(links, USERS[2], 'Handy reference: https://example.com/guide', embeds=[{
        'type': 'link', 'url': 'https://example.com/guide', 'title': 'Example Guide', 'description': 'A made-up page for the demo.'}])
    post(general, USERS[0], '', type=0, flags=16384,
         message_reference={'type': 1, 'channel_id': links['id'], 'message_id': tip['id'], 'guild_id': GUILD},
         message_snapshots=[{'message': {'type': 0, 'content': tip['content'], 'timestamp': tip['timestamp'], 'embeds': tip['embeds'], 'attachments': []}}])

    thread = {'id': snowflake(ts + timedelta(minutes=5)), 'guild_id': GUILD, 'name': 'release notes discussion', 'type': 11, 'parent_id': general['id'],
              'owner_id': USERS[2]['id'], 'thread_metadata': {'archived': True, 'auto_archive_duration': 1440}}
    channels.append(thread)
    for i in range(4):
        post(thread, USERS[i % 3], f'Thread reply {i + 1}')

    for n, (title, author) in enumerate([('Getting started', USERS[0]), ('FAQ', USERS[1]), ('Book list', USERS[2])]):
        ts += timedelta(days=2)
        tid = snowflake(ts)
        channels.append({'id': tid, 'guild_id': GUILD, 'name': title, 'type': 11, 'parent_id': forum['id'], 'owner_id': author['id'],
                         'thread_metadata': {'archived': n == 2, 'auto_archive_duration': 10080}})
        messages[tid] = [{'id': tid, 'channel_id': tid, 'type': 0, 'content': f'{title}: starter post.', 'timestamp': iso(ts), 'author': author,
                          'attachments': [], 'embeds': [], 'mentions': [], 'pinned': False, 'flags': 0}]
        for i in range(3):
            post({'id': tid}, USERS[(n + i + 1) % 3], f'{title} reply {i + 1}')

    # roles and server members (created last so the ids above stay stable); Bob has a server nickname
    def role(name, position, color=0, secondary=None, **extra):
        return {'id': snowflake(START - timedelta(days=28)), 'name': name, 'description': None, 'permissions': '0', 'position': position,
                'color': color, 'colors': {'primary_color': color, 'secondary_color': secondary, 'tertiary_color': None}, 'hoist': False,
                'icon': None, 'unicode_emoji': None, 'managed': False, 'mentionable': True, 'flags': 0, **extra}
    moderator = role('Moderator', 3, 0x3498DB, hoist=True)
    contributor = role('Contributor', 2, 0xE67E22, 0x9B59B6)
    bots = role('Bots', 1, managed=True, mentionable=False, tags={'bot_id': USERS[3]['id']})
    everyone = role('@everyone', 0, permissions='1071698660929', mentionable=False)
    everyone['id'] = GUILD

    def member(user, roles, nick=None):
        return {'user': user, 'roles': [r['id'] for r in roles], 'nick': nick, 'avatar': None, 'banner': None,
                'joined_at': iso(START - timedelta(days=20)), 'premium_since': None, 'pending': False, 'flags': 0,
                'communication_disabled_until': None, 'mute': False, 'deaf': False}
    members = [member(USERS[0], [moderator]), member(USERS[1], [contributor], nick='Bobby (demo)'), member(USERS[2], []),
               member(USERS[3], [bots])]

    json.dump({'id': GUILD, 'name': 'Demo Server', 'icon': None, 'owner_id': OWNER['id'], 'features': ['ENHANCED_ROLE_COLORS'],
               'roles': [everyone, moderator, contributor, bots]}, open(os.path.join(args.out, 'guild.json'), 'w'))
    json.dump(members, open(os.path.join(args.out, 'members.json'), 'w'), indent=1)
    json.dump(channels, open(os.path.join(args.out, 'channels.json'), 'w'), indent=1)
    for cid, msgs in messages.items():
        json.dump(msgs, open(os.path.join(args.out, 'messages', f'{cid}.json'), 'w'), indent=1)
    print(f'demo server {GUILD}: {sum(len(m) for m in messages.values())} messages in {len(messages)} channels/threads -> {args.out}')
    print(f'  DISCORD_GUILD_ID={GUILD}  GUILD_OWNER_ID={OWNER["id"]}  HOME_CHANNEL_ID={general["id"]}')


if __name__ == '__main__':
    main()
