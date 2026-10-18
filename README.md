# Discord Archive Client

Read-only archive of a Discord server, served through **Discord's own web client UI** on Cloudflare Pages + D1.
Visitors get the real Discord interface — channels, threads, forum posts, replies, forwards, pins, profile cards,
search — backed by an exported message history instead of Discord's servers.

用 **Discord 官方网页客户端界面**只读地浏览一个服务器的历史聊天记录，部署在 Cloudflare Pages + D1 上。
访客看到的是真正的 Discord 界面（频道、子区、论坛帖子、回复、转发、置顶、用户资料卡、搜索），数据来自导出的消息历史。

![The fictional demo server in the official client](docs/screenshot.png)

Inspired by [aiko-chan-ai/DiscordBotClient](https://github.com/aiko-chan-ai/DiscordBotClient): the same idea of
running the official client against a compatibility API, here as a static-site archive instead of a bot client.

> Discord's client code is **not** included in this repository. `scripts/fetch-client.mjs` downloads the current
> web build from discord.com when you build the site.

---

## Features · 功能

- Official Discord web client UI, light theme by default, password-protected · 官方客户端界面，默认浅色主题，访问口令保护
- Full history paging (before / after / around / jump to message) from compressed message blocks · 完整历史翻页与跳转
- Replies, forwards (message snapshots), mentions, embeds, stickers (PNG/APNG/GIF/Lottie), custom emoji · 回复、转发、提及、嵌入、贴纸、表情
- Attachments with automatic re-signing of expired Discord CDN links (needs `DISCORD_TOKEN`) · 附件签名过期自动续签
- Threads and forum posts (active + archived), pinned messages, user profile cards · 子区、论坛帖子、置顶、资料卡
- Search: forwarded to Discord's search when a token is configured, otherwise searches the archive · 搜索
- Read-only: sending, reacting, editing return Discord's normal "missing permissions" error · 只读
- Optional cloud sync: a cron Worker pulls new messages and new threads every minute, behind a shared
  rate limiter that backs off on 429/401/403 · 可选的云端增量同步（共享限频，自动避让）
- ~150 Discord API endpoints answered with correctly-shaped data, so client stores don't crash on `{}` · 约 150 个端点按官方形状应答

## How it works · 架构

```
browser ── Discord web client (fetched build, /assets/*, static)
   │  GLOBAL_ENV points every endpoint back at this site
   ├── /api/v9/*   ─┐
   ├── /gateway    ─┼─ Pages Worker (pages/src/index.ts) ── D1: message blocks, side tables, sync cache
   └── /avatars/*, /attachments/*, /stickers/* ─┘                    ▲
                                                                     │ every minute (optional)
                                              sync Worker (sync-worker/) ── Discord API (shared/discord-guard.ts)
```

- **Pages Worker**: password gate, a Discord-compatible REST API and gateway (READY, realtime MESSAGE_CREATE,
  zlib-stream), media proxy with caching, attachment URL re-signing.
- **D1**: messages in zstd-compressed blocks of ~150 (`blocks` + `block_index`), plus side tables for users,
  attachments, threads, pins and forwarded-message content. See [docs/data-format.md](docs/data-format.md).
- **Sync Worker** (optional): one `GET /guilds/:id/channels` per minute, then only channels whose last message moved;
  one thread-discovery request per minute; at most 4 message fetches per run.

## Quick start · 快速开始

Requirements: Node.js 22+, Python 3.10+ with `pip install zstandard`, a Cloudflare account (free plan works).

```bash
git clone <this repo> && cd discord-archive-client
cd pages && npm install && cd ..
cd sync-worker && npm install && cd ..          # only if you want cloud sync

# 1. Discord's web client → pages/public/assets + pages/public/official-shell.html (~12k files, ~360 MB)
node scripts/fetch-client.mjs --out pages/public

# 2. Data: export your server (a bot with View Channels + Read Message History) …
DISCORD_TOKEN='Bot <token>' python3 scripts/export_guild.py --guild <server id> --out export
#    … or try the fictional demo server
python3 scripts/make_demo_export.py --out export

# 3. D1 database
npx wrangler d1 create discord-archive-db          # note the database_id
cp pages/wrangler.example.jsonc pages/wrangler.jsonc   # fill database_id, DISCORD_GUILD_ID, GUILD_NAME

# 4. Import (local for `wrangler pages dev`, remote for production)
python3 scripts/import_export.py --export export --out build/d1 --apply remote --db discord-archive-db

# 5. Deploy
cd pages && npm run build
npx wrangler pages project create discord-archive
npx wrangler pages secret put ACCESS_PASSWORD --project-name discord-archive
npx wrangler pages deploy dist --project-name discord-archive
```

Optional cloud sync:

```bash
cd sync-worker && cp wrangler.example.toml wrangler.toml   # same database_id and DISCORD_GUILD_ID
npx wrangler secret put DISCORD_TOKEN
npx wrangler deploy
```

Local development:

```bash
python3 scripts/import_export.py --export export --out build/d1 --apply local --db discord-archive-db
cd pages && npm run build && npm run dev        # https://127.0.0.1:8787 (set ACCESS_PASSWORD in wrangler.jsonc vars or .dev.vars)
```

## Configuration · 配置

Pages project (`pages/wrangler.jsonc` vars, or dashboard; secrets with `wrangler pages secret put`):

| Variable | Required | Meaning |
|---|---|---|
| `DISCORD_GUILD_ID` | yes | Server id of the archive |
| `ACCESS_PASSWORD` (secret) | yes* | Site password. *Or set `PUBLIC_ACCESS = "true"` to make the archive public |
| `GUILD_NAME` | | Server name shown in the UI (default "Discord Archive") |
| `GUILD_ICON` | | Server icon hash (served from Discord's CDN) |
| `GUILD_OWNER_ID` | | Owner user id |
| `HOME_CHANNEL_ID` | | Channel visitors land in (default: first text channel) |
| `VISITOR_NAME` | | Name of the visitor account in the UI (default "Visitor") |
| `LOCALE` / `COUNTRY_CODE` | | Client locale (default `en-US`) / country for billing-related stubs (default `US`) |
| `DISCORD_TOKEN` (secret) | | Enables live sync on visit, Discord search and attachment re-signing |
| `ORIGIN_URL` | | Optional origin for media files that are not in Pages or Discord's CDN |
| `GATEWAY` (Durable Object binding) | | The sync Worker's `DiscordGateway`, for realtime pushes (see Realtime sync) |

Sync Worker (`sync-worker/wrangler.toml`): `DISCORD_GUILD_ID`, secret `DISCORD_TOKEN`, optional `GUILD_OWNER_ID`,
`PRIORITY_CHANNEL_IDS` (comma-separated channels synced first when more than 4 changed in one minute),
`REALTIME_GATEWAY` (`"true"` = Discord gateway connection, see below).

`DISCORD_TOKEN` can be a bot token (`Bot <token>`) or a user token. Thread discovery uses `threads/search`, which only
user tokens may call; with a bot token new threads are picked up by re-running the exporter.

## Realtime sync · 实时同步

By default the sync Worker polls Discord's REST API once a minute (new messages appear within ~30–90 s).
With `REALTIME_GATEWAY = "true"` it instead keeps a **Discord gateway connection** open in a Durable Object
(`sync-worker/src/gateway.ts`):

- `MESSAGE_CREATE` / `MESSAGE_UPDATE` / `THREAD_*` for the server are written to D1 as they arrive and pushed to
  visitors through the Pages gateway (bind `GATEWAY` in `pages/wrangler.jsonc`) — about 1 second end to end.
- Disconnects resume the same session (missed events are replayed); new sessions are budgeted (≥ 2 min apart,
  ≤ 40/day); an invalid token (close code 4004) pauses it for 30 minutes. Deleted messages are kept.
- The cron becomes a watchdog: it (re)connects the gateway every minute and runs the REST sync only every 10 minutes
  as a backstop, or every minute again while the gateway is down.
- Free plan: one always-on Durable Object uses ~10,800 of the 13,000 GB-s included per day.
- With a **bot token** the bot needs the Message Content intent and the gateway only receives what it subscribes to.
  With a **user token** the connection receives events from every server the account is in, and running it 24/7 is a
  self-bot: against Discord's Terms of Service, with a real risk of the account being restricted.

实时同步：`REALTIME_GATEWAY = "true"` 时由 Durable Object 常驻连接 Discord 网关，新消息约 1 秒推给访客；
定时任务改为看门狗 + 每 10 分钟 REST 补漏。用个人令牌属于 self-bot，违反 Discord 服务条款，有封号风险。

## Cloudflare free plan · 免费版注意事项

- 100,000 Worker requests per day for the whole account. `pages/public/_routes.json` keeps `/assets/*`
  (the ~12k client files) out of the Worker; don't remove that, or one page load costs ~2,000 requests.
- `assets/version.*.json` are pinned to the downloaded build; never proxy them to discord.com, or idle tabs reload
  themselves in a loop.
- When the quota runs out, Pages serves `pages/public/index.html` (a notice page) until 00:00 UTC.
- The sync Worker costs ~1,440 requests/day plus ~1–2 Discord API calls per minute.

## Limitations · 限制

- Read-only archive of one server. No DMs, voice, or reactions history beyond what the export contains.
- Discord changes its client often. The compatibility API was developed against web builds 589596 and 641004;
  a future build may call endpoints that need new stubs (unknown endpoints answer 404, which the client tolerates).
- **Terms of Service**: serving Discord's client from another origin, and automating a user account ("self-bot"),
  may violate Discord's Terms of Service. Prefer a bot token, archive only servers you are allowed to archive, and
  keep archives private. This project is not affiliated with Discord.

## Tests

```bash
node test/guard-and-sync.test.mjs                 # offline: rate limiter + sync loop against a fake Discord
python3 scripts/make_demo_export.py --out demo-export && \
  python3 scripts/import_export.py --export demo-export --out build/d1 --apply local --db discord-archive-db
# start `npm run dev` in pages/ (wrangler.jsonc vars: demo ids printed above, ACCESS_PASSWORD=demo) and headless Chrome:
node test/e2e-demo.mjs --base https://127.0.0.1:8787 --cdp 9222 --export demo-export --password demo
```

## Credits · 致谢

- [aiko-chan-ai/DiscordBotClient](https://github.com/aiko-chan-ai/DiscordBotClient) — the approach, endpoint
  response shapes, and the experiments snapshots in `pages/src/experiments/` (GPL-3.0).

## License

GPL-3.0, same as DiscordBotClient. See [LICENSE](LICENSE).
