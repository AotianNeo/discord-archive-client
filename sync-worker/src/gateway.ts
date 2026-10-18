// 实时同步：一个常驻的 Durable Object 以 DISCORD_TOKEN 的身份连 Discord 官方网关（wss://gateway.discord.gg），
// 收到本服务器的 MESSAGE_CREATE / MESSAGE_UPDATE / THREAD_* 立刻写进 D1，并推给订阅的 Pages 网关（访客浏览器约 1 秒内看到）。
// - 断线优先 RESUME（session_id + seq + resume_gateway_url，存在 DO storage，DO 被驱逐重建后也能续上）；
//   新会话（IDENTIFY）有预算：两次之间至少 2 分钟、24 小时内最多 40 次；4004（令牌失效）后停 30 分钟。
// - 30 秒一次的 alarm 是看门狗：连接不在、心跳没回 ACK、或长时间没有任何事件，就断开重连。
// - 不处理 MESSAGE_DELETE：归档保留被删的消息。
// 用个人令牌挂网关属于 self-bot，违反 Discord 服务条款，账号有被限制的风险；机器人令牌（"Bot ..."）按 intents 只收需要的事件。
import { DurableObject } from 'cloudflare:workers';
import { ArchiveRecord, toRecord, writeRecords } from './records';

export interface GatewayEnv {
  DB: D1Database;
  DISCORD_TOKEN: string;
  DISCORD_GUILD_ID: string;
  GUILD_OWNER_ID?: string;
  REALTIME_GATEWAY?: string;
  GATEWAY: DurableObjectNamespace;
}

const GATEWAY_HOST = 'https://gateway.discord.gg';
const WATCHDOG_MS = 30_000;
const SILENCE_LIMIT_MS = 3 * 60_000;     // 这么久一个事件（含心跳 ACK）都没有，就当连接已死
const IDENTIFY_MIN_GAP_MS = 120_000;
const IDENTIFY_PER_DAY = 40;
const AUTH_FAILED_PAUSE_MS = 30 * 60_000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
// 机器人：GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT（特权 intent，需在开发者后台开启）
const BOT_INTENTS = (1 << 0) | (1 << 9) | (1 << 15);

export function gatewayStub(env: { GATEWAY: DurableObjectNamespace; DISCORD_GUILD_ID: string }): DurableObjectStub {
  return env.GATEWAY.get(env.GATEWAY.idFromName(env.DISCORD_GUILD_ID));
}

interface Session { sessionId?: string; resumeUrl?: string; seq: number | null }

export interface GatewayStatus {
  state: string;
  connectedAt: number;
  readyAt: number;
  lastEventAt: number;
  lastMessageAt: number;
  messages: number;
  reconnects: number;
  lastClose: string;
  subscribers: number;
}

export class DiscordGateway extends DurableObject<GatewayEnv> {
  private ws: WebSocket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private acked = true;
  private session: Session = { seq: null };
  private connecting: Promise<void> | null = null;
  private status: Omit<GatewayStatus, 'subscribers'> = {
    state: 'idle', connectedAt: 0, readyAt: 0, lastEventAt: 0, lastMessageAt: 0, messages: 0, reconnects: 0, lastClose: ''
  };

  constructor(ctx: DurableObjectState, env: GatewayEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.session = (await ctx.storage.get<Session>('session')) || { seq: null };
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/subscribe') {
      // Pages 网关订阅新消息；用休眠 API 接受，空闲时不计时长
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('expected websocket', { status: 426 });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === '/ensure') await this.ensure();
    return Response.json(this.publicStatus());
  }

  async alarm(): Promise<void> {
    await this.ensure();
    if (this.session.sessionId) await this.ctx.storage.put('session', this.session);
  }

  async webSocketMessage(): Promise<void> {}

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch (_) {}
  }

  private publicStatus(): GatewayStatus {
    return { ...this.status, subscribers: this.ctx.getWebSockets().length };
  }

  private async ensure(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
    if (this.env.REALTIME_GATEWAY !== 'true' || !this.env.DISCORD_TOKEN || !this.env.DISCORD_GUILD_ID) {
      this.disconnect('disabled', 1000);
      this.status.state = 'disabled';
      return;
    }
    const pausedUntil = (await this.ctx.storage.get<number>('pausedUntil')) || 0;
    if (pausedUntil > Date.now()) {
      this.status.state = 'auth-failed';
      return;
    }
    if (this.ws && Date.now() - this.status.lastEventAt > SILENCE_LIMIT_MS) this.reconnect('silent connection');
    if (this.ws) return;
    if (!this.connecting) {
      this.connecting = this.openGateway()
        .catch((err) => { this.status.state = 'error'; this.status.lastClose = String(err?.message || err); })
        .finally(() => { this.connecting = null; });
    }
    await this.connecting;
  }

  private async identifyAllowed(): Promise<boolean> {
    const now = Date.now();
    const log = ((await this.ctx.storage.get<number[]>('identifies')) || []).filter((t) => now - t < 86_400_000);
    return !(log.length && now - log[log.length - 1] < IDENTIFY_MIN_GAP_MS) && log.length < IDENTIFY_PER_DAY;
  }

  private async recordIdentify(): Promise<void> {
    const now = Date.now();
    const log = ((await this.ctx.storage.get<number[]>('identifies')) || []).filter((t) => now - t < 86_400_000);
    log.push(now);
    await this.ctx.storage.put('identifies', log);
  }

  private async openGateway(): Promise<void> {
    const resume = Boolean(this.session.sessionId && this.session.resumeUrl && this.session.seq != null);
    if (!resume && !(await this.identifyAllowed())) {
      this.status.state = 'waiting-identify-budget';
      return;
    }
    const base = (resume ? this.session.resumeUrl! : GATEWAY_HOST).replace(/^wss:/, 'https:').replace(/\/+$/, '');
    const isBot = this.env.DISCORD_TOKEN.toLowerCase().startsWith('bot ');
    const headers: Record<string, string> = { Upgrade: 'websocket' };
    if (!isBot) Object.assign(headers, { 'User-Agent': UA, Origin: 'https://discord.com' });
    const resp = await fetch(`${base}/?v=10&encoding=json`, { headers });
    const ws = resp.webSocket;
    if (!ws) throw new Error(`gateway handshake failed: ${resp.status}`);
    ws.accept();
    this.ws = ws;
    this.status.state = resume ? 'resuming' : 'connecting';
    this.status.connectedAt = this.status.lastEventAt = Date.now();
    ws.addEventListener('message', (ev) => { this.onMessage(ws, ev.data, resume).catch((err) => console.warn('[Gateway] 事件处理失败:', err)); });
    ws.addEventListener('close', (ev) => this.onClose(ws, ev.code, ev.reason));
    ws.addEventListener('error', () => this.onClose(ws, 1006, 'socket error'));
  }

  private send(ws: WebSocket, payload: unknown): void {
    try { ws.send(JSON.stringify(payload)); } catch (_) {}
  }

  private identifyPayload() {
    const token = this.env.DISCORD_TOKEN;
    if (token.toLowerCase().startsWith('bot ')) {
      return { op: 2, d: { token: token.slice(4).trim(), intents: BOT_INTENTS, properties: { os: 'linux', browser: 'discord-archive-client', device: 'discord-archive-client' } } };
    }
    return {
      op: 2,
      d: {
        token,
        capabilities: 0,
        properties: {
          os: 'Mac OS X', browser: 'Chrome', device: '', system_locale: 'en-US', browser_user_agent: UA, browser_version: '140.0.0.0',
          os_version: '10.15.7', referrer: '', referring_domain: '', referrer_current: '', referring_domain_current: '',
          release_channel: 'stable', client_event_source: null
        },
        // status 'unknown' = 沿用账号自己的在线状态，这个会话不改变别人看到的状态
        presence: { status: 'unknown', since: 0, activities: [], afk: false },
        compress: false,
        client_state: { guild_versions: {} }
      }
    };
  }

  private async onMessage(ws: WebSocket, data: unknown, resuming: boolean): Promise<void> {
    if (ws !== this.ws) return;
    const packet = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer));
    this.status.lastEventAt = Date.now();
    if (packet.s != null) this.session.seq = packet.s;
    switch (packet.op) {
      case 10: // HELLO
        this.startHeartbeat(ws, Number(packet.d?.heartbeat_interval) || 41_250);
        if (resuming) {
          this.send(ws, { op: 6, d: { token: this.env.DISCORD_TOKEN.replace(/^bot\s+/i, ''), session_id: this.session.sessionId, seq: this.session.seq } });
        } else {
          await this.recordIdentify();
          this.send(ws, this.identifyPayload());
        }
        break;
      case 11:
        this.acked = true;
        break;
      case 1:
        this.send(ws, { op: 1, d: this.session.seq });
        break;
      case 7: // 服务器要求重连：断开后用同一会话 RESUME
        this.reconnect('server requested reconnect');
        break;
      case 9: // 会话无效；d=false 时不能续，下次要重新 IDENTIFY
        if (!packet.d) {
          this.session = { seq: null };
          await this.ctx.storage.put('session', this.session);
        }
        this.reconnect('invalid session');
        break;
      case 0:
        await this.dispatch(String(packet.t), packet.d);
        break;
    }
  }

  private startHeartbeat(ws: WebSocket, interval: number): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.acked = true;
    this.heartbeat = setInterval(() => {
      if (ws !== this.ws) return;
      if (!this.acked) return this.reconnect('missed heartbeat ack');
      this.acked = false;
      this.send(ws, { op: 1, d: this.session.seq });
    }, interval);
  }

  private async dispatch(type: string, d: any): Promise<void> {
    const guildId = this.env.DISCORD_GUILD_ID;
    switch (type) {
      case 'READY':
        this.session = { sessionId: d.session_id, resumeUrl: d.resume_gateway_url, seq: this.session.seq };
        await this.ctx.storage.put('session', this.session);
        this.status.state = 'ready';
        this.status.readyAt = Date.now();
        if (!this.env.DISCORD_TOKEN.toLowerCase().startsWith('bot ')) {
          // 和官方客户端打开服务器时一样订阅本服务器的子区事件（不要打字、在线状态等）
          this.send(this.ws!, { op: 37, d: { subscriptions: { [guildId]: { typing: false, threads: true, activities: false, member_updates: false } } } });
        }
        break;
      case 'RESUMED':
        this.status.state = 'ready';
        this.status.readyAt = Date.now();
        break;
      case 'MESSAGE_CREATE':
      case 'MESSAGE_UPDATE': {
        // 只要本服务器；MESSAGE_UPDATE 可能只带部分字段（如链接预览），没有 author 的跳过
        if (String(d?.guild_id) !== guildId || !d?.author) return;
        const record = toRecord(d, String(d.channel_id), (this.env.GUILD_OWNER_ID || '').trim() || '0');
        await this.env.DB.batch([
          ...writeRecords(this.env.DB, record.channel_id, [record]),
          // 帖子/子区里的消息：推进 thread_meta（不是子区时这条 UPDATE 什么也不做）
          this.env.DB.prepare(
            'UPDATE thread_meta SET last_message_id = ?, message_count = message_count + ? ' +
            'WHERE id = ? AND CAST(last_message_id AS INTEGER) < CAST(? AS INTEGER)'
          ).bind(record.id, type === 'MESSAGE_CREATE' ? 1 : 0, record.channel_id, record.id)
        ]);
        this.status.messages++;
        this.status.lastMessageAt = Date.now();
        this.broadcast(type, record);
        break;
      }
      case 'THREAD_CREATE':
      case 'THREAD_UPDATE':
        if (String(d?.guild_id) === guildId) await this.upsertThreads([d]);
        break;
      case 'THREAD_LIST_SYNC':
        if (String(d?.guild_id) === guildId) await this.upsertThreads(d.threads || []);
        break;
    }
  }

  private async upsertThreads(threads: any[]): Promise<void> {
    const rows = threads.filter((t) => t?.id && t.parent_id);
    if (!rows.length) return;
    await this.env.DB.batch(rows.map((t) => this.env.DB.prepare(
      'INSERT INTO thread_meta (id, parent_id, name, owner_id, message_count, last_message_id, archived) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET name = excluded.name, archived = excluded.archived, message_count = MAX(thread_meta.message_count, excluded.message_count), ' +
      'last_message_id = CASE WHEN CAST(excluded.last_message_id AS INTEGER) > CAST(thread_meta.last_message_id AS INTEGER) THEN excluded.last_message_id ELSE thread_meta.last_message_id END'
    ).bind(String(t.id), String(t.parent_id), String(t.name || ''), String(t.owner_id || '0'), Number(t.message_count || 0),
      String(t.last_message_id || t.id), t.thread_metadata?.archived ? 1 : 0)));
  }

  private broadcast(type: string, record: ArchiveRecord): void {
    const payload = JSON.stringify({ t: type, record });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(payload); } catch (_) {}
    }
  }

  private onClose(ws: WebSocket, code: number, reason: string): void {
    if (ws !== this.ws) return;
    this.disconnect(`${code} ${reason}`.trim());
    this.status.lastClose = `${code} ${reason}`.trim();
    if (code === 4004) {
      // 令牌被拒：停 30 分钟，避免反复用失效令牌 IDENTIFY
      this.status.state = 'auth-failed';
      this.ctx.storage.put('pausedUntil', Date.now() + AUTH_FAILED_PAUSE_MS);
      return;
    }
    if ([4010, 4011, 4012, 4013, 4014].includes(code)) {
      this.status.state = `fatal ${code}`;
      return;
    }
    if (code === 4007 || code === 4009) this.session = { seq: null }; // seq 无效 / 会话超时：只能重新 IDENTIFY
    this.status.reconnects++;
    setTimeout(() => { this.ensure().catch(() => {}); }, 1000 + Math.random() * 4000);
  }

  private reconnect(reason: string): void {
    this.disconnect(reason);
    this.status.reconnects++;
    setTimeout(() => { this.ensure().catch(() => {}); }, 1000 + Math.random() * 4000);
  }

  // 关闭码 1000/1001 会让 Discord 作废会话（不能再 RESUME）；重连时用 4000，只有停用时才用 1000
  private disconnect(reason: string, closeCode = 4000): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try { ws.close(closeCode, reason.slice(0, 100)); } catch (_) {}
      this.status.state = 'closed';
    }
  }
}
