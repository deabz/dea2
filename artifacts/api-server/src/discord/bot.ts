import {
  ActivityType,
  Client,
  Events,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type Message,
  type VoiceBasedChannel,
} from "discord.js";
import {
  entersState,
  joinVoiceChannel,
  VoiceConnectionStatus,
  type VoiceConnection,
} from "@discordjs/voice";
import { logger } from "../lib/logger";
import {
  handleNWordMessage,
  isNWordCounterEnabled,
  setNWordCounterEnabled,
  getUserNWordCount,
  getNWordLeaderboard,
  createLeaderboardEmbed,
} from "./nwordCounter";
import {
  getHelpEmbed,
  getHelpButtons,
  type HelpCategory,
} from "./helpMenu";

const COMMAND_NAMES = [
  "help",
  "status",
  "code",
  "dead",
  "undead",
  "list",
  "join",
  "leave",
  "mute",
  "unmute",
  "uptime",
  "nwordcount",
  "nwordleaderboard",
  "nwordcounter",
] as const;
type CommandName = (typeof COMMAND_NAMES)[number];
type VoiceCommand = Exclude<
  CommandName,
  | "help"
  | "status"
  | "code"
  | "dead"
  | "undead"
  | "list"
  | "uptime"
  | "nwordcount"
  | "nwordleaderboard"
  | "nwordcounter"
>;
const COMMANDS = new Set<CommandName>(COMMAND_NAMES);
const VOICE_COMMANDS = new Set<VoiceCommand>([
  "join",
  "leave",
  "mute",
  "unmute",
]);
const storedCodes = new Map<string, string>();
const deadMembersByGuild = new Map<string, Set<string>>();
const pendingDeadPlayerUnmutes = new Set<string>();
const startedAt = Date.now();
const slashCommands = COMMAND_NAMES.map((name) => {
  const command = new SlashCommandBuilder()
    .setName(name)
    .setDescription(
      name === "help"
        ? "Show all Among Us voice commands"
        : name === "status"
          ? "Show who is in your current voice channel"
          : name === "code"
            ? "Save or show the Among Us lobby code"
            : name === "dead"
              ? "Mark a player dead and server-mute them"
              : name === "undead"
                ? "Start a new round by clearing dead players"
                : name === "list"
                  ? "List every player marked dead"
                  : name === "join"
                    ? "Join your current voice channel"
                    : name === "leave"
                      ? "Leave this server's voice channel"
                    : name === "mute"
                      ? "Server-mute everyone in your current voice channel"
                      : name === "unmute"
                        ? "Remove server mutes from everyone in your current voice channel"
                        : name === "uptime"
                          ? "Show how long the bot has been online"
                          : name === "nwordcount"
                            ? "Check how many times a user has used the N-word"
                            : name === "nwordleaderboard"
                              ? "View the server N-word leaderboard"
                              : "Configure the N-word counter for this server",
    );

  if (name === "code") {
    command.addStringOption((option) =>
      option
        .setName("code")
        .setDescription("The six-letter Among Us lobby code")
        .setRequired(false),
    );
  }

  if (name === "dead") {
    command.addUserOption((option) =>
      option
        .setName("user")
        .setDescription("The player who died")
        .setRequired(true),
    );
  }

  if (name === "undead") {
    command.addUserOption((option) =>
      option
        .setName("user")
        .setDescription("Optional player to remove from the dead list")
        .setRequired(false),
    );
  }

  if (name === "nwordcount") {
    command.addUserOption((option) =>
      option
        .setName("user")
        .setDescription("Optional user to check (defaults to yourself)")
        .setRequired(false),
    );
  }

  if (name === "nwordcounter") {
    command
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption((option) =>
        option
          .setName("action")
          .setDescription("Enable, disable, or check status of the counter")
          .setRequired(true)
          .addChoices(
            { name: "enable", value: "enable" },
            { name: "disable", value: "disable" },
            { name: "status", value: "status" },
          ),
      );
  }

  return command.toJSON();
});
const activeConnections = new Map<string, VoiceConnection>();

function setWatchingStatus(client: Client, channelName: string): void {
  client.user?.setPresence({
    status: "idle",
    activities: [{ name: channelName, type: ActivityType.Watching }],
  });
}

function createUptimeEmbed(
  client: Client,
  botAvatarUrl?: string | null,
): EmbedBuilder {
  const totalSeconds = Math.floor((Date.now() - startedAt) / 1_000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days} day${days === 1 ? "" : "s"}`);
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (minutes > 0) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  parts.push(`${seconds} second${seconds === 1 ? "" : "s"}`);

  const formattedDuration = parts.join(", ");
  const startUnix = Math.floor(startedAt / 1_000);
  const memoryUsedMb = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
  const ping = client.ws.ping >= 0 ? `${Math.round(client.ws.ping)}ms` : "N/A";

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("Uptime")
    .setDescription(
      `dea has been online for **${formattedDuration}**.\n\nOnline since <t:${startUnix}:F> (<t:${startUnix}:R>)`,
    )
    .addFields(
      { name: "Ping", value: `\`${ping}\``, inline: true },
      { name: "Memory", value: `\`${memoryUsedMb} MB\``, inline: true },
      { name: "Servers", value: `\`${client.guilds.cache.size}\``, inline: true },
    )
    .setTimestamp();

  if (botAvatarUrl) {
    embed.setAuthor({ name: "dea", iconURL: botAvatarUrl });
    embed.setThumbnail(botAvatarUrl);
    embed.setFooter({ text: "dea", iconURL: botAvatarUrl });
  } else {
    embed.setAuthor({ name: "dea" });
    embed.setFooter({ text: "dea" });
  }

  return embed;
}


function normalizeCode(input: string): string | null {
  const code = input.trim().toUpperCase();
  return /^[A-Z]{6}$/.test(code) ? code : null;
}

function saveCode(guildId: string, input: string): string {
  const code = normalizeCode(input);
  if (!code) {
    return "Please provide a valid six-letter Among Us code, such as `ABCDEF`.";
  }

  storedCodes.set(guildId, code);
  return `The code is **${code}**. I’ll remember it for this server.`;
}

function showSavedCode(guildId: string): string {
  const code = storedCodes.get(guildId);
  return code
    ? `The code is **${code}**.`
    : "I do not have a code saved yet. Use `.code ABCDEF` or `/code` with a code.";
}

function getDeadMemberIds(guildId: string): Set<string> {
  let deadMemberIds = deadMembersByGuild.get(guildId);
  if (!deadMemberIds) {
    deadMemberIds = new Set<string>();
    deadMembersByGuild.set(guildId, deadMemberIds);
  }
  return deadMemberIds;
}

async function markDeadPlayer(
  client: Client,
  guild: Guild,
  memberId: string,
): Promise<string> {
  if (memberId === client.user?.id) {
    return "I cannot mark myself as dead.";
  }

  const deadMemberIds = getDeadMemberIds(guild.id);
  const wasAlreadyDead = deadMemberIds.has(memberId);
  deadMemberIds.add(memberId);
  const member = await guild.members.fetch(memberId).catch(() => null);

  if (!member) {
    return `<@${memberId}> is on the dead list. I’ll mute them if they join this server’s voice channel.`;
  }

  if (member.voice.channel) {
    try {
      await assertVoicePermissions(
        client,
        guild,
        member.voice.channel,
        true,
      );
      await member.voice.setMute(true, "Among Us dead player");
      return wasAlreadyDead
        ? `<@${memberId}> is already dead and remains server-muted.`
        : `Marked <@${memberId}> as dead and server-muted them.`;
    } catch (error) {
      logger.warn(
        { err: error, guildId: guild.id, memberId },
        "Could not server-mute dead player",
      );
      return `Added <@${memberId}> to the dead list, but I could not server-mute them. Check my Mute Members permission and role position.`;
    }
  }

  return wasAlreadyDead
    ? `<@${memberId}> is already on the dead list.`
    : `Marked <@${memberId}> as dead. They will be server-muted when they join voice.`;
}

async function unmutePlayers(
  guild: Guild,
  memberIds: readonly string[],
): Promise<{ unmuted: number; failed: number; notInVoice: number }> {
  const members = await Promise.all(
    memberIds.map(async (memberId) => {
      return (
        guild.members.cache.get(memberId) ??
        (await guild.members.fetch(memberId).catch(() => null))
      );
    }),
  );
  const membersInVoice = members.filter(
    (member): member is GuildMember => Boolean(member?.voice.channel),
  );
  const membersNeedingUnmute = membersInVoice.filter(
    (member) => member.voice.serverMute,
  );
  const results = await Promise.allSettled(
    membersNeedingUnmute.map((member) =>
      member.voice.setMute(false, "Among Us new round"),
    ),
  );

  return {
    unmuted: results.filter((result) => result.status === "fulfilled").length,
    failed: results.filter((result) => result.status === "rejected").length,
    notInVoice: members.length - membersInVoice.length,
  };
}

function formatUnmuteSummary(result: {
  unmuted: number;
  failed: number;
  notInVoice: number;
}): string {
  const details: string[] = [];
  if (result.unmuted > 0) {
    details.push(
      `server-unmuted ${result.unmuted} player${result.unmuted === 1 ? "" : "s"}`,
    );
  }
  if (result.notInVoice > 0) {
    details.push(
      `${result.notInVoice} player${result.notInVoice === 1 ? "" : "s"} not in voice`,
    );
  }
  if (result.failed > 0) {
    details.push(
      `couldn't unmute ${result.failed} player${result.failed === 1 ? "" : "s"}`,
    );
  }
  return details.length > 0 ? ` (${details.join("; ")})` : "";
}

async function clearDeadPlayers(
  guild: Guild,
  memberId?: string,
): Promise<string> {
  const deadMemberIds = getDeadMemberIds(guild.id);
  if (memberId) {
    if (!deadMemberIds.delete(memberId)) {
      return `<@${memberId}> was not on the dead list.`;
    }
    const unmuteResult = await unmutePlayers(guild, [memberId]);
    return `<@${memberId}> is no longer marked dead${formatUnmuteSummary(unmuteResult)}.`;
  }

  const idsToUnmute = [...deadMemberIds];
  const count = deadMemberIds.size;
  deadMemberIds.clear();
  if (count === 0) {
    return "New round started. The dead-player list was already empty.";
  }

  const unmuteResult = await unmutePlayers(guild, idsToUnmute);
  return `New round started. Cleared ${count} dead player${count === 1 ? "" : "s"}${formatUnmuteSummary(unmuteResult)}.`;
}

async function createDeadListEmbeds(
  guild: Guild,
  botAvatarUrl?: string | null,
): Promise<EmbedBuilder[]> {
  const deadMemberIds = deadMembersByGuild.get(guild.id);
  const ids = deadMemberIds ? [...deadMemberIds] : [];
  const members = await Promise.all(
    ids.map(async (memberId, index) => {
      const member =
        guild.members.cache.get(memberId) ??
        (await guild.members.fetch(memberId).catch(() => null));
      return { index, member, memberId };
    }),
  );

  const summaryEmbed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("Dead Players")
    .setDescription(
      ids.length > 0
        ? "Players currently marked dead are shown below."
        : "No players are currently marked dead.",
    )
    .addFields({ name: "Total dead", value: String(ids.length), inline: true });

  if (botAvatarUrl) {
    summaryEmbed.setAuthor({ name: "dea", iconURL: botAvatarUrl });
    summaryEmbed.setFooter({ text: "dea", iconURL: botAvatarUrl });
  } else {
    summaryEmbed.setAuthor({ name: "dea" });
    summaryEmbed.setFooter({ text: "dea" });
  }

  const playerEmbeds = members.map(({ index, member, memberId }) => {
    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle(`${index + 1}. ${member?.displayName ?? "Unknown player"}`)
      .setDescription(`<@${memberId}>`);

    if (!member) {
      return embed
        .addFields({
          name: "Status",
          value: "Player is no longer in this server.",
          inline: true,
        })
        .setFooter({ text: "Use /undead or .undead to clear the round." });
    }

    const avatarUrl = member.displayAvatarURL({ extension: "png", size: 128 });
    return embed
      .setThumbnail(avatarUrl)
      .addFields(
        {
          name: "Voice channel",
          value: member.voice.channel?.name ?? "Not in voice",
          inline: true,
        },
        {
          name: "Mute state",
          value: member.voice.serverMute ? "Server muted" : "Not server muted",
          inline: true,
        },
      )
      .setFooter({ text: "Move to the main VC to be server-muted again." });
  });

  return [summaryEmbed, ...playerEmbeds];
}

function splitEmbeds(
  embeds: readonly EmbedBuilder[],
  chunkSize = 10,
): EmbedBuilder[][] {
  const chunks: EmbedBuilder[][] = [];
  for (let index = 0; index < embeds.length; index += chunkSize) {
    chunks.push(embeds.slice(index, index + chunkSize));
  }
  return chunks;
}

async function enforceDeadPlayerMute(
  client: Client,
  member: GuildMember,
): Promise<void> {
  const deadMemberIds = deadMembersByGuild.get(member.guild.id);
  if (!deadMemberIds?.has(member.id) || !member.voice.channel) {
    return;
  }

  try {
    await assertVoicePermissions(
      client,
      member.guild,
      member.voice.channel,
      true,
    );
    if (!member.voice.serverMute) {
      await member.voice.setMute(true, "Among Us dead player");
    }
  } catch (error) {
    logger.warn(
      { err: error, guildId: member.guild.id, memberId: member.id },
      "Could not enforce dead player mute",
    );
  }
}

async function unmuteDeadPlayerAfterChannelMove(
  client: Client,
  member: GuildMember,
): Promise<void> {
  const deadMemberIds = deadMembersByGuild.get(member.guild.id);
  if (
    !deadMemberIds?.has(member.id) ||
    !member.voice.channel ||
    !member.voice.serverMute
  ) {
    return;
  }

  pendingDeadPlayerUnmutes.add(member.id);
  setTimeout(() => pendingDeadPlayerUnmutes.delete(member.id), 5_000);

  try {
    await assertVoicePermissions(
      client,
      member.guild,
      member.voice.channel,
      true,
    );
    await member.voice.setMute(false, "Dead player moved to another channel");
  } catch (error) {
    pendingDeadPlayerUnmutes.delete(member.id);
    logger.warn(
      { err: error, guildId: member.guild.id, memberId: member.id },
      "Could not unserver-mute dead player after channel move",
    );
  }
}

function detectAutomaticCode(content: string): string | null {
  const trimmed = content.trim();
  if (/^[A-Z]{6}$/.test(trimmed)) {
    return trimmed;
  }

  if (/\bcode\b/i.test(trimmed)) {
    return trimmed.match(/\b[A-Z]{6}\b/)?.[0] ?? null;
  }

  return null;
}

function containsCodeReference(content: string): boolean {
  return /\bcode\b/i.test(content);
}

function createVoiceStatusEmbed(
  channel: VoiceBasedChannel,
  botAvatarUrl?: string | null,
): EmbedBuilder {
  const members = [...channel.members.values()].sort((left, right) =>
    left.displayName.localeCompare(right.displayName),
  );
  const mutedCount = members.filter((member) => member.voice.serverMute).length;
  const memberList =
    members.length > 0
      ? members
          .map(
            (member, index) =>
              `${index + 1}. ${member.displayName}${member.voice.serverMute ? " — server muted" : ""}`,
          )
          .join("\n")
      : "No one is currently in this voice channel.";

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle("Voice Channel Status")
    .setDescription(`**${channel.name}**\n\n${memberList}`)
    .addFields(
      { name: "People in channel", value: String(members.length), inline: true },
      { name: "Server muted", value: String(mutedCount), inline: true },
    );

  if (botAvatarUrl) {
    embed.setAuthor({ name: "dea", iconURL: botAvatarUrl });
    embed.setFooter({ text: "dea", iconURL: botAvatarUrl });
  } else {
    embed.setAuthor({ name: "dea" });
    embed.setFooter({ text: "dea" });
  }
  return embed;
}

async function connectToVoiceChannel(
  client: Client,
  channel: VoiceBasedChannel,
): Promise<VoiceConnection> {
  if (!("guild" in channel) || !channel.guild.voiceAdapterCreator) {
    throw new Error("The command was not issued in a guild voice channel.");
  }

  const currentConnection = activeConnections.get(channel.guild.id);
  if (currentConnection?.joinConfig.channelId === channel.id) {
    setWatchingStatus(client, channel.name);
    return currentConnection;
  }

  currentConnection?.destroy();

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch (error) {
    connection.destroy();
    throw error;
  }

  activeConnections.set(channel.guild.id, connection);
  setWatchingStatus(client, channel.name);
  connection.once(VoiceConnectionStatus.Destroyed, () => {
    if (activeConnections.get(channel.guild.id) === connection) {
      activeConnections.delete(channel.guild.id);
    }
    if (activeConnections.size === 0) {
      setWatchingStatus(client, "Waiting for a voice channel");
    }
  });

  return connection;
}

function leaveVoiceChannel(client: Client, guildId: string): boolean {
  const connection = activeConnections.get(guildId);
  if (!connection) {
    if (activeConnections.size === 0) {
      setWatchingStatus(client, "Waiting for a voice channel");
    }
    return false;
  }

  activeConnections.delete(guildId);
  connection.destroy();
  if (activeConnections.size === 0) {
    setWatchingStatus(client, "Waiting for a voice channel");
  }
  return true;
}

async function assertVoicePermissions(
  client: Client,
  guild: Guild,
  channel: VoiceBasedChannel,
  needsMutePermission: boolean,
): Promise<void> {
  if (!("guild" in channel)) {
    throw new Error("The command was not issued in a guild voice channel.");
  }

  const botMember = await guild.members.fetch(client.user!.id);
  const permissions = channel.permissionsFor(botMember);
  const requiredPermissions = [
    PermissionFlagsBits.Connect,
    ...(needsMutePermission ? [PermissionFlagsBits.MuteMembers] : []),
  ];

  if (
    !permissions ||
    requiredPermissions.some((permission) => !permissions.has(permission))
  ) {
    throw new Error(
      needsMutePermission
        ? "I need Connect and Mute Members permissions in that voice channel."
        : "I need Connect permission in that voice channel.",
    );
  }
}

async function applyServerMute(
  guild: Guild,
  botUserId: string,
  channel: VoiceBasedChannel,
  shouldMute: boolean,
  deadMemberIds: ReadonlySet<string>,
): Promise<{ changed: number; failed: number; skipped: number }> {
  if (!("guild" in channel)) {
    throw new Error("This command can only be used in a server.");
  }

  const members = [...channel.members.values()].filter(
    (member) => member.id !== botUserId,
  );
  const membersNeedingChange = members.filter((member) => {
    const desiredMuteState =
      shouldMute || deadMemberIds.has(member.id);
    return member.voice.serverMute !== desiredMuteState;
  });
  const results = await Promise.allSettled(
    membersNeedingChange.map((member) =>
      member.voice.setMute(
        shouldMute || deadMemberIds.has(member.id),
        shouldMute
          ? "Among Us round mute command"
          : deadMemberIds.has(member.id)
            ? "Dead player remains muted"
            : "Among Us round unmute command",
      ),
    ),
  );

  return {
    changed: results.filter((result) => result.status === "fulfilled").length,
    failed: results.filter((result) => result.status === "rejected").length,
    skipped: members.length - membersNeedingChange.length,
  };
}

async function executeVoiceCommand(
  client: Client,
  guild: Guild,
  channel: VoiceBasedChannel,
  command: VoiceCommand,
): Promise<string> {
  await assertVoicePermissions(client, guild, channel, command !== "join");

  if (command === "join") {
    await connectToVoiceChannel(client, channel);
    return `Joined **${channel.name}**.`;
  }

  // Voice state changes do not require the bot to finish joining first. Start
  // the connection in parallel so mute/unmute can complete as soon as Discord
  // applies the member updates.
  void connectToVoiceChannel(client, channel).catch((error) => {
    logger.warn(
      { err: error, guildId: guild.id, channelId: channel.id },
      "Could not join voice while applying a mute command",
    );
  });

  const result = await applyServerMute(
    guild,
    client.user!.id,
    channel,
    command === "mute",
    deadMembersByGuild.get(guild.id) ?? new Set<string>(),
  );
  const action =
    command === "mute"
      ? "Server muted everyone"
      : "Unserver muted everyone";
  const stateNotice =
    result.changed === 0
      ? " no member state changes were needed"
      : ` ${result.changed} member${result.changed === 1 ? "" : "s"} changed`;
  const failureNotice =
    result.failed > 0
      ? ` I couldn't change ${result.failed} member${result.failed === 1 ? "" : "s"}—check my role position and permissions.`
      : "";

  return `${action} in **${channel.name}** (${stateNotice}).${failureNotice}`;
}

async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const command = interaction.commandName;
  if (!COMMANDS.has(command as CommandName)) {
    return;
  }

  if (command === "help") {
    await interaction.reply({
      embeds: [getHelpEmbed("overview", interaction.client.user?.displayAvatarURL())],
      components: [getHelpButtons("overview")],
    });
    return;
  }

  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({
      content: "These commands can only be used inside a Discord server.",
      ephemeral: true,
    });
    return;
  }

  if (command === "code") {
    const suppliedCode = interaction.options.getString("code");
    await interaction.reply({
      content: suppliedCode
        ? saveCode(interaction.guild.id, suppliedCode)
        : showSavedCode(interaction.guild.id),
    });
    return;
  }

  if (command === "dead") {
    const target = interaction.options.getUser("user", true);
    await interaction.deferReply();
    await interaction.editReply(
      await markDeadPlayer(interaction.client, interaction.guild, target.id),
    );
    return;
  }

  if (command === "undead") {
    const target = interaction.options.getUser("user");
    await interaction.reply({
      content: await clearDeadPlayers(interaction.guild, target?.id),
    });
    return;
  }

  if (command === "list") {
    const embedChunks = splitEmbeds(
      await createDeadListEmbeds(interaction.guild, interaction.client.user?.displayAvatarURL()),
    );
    await interaction.reply({ embeds: embedChunks[0] });
    for (const chunk of embedChunks.slice(1)) {
      await interaction.followUp({ embeds: chunk });
    }
    return;
  }

  if (command === "uptime") {
    const embed = createUptimeEmbed(
      interaction.client,
      interaction.client.user?.displayAvatarURL(),
    );
    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (command === "nwordcount") {
    const targetUser = interaction.options.getUser("user") ?? interaction.user;
    const count = await getUserNWordCount(interaction.guild.id, targetUser.id);
    const message =
      targetUser.id === interaction.user.id
        ? `You have used the N-word **${count}** time${count === 1 ? "" : "s"} in this server.`
        : `<@${targetUser.id}> has used the N-word **${count}** time${count === 1 ? "" : "s"} in this server.`;
    await interaction.reply({ content: message });
    return;
  }

  if (command === "nwordleaderboard") {
    const rows = await getNWordLeaderboard(interaction.guild.id, 10);
    const embed = createLeaderboardEmbed(interaction.guild.name, rows, interaction.client.user?.displayAvatarURL());
    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (command === "nwordcounter") {
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    const hasAdminPerm =
      member?.permissions.has(PermissionFlagsBits.ManageGuild) ||
      member?.permissions.has(PermissionFlagsBits.Administrator);

    if (!hasAdminPerm) {
      await interaction.reply({
        content: "You need the 'Manage Server' permission to configure the N-word counter.",
        ephemeral: true,
      });
      return;
    }

    const action = interaction.options.getString("action", true).toLowerCase();
    if (action === "enable") {
      const ok = await setNWordCounterEnabled(interaction.guild.id, true);
      await interaction.reply({
        content: ok
          ? "The N-word counter is now **enabled** for this server."
          : "Failed to update setting due to a database error.",
      });
      return;
    }

    if (action === "disable") {
      const ok = await setNWordCounterEnabled(interaction.guild.id, false);
      await interaction.reply({
        content: ok
          ? "The N-word counter is now **disabled** for this server."
          : "Failed to update setting due to a database error.",
      });
      return;
    }

    const isEnabled = await isNWordCounterEnabled(interaction.guild.id);
    await interaction.reply({
      content: `The N-word counter is currently **${isEnabled ? "enabled" : "disabled"}** in this server.`,
    });
    return;
  }

  if (command === "leave") {
    await interaction.reply(
      leaveVoiceChannel(interaction.client, interaction.guild.id)
        ? "Left the voice channel."
        : "I am not in a voice channel in this server.",
    );
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  const channel = member.voice.channel;
  if (command === "status") {
    if (!channel) {
      await interaction.reply({
        content: "Join a voice channel first so I can show who is in it.",
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({ embeds: [createVoiceStatusEmbed(channel, interaction.client.user?.displayAvatarURL())] });
    return;
  }

  if (!VOICE_COMMANDS.has(command as VoiceCommand)) {
    return;
  }

  if (!channel) {
    await interaction.reply({
      content:
        "Join the voice channel you want to control, then use `/join`, `/mute`, or `/unmute`.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  try {
    const typedCommand = command as VoiceCommand;
    await interaction.editReply(
      await executeVoiceCommand(
        interaction.client,
        interaction.guild,
        channel,
        typedCommand,
      ),
    );
  } catch (error) {
    logger.warn(
      { err: error, guildId: interaction.guildId, command },
      "Discord voice command failed",
    );
    await interaction.editReply(
      error instanceof Error
        ? error.message
        : "I couldn't complete that voice command.",
    );
  }
}

const PREFIX_ALIASES: Record<string, CommandName> = {
  ncount: "nwordcount",
  nleaderboard: "nwordleaderboard",
  nlb: "nwordleaderboard",
  ncounter: "nwordcounter",
};

function getPrefixCommand(content: string): CommandName | null {
  const command = content.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!command.startsWith(".") || command.length <= 1) {
    return null;
  }

  const name = command.slice(1);
  if (COMMANDS.has(name as CommandName)) {
    return name as CommandName;
  }
  if (name in PREFIX_ALIASES) {
    return PREFIX_ALIASES[name]!;
  }
  return null;
}

async function handlePrefixCommand(message: Message): Promise<void> {
  if (message.author.bot || message.webhookId || message.system) {
    return;
  }

  if (message.client.user && message.author.id === message.client.user.id) {
    return;
  }

  if (message.guild) {
    try {
      const detected = await handleNWordMessage(message);
      if (detected) {
        return;
      }
    } catch (error) {
      logger.error(
        { err: error, guildId: message.guild.id, messageId: message.id },
        "Error handling N-word counter detection in message",
      );
    }
  }

  const command = getPrefixCommand(message.content);
  if (!command) {
    if (message.guild) {
      const automaticCode = detectAutomaticCode(message.content);
      if (automaticCode) {
        await message.reply(saveCode(message.guild.id, automaticCode));
      } else if (containsCodeReference(message.content)) {
        await message.reply(showSavedCode(message.guild.id));
      }
    }
    return;
  }

  if (command === "help") {
    await message.reply({
      embeds: [getHelpEmbed("overview", message.client.user?.displayAvatarURL())],
      components: [getHelpButtons("overview")],
    });
    return;
  }

  if (!message.guild) {
    await message.reply("These commands can only be used inside a Discord server.");
    return;
  }

  if (command === "nwordcount") {
    const targetUser = message.mentions.users.first() ?? message.author;
    const count = await getUserNWordCount(message.guild.id, targetUser.id);
    const response =
      targetUser.id === message.author.id
        ? `You have used the N-word **${count}** time${count === 1 ? "" : "s"} in this server.`
        : `<@${targetUser.id}> has used the N-word **${count}** time${count === 1 ? "" : "s"} in this server.`;
    await message.reply(response);
    return;
  }

  if (command === "nwordleaderboard") {
    const rows = await getNWordLeaderboard(message.guild.id, 10);
    const embed = createLeaderboardEmbed(message.guild.name, rows, message.client.user?.displayAvatarURL());
    await message.reply({ embeds: [embed] });
    return;
  }

  if (command === "nwordcounter") {
    const member =
      message.member ??
      (await message.guild.members.fetch(message.author.id).catch(() => null));
    const hasAdminPerm =
      member?.permissions.has(PermissionFlagsBits.ManageGuild) ||
      member?.permissions.has(PermissionFlagsBits.Administrator);

    if (!hasAdminPerm) {
      await message.reply(
        "You need the 'Manage Server' permission to configure the N-word counter.",
      );
      return;
    }

    const args = message.content.trim().split(/\s+/).slice(1);
    const subAction = (args[0] ?? "").toLowerCase();

    if (subAction === "enable" || subAction === "on") {
      const ok = await setNWordCounterEnabled(message.guild.id, true);
      await message.reply(
        ok
          ? "The N-word counter is now **enabled** for this server."
          : "Failed to update setting due to a database error.",
      );
      return;
    }

    if (subAction === "disable" || subAction === "off") {
      const ok = await setNWordCounterEnabled(message.guild.id, false);
      await message.reply(
        ok
          ? "The N-word counter is now **disabled** for this server."
          : "Failed to update setting due to a database error.",
      );
      return;
    }

    const isEnabled = await isNWordCounterEnabled(message.guild.id);
    await message.reply(
      `The N-word counter is currently **${isEnabled ? "enabled" : "disabled"}** in this server. Use \`.nwordcounter enable\` or \`.nwordcounter disable\` to change it.`,
    );
    return;
  }

  if (command === "code") {
    const suppliedCode = message.content.trim().split(/\s+/).slice(1).join("");
    await message.reply(
      suppliedCode
        ? saveCode(message.guild.id, suppliedCode)
        : showSavedCode(message.guild.id),
    );
    return;
  }

  if (command === "dead") {
    const target = message.mentions.members?.first();
    if (!target) {
      await message.reply("Use `.dead @player` to mark someone dead.");
      return;
    }

    await message.reply(
      await markDeadPlayer(message.client, message.guild, target.id),
    );
    return;
  }

  if (command === "undead") {
    const target = message.mentions.members?.first();
    await message.reply(await clearDeadPlayers(message.guild, target?.id));
    return;
  }

  if (command === "list") {
    const embedChunks = splitEmbeds(await createDeadListEmbeds(message.guild, message.client.user?.displayAvatarURL()));
    await message.reply({ embeds: embedChunks[0] });
    for (const chunk of embedChunks.slice(1)) {
      await message.reply({ embeds: chunk });
    }
    return;
  }

  if (command === "uptime") {
    const embed = createUptimeEmbed(
      message.client,
      message.client.user?.displayAvatarURL(),
    );
    await message.reply({ embeds: [embed] });
    return;
  }

  if (command === "leave") {
    await message.reply(
      leaveVoiceChannel(message.client, message.guild.id)
        ? "Left the voice channel."
        : "I am not in a voice channel in this server.",
    );
    return;
  }

  const channel = message.member?.voice.channel;
  if (command === "status") {
    if (!channel) {
      await message.reply("Join a voice channel first so I can show who is in it.");
      return;
    }

    await message.reply({ embeds: [createVoiceStatusEmbed(channel, message.client.user?.displayAvatarURL())] });
    return;
  }

  if (!channel) {
    await message.reply(
      "Join the voice channel you want to control, then use `.join`, `.mute`, or `.unmute`.",
    );
    return;
  }

  try {
    await message.reply(
      await executeVoiceCommand(
        message.client,
        message.guild,
        channel,
        command as VoiceCommand,
      ),
    );
  } catch (error) {
    logger.warn(
      { err: error, guildId: message.guild.id, command },
      "Discord prefix voice command failed",
    );
    await message.reply(
      error instanceof Error
        ? error.message
        : "I couldn't complete that voice command.",
    );
  }
}

export function startDiscordBot(): Client | null {
  const token = process.env["DISCORD_BOT_TOKEN"];
  if (!token) {
    logger.warn(
      "DISCORD_BOT_TOKEN is not configured; Discord bot will not start.",
    );
    return null;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once(Events.ClientReady, (readyClient) => {
    setWatchingStatus(readyClient, "Waiting for a voice channel");
    logger.info(
      {
        userTag: readyClient.user.tag,
        guildCount: readyClient.guilds.cache.size,
      },
      "Discord bot ready",
    );
    void Promise.all(
      readyClient.guilds.cache.map(async (guild) => {
        try {
          await guild.commands.set(slashCommands);
          logger.info({ guildId: guild.id }, "Discord slash commands registered");
        } catch (error) {
          logger.error(
            { err: error, guildId: guild.id },
            "Discord slash command registration failed",
          );
        }
      }),
    );
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        await handleSlashCommand(interaction);
      } else if (interaction.isButton()) {
        if (interaction.customId.startsWith("help_")) {
          const category = interaction.customId.replace(
            "help_",
            "",
          ) as HelpCategory;
          await interaction.update({
            embeds: [getHelpEmbed(category, interaction.client.user?.displayAvatarURL())],
            components: [getHelpButtons(category)],
          });
        }
      }
    } catch (error) {
      logger.error({ err: error }, "Error handling interaction");
    }
  });
  client.on(Events.MessageCreate, (message) => {
    void handlePrefixCommand(message);
  });
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    if (oldState.member?.id === client.user?.id && !newState.channelId) {
      activeConnections.delete(oldState.guild.id);
      if (activeConnections.size === 0) {
        setWatchingStatus(client, "Waiting for a voice channel");
      }
    }

    if (!newState.channelId || !newState.member) {
      return;
    }

    const mainVoiceChannelId = activeConnections.get(
      newState.guild.id,
    )?.joinConfig.channelId;
    const joinedVoice = !oldState.channelId;
    const movedToAnotherChannel =
      Boolean(oldState.channelId) &&
      oldState.channelId !== newState.channelId;
    const manuallyUnmuted = oldState.serverMute && !newState.serverMute;
    if (movedToAnotherChannel) {
      if (newState.channelId === mainVoiceChannelId) {
        void enforceDeadPlayerMute(client, newState.member);
      } else {
        void unmuteDeadPlayerAfterChannelMove(client, newState.member);
      }
    } else if (
      (joinedVoice &&
        (!mainVoiceChannelId ||
          newState.channelId === mainVoiceChannelId)) ||
      (manuallyUnmuted && !pendingDeadPlayerUnmutes.has(newState.member.id))
    ) {
      void enforceDeadPlayerMute(client, newState.member);
    } else if (
      joinedVoice &&
      mainVoiceChannelId &&
      newState.channelId !== mainVoiceChannelId
    ) {
      void unmuteDeadPlayerAfterChannelMove(client, newState.member);
    }
  });
  client.on(Events.Error, (error) => {
    logger.error({ err: error }, "Discord client error");
  });

  void client.login(token).catch((error: unknown) => {
    logger.error({ err: error }, "Discord bot login failed");
  });

  const shutdown = () => {
    for (const connection of activeConnections.values()) {
      connection.destroy();
    }
    activeConnections.clear();
    client.destroy();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  return client;
}
