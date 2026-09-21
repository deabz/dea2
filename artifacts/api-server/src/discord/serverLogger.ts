import {
  AuditLogEvent,
  ChannelType,
  EmbedBuilder,
  Events,
  type Client,
  type Guild,
  type GuildMember,
  type Message,
  type TextBasedChannel,
} from "discord.js";
import { prisma } from "../lib/prisma";

export type LogCategory =
  | "messages"
  | "members"
  | "voice"
  | "channels"
  | "roles"
  | "server"
  | "commands"
  | "automod";

type LogSettings = {
  channelId: string | null;
  enabled: Record<LogCategory, boolean>;
  ignoredChannels: string[];
  ignoredRoles: string[];
  ignoredUsers: string[];
};

type QueueItem = { guildId: string; embed: EmbedBuilder; file?: { attachment: Buffer; name: string } };

const DEFAULT_CHANNEL_ID = "1183841843100795030";
const COLORS = { delete: 0xed4245, create: 0x57f287, update: 0xfee75c, info: 0x5865f2, command: 0x9b59b6 };
const CATEGORIES: LogCategory[] = ["messages", "members", "voice", "channels", "roles", "server", "commands", "automod"];
const queue: QueueItem[] = [];
let draining = false;
const settingsCache = new Map<string, LogSettings>();
type MessageSnapshot = {
  id: string;
  guildId: string;
  channelId: string;
  authorId: string;
  authorTag: string;
  content: string;
  attachments: string;
  imageUrl: string | null;
};
const snapshots = new Map<string, MessageSnapshot>();

const defaultSettings = (): LogSettings => ({
  channelId: null,
  enabled: Object.fromEntries(CATEGORIES.map((category) => [category, true])) as Record<LogCategory, boolean>,
  ignoredChannels: [],
  ignoredRoles: [],
  ignoredUsers: [],
});

function truncate(value: unknown, max: number): string {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function idText(value: string | null | undefined): string {
  return value ? `<#${value}> (${value})` : "Unavailable";
}

function imageUrlFromMessage(message: Message): string | null {
  return [...message.attachments.values()].find((attachment) =>
    attachment.contentType?.startsWith("image/") ||
    /\.(?:avif|gif|jpe?g|png|webp)(?:$|[?#])/i.test(attachment.name ?? attachment.url),
  )?.url ?? null;
}

function snapshotMessage(message: Message): MessageSnapshot | null {
  if (!message.guild) return null;
  return {
    id: message.id,
    guildId: message.guild.id,
    channelId: message.channelId,
    authorId: message.author?.id ?? "Unavailable",
    authorTag: message.author?.tag ?? "Unavailable",
    content: message.content || "No text content",
    attachments: [...message.attachments.values()]
      .map((attachment) => `${attachment.name}: ${attachment.url}`)
      .join("\n") || "None",
    imageUrl: imageUrlFromMessage(message),
  };
}

function rememberMessage(message: Message): void {
  const snapshot = snapshotMessage(message);
  if (snapshot) snapshots.set(message.id, snapshot);
}

async function getSettings(guildId: string): Promise<LogSettings> {
  const cached = settingsCache.get(guildId);
  if (cached) return cached;
  const row = await prisma.$queryRaw<Array<{ channelId: string | null; enabled: string; ignoredChannels: string; ignoredRoles: string; ignoredUsers: string }>>`
    SELECT "channelId", "enabled", "ignoredChannels", "ignoredRoles", "ignoredUsers"
    FROM "ServerLogConfig" WHERE "guildId" = ${guildId} LIMIT 1
  `;
  const base = defaultSettings();
  if (row[0]) {
    try {
      base.channelId = row[0].channelId;
      base.enabled = { ...base.enabled, ...(JSON.parse(row[0].enabled) as Partial<Record<LogCategory, boolean>>) };
      base.ignoredChannels = JSON.parse(row[0].ignoredChannels) as string[];
      base.ignoredRoles = JSON.parse(row[0].ignoredRoles) as string[];
      base.ignoredUsers = JSON.parse(row[0].ignoredUsers) as string[];
    } catch (error) {
      console.error("Failed to parse server log settings", error);
    }
  }
  settingsCache.set(guildId, base);
  return base;
}

async function saveSettings(guildId: string, settings: LogSettings): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "ServerLogConfig" ("guildId", "channelId", "enabled", "ignoredChannels", "ignoredRoles", "ignoredUsers")
    VALUES (${guildId}, ${settings.channelId}, ${JSON.stringify(settings.enabled)}, ${JSON.stringify(settings.ignoredChannels)}, ${JSON.stringify(settings.ignoredRoles)}, ${JSON.stringify(settings.ignoredUsers)})
    ON CONFLICT("guildId") DO UPDATE SET "channelId" = excluded."channelId", "enabled" = excluded."enabled",
      "ignoredChannels" = excluded."ignoredChannels", "ignoredRoles" = excluded."ignoredRoles", "ignoredUsers" = excluded."ignoredUsers"
  `;
  settingsCache.set(guildId, settings);
}

export async function configureLogs(guildId: string, update: Partial<LogSettings>): Promise<LogSettings> {
  const settings = await getSettings(guildId);
  const next = { ...settings, ...update, enabled: { ...settings.enabled, ...(update.enabled ?? {}) } };
  await saveSettings(guildId, next);
  return next;
}

export async function getLogSettings(guildId: string): Promise<LogSettings> {
  return getSettings(guildId);
}

export async function toggleLogCategory(guildId: string, category: LogCategory): Promise<LogSettings> {
  const settings = await getSettings(guildId);
  return configureLogs(guildId, { enabled: { ...settings.enabled, [category]: !settings.enabled[category] } });
}

export async function ignoreLogTarget(guildId: string, kind: "channel" | "role" | "user", id: string): Promise<LogSettings> {
  const settings = await getSettings(guildId);
  const key = kind === "channel" ? "ignoredChannels" : kind === "role" ? "ignoredRoles" : "ignoredUsers";
  const values = settings[key].includes(id) ? settings[key].filter((value) => value !== id) : [...settings[key], id];
  return configureLogs(guildId, { [key]: values });
}

async function auditActor(guild: Guild, type: AuditLogEvent, targetId?: string): Promise<string> {
  try {
    const logs = await guild.fetchAuditLogs({ type, limit: 6 });
    const entry = logs.entries.find((item) => Date.now() - item.createdTimestamp < 8_000 && (!targetId || (item.target as { id?: string } | null)?.id === targetId));
    return entry?.executor ? `${entry.executor.tag} (${entry.executor.id})` : "Discord did not provide an actor";
  } catch {
    return "Discord did not provide an actor";
  }
}

function embed(guild: Guild, title: string, color: number, details: Array<[string, string]>, target?: string, imageUrl?: string | null): EmbedBuilder {
  const fields = details.map(([name, value]) => ({ name: truncate(name, 256), value: truncate(value || "No additional data", 1024), inline: true }));
  const result = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .addFields(fields)
    .setFooter({ text: `Guild ${guild.id}${target ? ` • Target ${target}` : ""}` })
    .setTimestamp();
  if (imageUrl) result.setImage(imageUrl);
  return result;
}

function ignored(settings: LogSettings, category: LogCategory, message?: Message): boolean {
  if (!settings.enabled[category]) return true;
  if (!message) return false;
  const logChannelId = settings.channelId ?? process.env.LOG_CHANNEL_ID ?? DEFAULT_CHANNEL_ID;
  if (message.channelId === logChannelId) return true;
  if (message.author.bot && process.env.LOG_BOT_MESSAGES !== "true") return true;
  return settings.ignoredChannels.includes(message.channelId) ||
    settings.ignoredUsers.includes(message.author.id) ||
    (message.member?.roles.cache.some((role) => settings.ignoredRoles.includes(role.id)) ?? false);
}

export function enqueue(guild: Guild, category: LogCategory, item: EmbedBuilder, file?: QueueItem["file"], message?: Message): void {
  void getSettings(guild.id).then((settings) => {
    if (ignored(settings, category, message)) return;
    queue.push({ guildId: guild.id, embed: item, file });
    void drain();
  }).catch((error) => console.error("Failed to queue server log", error));
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const batch = queue.splice(0, 10);
      const grouped = new Map<string, QueueItem[]>();
      for (const item of batch) grouped.set(item.guildId, [...(grouped.get(item.guildId) ?? []), item]);
      for (const [guildId, items] of grouped) {
        const channelId = (await getSettings(guildId)).channelId ?? process.env.LOG_CHANNEL_ID ?? DEFAULT_CHANNEL_ID;
        const channel = (await globalClient?.channels.fetch(channelId).catch(() => null)) as TextBasedChannel | null;
        if (!channel || !("send" in channel)) continue;
        try {
          await channel.send({ embeds: items.map((item) => item.embed), files: items.filter((item) => item.file).map((item) => item.file!) });
        } catch (error) {
          console.error("Failed to send server log", error);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    draining = false;
  }
}

let globalClient: Client | null = null;
export function logCommand(guild: Guild, userId: string, command: string, options: string, channelId: string, prefix = false): void {
  enqueue(guild, "commands", embed(guild, `${prefix ? "Prefix" : "Slash"} command used`, COLORS.command, [
    ["Who", `<@${userId}> (${userId})`], ["Command", `\`${command}\``], ["Options", truncate(options || "none", 1024)], ["Channel", idText(channelId)],
  ]));
}

export function logCommandError(guild: Guild, userId: string, command: string, error: unknown): void {
  enqueue(guild, "commands", embed(guild, "Command error", COLORS.delete, [["Who", `<@${userId}> (${userId})`], ["Command", command], ["Error", error instanceof Error ? error.message : String(error)] ]));
}

function messageContent(message: Message): string {
  return message.content || "No text content";
}

function attachmentDetails(message: Message): string {
  return [...message.attachments.values()].map((attachment) => `${attachment.name}: ${attachment.url}`).join("\n") || "none";
}

export function registerServerLogger(client: Client): void {
  globalClient = client;
  const safe = (event: string, handler: (...args: any[]) => Promise<void> | void) => {
    client.on(event as never, (...args: any[]) => {
      void Promise.resolve(handler(...args)).catch((error) => console.error(`Server log handler failed for ${event}`, error));
    });
  };

  safe(Events.MessageDelete, async (message: Message) => {
    const full = message.partial ? await message.fetch().catch(() => null) : message;
    const snapshot = (full && snapshotMessage(full)) ?? snapshots.get(message.id);
    const guild = full?.guild ?? (snapshot ? globalClient?.guilds.cache.get(snapshot.guildId) : undefined);
    if (guild && snapshot) {
      const auditedActor = await auditActor(guild, AuditLogEvent.MessageDelete, snapshot.authorId);
      const actor = auditedActor === "Discord did not provide an actor"
        ? `${snapshot.authorTag} (${snapshot.authorId}) (self-delete or unavailable)`
        : auditedActor;
      enqueue(guild, "messages", embed(guild, "Message deleted", COLORS.delete, [
        ["Who", actor], ["Author", `${snapshot.authorTag} (${snapshot.authorId})`],
        ["Channel", idText(snapshot.channelId)], ["Content", snapshot.content], ["Attachments", snapshot.attachments],
      ], undefined, snapshot.imageUrl));
      snapshots.delete(message.id);
    }
  });
  safe(Events.MessageUpdate, async (oldMessage: Message, newMessage: Message) => {
    if (!newMessage.guild) return;
    const before = oldMessage.partial ? snapshots.get(oldMessage.id)?.content : messageContent(oldMessage);
    const fetched = newMessage.partial ? await newMessage.fetch().catch(() => newMessage) : newMessage;
    enqueue(newMessage.guild, "messages", embed(newMessage.guild, "Message updated", COLORS.update, [
      ["Who", fetched.author ? `${fetched.author.tag} (${fetched.author.id})` : "Unavailable"],
      ["Channel", idText(fetched.channelId)], ["Before", before ?? "No previous snapshot available"],
      ["After", messageContent(fetched)], ["Attachments", attachmentDetails(fetched)],
    ], undefined, imageUrlFromMessage(fetched)), undefined, fetched);
    rememberMessage(fetched);
  });
  safe(Events.MessageBulkDelete, async (messages: any) => {
    const first = messages.first?.() as Message | undefined;
    if (first?.guild) enqueue(first.guild, "messages", embed(first.guild, "Messages bulk deleted", COLORS.delete, [["Who", await auditActor(first.guild, AuditLogEvent.MessageBulkDelete)], ["Channel", idText(first.channelId)], ["Count", String(messages.size)] ]));
  });
  safe(Events.MessageReactionAdd, async (reaction: any, user: any) => {
    const message = reaction.message as Message;
    if (message.guild) enqueue(message.guild, "messages", embed(message.guild, "Reaction added", COLORS.create, [["Who", `${user.tag} (${user.id})`], ["Emoji", reaction.emoji.toString()], ["Message", message.id], ["Channel", idText(message.channelId)]]), undefined, message);
  });
  safe(Events.MessageReactionRemove, async (reaction: any, user: any) => {
    const message = reaction.message as Message;
    if (message.guild) enqueue(message.guild, "messages", embed(message.guild, "Reaction removed", COLORS.delete, [["Who", `${user.tag} (${user.id})`], ["Emoji", reaction.emoji.toString()], ["Message", message.id], ["Channel", idText(message.channelId)]]), undefined, message);
  });
  safe(Events.MessageReactionRemoveAll, async (message: Message) => { if (message.guild) enqueue(message.guild, "messages", embed(message.guild, "All reactions removed", COLORS.delete, [["Who", await auditActor(message.guild, AuditLogEvent.MessagePin)], ["Message", message.id], ["Channel", idText(message.channelId)]])); });
  safe(Events.MessageReactionRemoveEmoji, async (reaction: any) => { const message = reaction.message as Message; if (message.guild) enqueue(message.guild, "messages", embed(message.guild, "Reaction emoji removed", COLORS.delete, [["Who", "Discord did not include the actor in this event"], ["Emoji", reaction.emoji.toString()], ["Message", message.id]])); });
  safe(Events.ChannelPinsUpdate, async (channel: any) => { if (channel.guild) enqueue(channel.guild, "messages", embed(channel.guild, "Channel pins updated", COLORS.update, [["Who", await auditActor(channel.guild, AuditLogEvent.MessagePin)], ["Channel", idText(channel.id)]])); });
  safe(Events.MessageCreate, async (message: Message) => {
    if (message.guild) rememberMessage(message);
  });

  safe(Events.GuildMemberAdd, async (member: GuildMember) => enqueue(member.guild, "members", embed(member.guild, "Member joined", COLORS.create, [["Who", `${member.user.tag} (${member.id})`], ["Account age", `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`], ["Invite", "Discord did not expose the used invite"]])));
  safe(Events.GuildMemberRemove, async (member: GuildMember) => enqueue(member.guild, "members", embed(member.guild, "Member left", COLORS.delete, [["Who", `${member.user.tag} (${member.id})`], ["Actor", await auditActor(member.guild, AuditLogEvent.MemberKick, member.id)]])));
  safe(Events.GuildBanAdd, async (ban: any) => enqueue(ban.guild, "members", embed(ban.guild, "Member banned", COLORS.delete, [["Who", `${ban.user.tag} (${ban.user.id})`], ["Actor", await auditActor(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id)], ["Reason", ban.reason ?? "No reason provided"]])));
  safe(Events.GuildBanRemove, async (ban: any) => enqueue(ban.guild, "members", embed(ban.guild, "Member unbanned", COLORS.create, [["Who", `${ban.user.tag} (${ban.user.id})`], ["Actor", await auditActor(ban.guild, AuditLogEvent.MemberBanRemove, ban.user.id)], ["Reason", ban.reason ?? "No reason provided"]])));
  safe(Events.GuildMemberUpdate, async (oldMember: GuildMember, member: GuildMember) => {
    const changes: Array<[string, string]> = [];
    if (oldMember.nickname !== member.nickname) changes.push(["Nickname", `${oldMember.nickname ?? "none"} → ${member.nickname ?? "none"}`]);
    const added = member.roles.cache.filter((role) => !oldMember.roles.cache.has(role.id)).map((role) => role.name);
    const removed = oldMember.roles.cache.filter((role) => !member.roles.cache.has(role.id)).map((role) => role.name);
    if (added.length) changes.push(["Roles added", added.join(", ")]);
    if (removed.length) changes.push(["Roles removed", removed.join(", ")]);
    if (oldMember.communicationDisabledUntilTimestamp !== member.communicationDisabledUntilTimestamp) changes.push(["Timeout", member.communicationDisabledUntilTimestamp ? `until <t:${Math.floor(member.communicationDisabledUntilTimestamp / 1000)}:F>` : "removed"]);
    if (changes.length) enqueue(member.guild, "members", embed(member.guild, "Member updated", COLORS.update, [["Who", await auditActor(member.guild, AuditLogEvent.MemberUpdate, member.id)], ["Member", `${member.user.tag} (${member.id})`], ...changes]));
  });
  safe(Events.UserUpdate, async (oldUser: any, user: any) => { for (const guild of globalClient?.guilds.cache.values() ?? []) { if (oldUser.username !== user.username || oldUser.globalName !== user.globalName || oldUser.avatar !== user.avatar) enqueue(guild, "members", embed(guild, "User profile updated", COLORS.update, [["User", `${user.tag} (${user.id})`], ["Username", `${oldUser.username} → ${user.username}`], ["Global name", `${oldUser.globalName ?? "none"} → ${user.globalName ?? "none"}`], ["Avatar", oldUser.avatar !== user.avatar ? "changed" : "unchanged"]])); } });
  safe(Events.VoiceStateUpdate, async (oldState: any, newState: any) => {
    const member = newState.member ?? oldState.member; if (!member) return;
    const changes: Array<[string, string]> = [];
    if (oldState.channelId !== newState.channelId) changes.push(["Channel", `${idText(oldState.channelId)} → ${idText(newState.channelId)}`]);
    if (oldState.serverMute !== newState.serverMute) changes.push(["Server mute", String(newState.serverMute)]);
    if (oldState.serverDeaf !== newState.serverDeaf) changes.push(["Server deafen", String(newState.serverDeaf)]);
    if (oldState.selfMute !== newState.selfMute) changes.push(["Self mute", String(newState.selfMute)]);
    if (oldState.selfDeaf !== newState.selfDeaf) changes.push(["Self deafen", String(newState.selfDeaf)]);
    if (oldState.streaming !== newState.streaming) changes.push(["Stream", newState.streaming ? "started" : "stopped"]);
    if (oldState.selfVideo !== newState.selfVideo) changes.push(["Camera", newState.selfVideo ? "on" : "off"]);
    if (changes.length) enqueue(member.guild, "voice", embed(member.guild, "Voice state updated", COLORS.info, [["Who", `${member.user.tag} (${member.id})`], ...changes]));
  });

  const generic: Array<[string, LogCategory, string, number]> = [
    [Events.ChannelCreate, "channels", "Channel created", COLORS.create], [Events.ChannelDelete, "channels", "Channel deleted", COLORS.delete], [Events.ChannelUpdate, "channels", "Channel updated", COLORS.update],
    [Events.ThreadCreate, "channels", "Thread created", COLORS.create], [Events.ThreadDelete, "channels", "Thread deleted", COLORS.delete], [Events.ThreadUpdate, "channels", "Thread updated", COLORS.update],
    [Events.ThreadMembersUpdate, "channels", "Thread members updated", COLORS.update], [Events.GuildRoleCreate, "roles", "Role created", COLORS.create], [Events.GuildRoleDelete, "roles", "Role deleted", COLORS.delete], [Events.GuildRoleUpdate, "roles", "Role updated", COLORS.update],
    [Events.GuildUpdate, "server", "Server updated", COLORS.update], [Events.GuildEmojiCreate, "server", "Emoji created", COLORS.create], [Events.GuildEmojiDelete, "server", "Emoji deleted", COLORS.delete], [Events.GuildEmojiUpdate, "server", "Emoji updated", COLORS.update],
    [Events.GuildCreate, "server", "Bot added to server", COLORS.create], [Events.GuildDelete, "server", "Bot removed from server", COLORS.delete],
    [Events.GuildStickerCreate, "server", "Sticker created", COLORS.create], [Events.GuildStickerDelete, "server", "Sticker deleted", COLORS.delete], [Events.GuildStickerUpdate, "server", "Sticker updated", COLORS.update],
    [Events.InviteCreate, "server", "Invite created", COLORS.create], [Events.InviteDelete, "server", "Invite deleted", COLORS.delete], [Events.WebhooksUpdate, "server", "Webhooks updated", COLORS.update],
    [Events.GuildIntegrationsUpdate, "server", "Integrations updated", COLORS.update],
    [Events.StageInstanceCreate, "voice", "Stage instance created", COLORS.create], [Events.StageInstanceUpdate, "voice", "Stage instance updated", COLORS.update], [Events.StageInstanceDelete, "voice", "Stage instance deleted", COLORS.delete],
    [Events.GuildScheduledEventCreate, "server", "Scheduled event created", COLORS.create], [Events.GuildScheduledEventDelete, "server", "Scheduled event deleted", COLORS.delete], [Events.GuildScheduledEventUpdate, "server", "Scheduled event updated", COLORS.update],
    [Events.GuildScheduledEventUserAdd, "server", "Scheduled event user joined", COLORS.create], [Events.GuildScheduledEventUserRemove, "server", "Scheduled event user left", COLORS.delete],
    [Events.AutoModerationRuleCreate, "automod", "Automod rule created", COLORS.create], [Events.AutoModerationRuleUpdate, "automod", "Automod rule updated", COLORS.update], [Events.AutoModerationRuleDelete, "automod", "Automod rule deleted", COLORS.delete], [Events.AutoModerationActionExecution, "automod", "Automod action executed", COLORS.delete],
  ];
  for (const [event, category, title, color] of generic) safe(event, async (item: any) => {
    const guild = item?.guild ?? (item?.guildId ? globalClient?.guilds.cache.get(item.guildId) : undefined);
    if (!guild) return;
    enqueue(guild, category, embed(guild, title, color, [["Actor", await auditActor(guild, AuditLogEvent.ChannelUpdate, item?.id)], ["Target", item?.name ?? item?.id ?? "Event target unavailable"], ["Details", JSON.stringify(item?.changes ?? item?.options ?? "No additional event data")]]));
  });
}
