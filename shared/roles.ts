// 身份组：sync-worker（roles.ts）把服务器的身份组列表写进 metadata.guild_roles（{ roles, features, fetched_at }），Pages 读取。
// 每个人的身份组、服务器昵称和头像在 D1 的 member_meta（scripts/backfill_members.mjs 用网关批量拉取，见 scripts/schema.sql）
export const GUILD_ROLES_KEY = 'guild_roles';
