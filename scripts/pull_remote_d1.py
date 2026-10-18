# Copies the tables the sync worker keeps writing (thread_meta, sync_status, message_cache) from the remote D1 into the
# local D1, so `wrangler pages dev` shows what production shows (new threads, messages synced since the import).
# Read-only on the remote side. Usage: python3 scripts/pull_remote_d1.py --db <name> --local <path to local .sqlite>
# (the local file lives under pages/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/)
import json, os, sqlite3, subprocess, sys

import argparse

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.join(here, '..', 'pages')
ap = argparse.ArgumentParser()
ap.add_argument('--db', required=True)
ap.add_argument('--local', required=True)
args = ap.parse_args()
local = args.local

def remote(sql):
    out = subprocess.run(['npx', 'wrangler', 'd1', 'execute', args.db, '--remote', '--json', '--command', sql],
                         cwd=root, capture_output=True, text=True, check=True).stdout
    return json.loads(out)[0]['results']

db = sqlite3.connect(local)
threads = remote('SELECT id, parent_id, name, owner_id, message_count, last_message_id, archived FROM thread_meta')
db.executemany('INSERT OR REPLACE INTO thread_meta (id, parent_id, name, owner_id, message_count, last_message_id, archived) VALUES (?, ?, ?, ?, ?, ?, ?)',
               [(r['id'], r['parent_id'], r['name'], r['owner_id'], r['message_count'], r['last_message_id'], r['archived']) for r in threads])
status = remote('SELECT channel_id, last_refreshed_at, latest_message_id FROM sync_status')
db.executemany('INSERT INTO sync_status (channel_id, last_refreshed_at, latest_message_id) VALUES (?, ?, ?) '
               'ON CONFLICT(channel_id) DO UPDATE SET last_refreshed_at = excluded.last_refreshed_at, latest_message_id = excluded.latest_message_id',
               [(r['channel_id'], r['last_refreshed_at'], r['latest_message_id']) for r in status])
copied, offset = 0, 0
while True:
    rows = remote(f'SELECT channel, message_id, created_at, hex(payload) AS payload, inserted_at FROM message_cache '
                  f'ORDER BY channel, message_id LIMIT 300 OFFSET {offset}')
    if not rows:
        break
    db.executemany('INSERT OR REPLACE INTO message_cache (channel, message_id, created_at, payload, inserted_at) VALUES (?, ?, ?, ?, ?)',
                   [(r['channel'], r['message_id'], r['created_at'], bytes.fromhex(r['payload']), r['inserted_at']) for r in rows])
    copied += len(rows)
    offset += 300
db.commit()
print(f'thread_meta {len(threads)}, sync_status {len(status)}, message_cache {copied} -> {local}', file=sys.stderr)
