// 身份组和成员资料：sync-worker（members.ts）写入，Pages 读取。
// - metadata.guild_roles：服务器的身份组列表和 features，{ roles, features, fetched_at }
// - member_meta：每个用户一行。profile 是 /users/:id/profile?guild_id= 的响应（guild_member 去掉 user；
//   机器人令牌没有资料接口，只有 { user, guild_member }）。fetched_at = 0 表示还没拉到。
//   due_at：下次该拉的时间，队列按 (due_at, wanted_at DESC) 走索引，每轮只读要拉的那几行（D1 免费版按读取行数计额度）：
//   访客的客户端要过的 due_at = 0、wanted_at = 时间；发言者 due_at = 1、wanted_at = 发言数；拉过的 = 下次刷新时间

export const GUILD_ROLES_KEY = 'guild_roles';

export const MEMBER_TABLE_SQL = [
  'CREATE TABLE IF NOT EXISTS member_meta (user_id TEXT PRIMARY KEY, in_guild INTEGER NOT NULL DEFAULT 0, nick TEXT, profile TEXT, ' +
  'fetched_at INTEGER NOT NULL DEFAULT 0, wanted_at INTEGER NOT NULL DEFAULT 0, due_at INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID',
  'CREATE INDEX IF NOT EXISTS member_meta_due ON member_meta (due_at, wanted_at DESC)'
];

const tableReady = new WeakMap<D1Database, Promise<void>>();

export function ensureMemberTable(db: D1Database): Promise<void> {
  let ready = tableReady.get(db);
  if (!ready) {
    ready = (async () => { for (const sql of MEMBER_TABLE_SQL) await db.prepare(sql).run(); })()
      .catch((err) => { tableReady.delete(db); throw err; });
    tableReady.set(db, ready);
  }
  return ready;
}
