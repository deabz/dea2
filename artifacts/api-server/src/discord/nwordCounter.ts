import { EmbedBuilder, type Message } from "discord.js";
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";

const NWORD_REGEX =
  /(?<=^|[^a-zA-Z0-9])n+[i1!l|]+g{2,}(?:[e3]rs?|[a4]s?|[a4]h[s]?|[a4]z|uhs?)(?=[^a-zA-Z0-9]|$)/gi;

const processedMessageIds = new Set<string>();
const MAX_PROCESSED_CACHE = 5000;

function markMessageProcessed(messageId: string): void {
  processedMessageIds.add(messageId);
  if (processedMessageIds.size > MAX_PROCESSED_CACHE) {
    const firstKey = processedMessageIds.keys().next().value;
    if (firstKey) {
      processedMessageIds.delete(firstKey);
    }
  }
}

function cleanText(text: string): string {
  return text.replace(/[\u200B-\u200D\uFEFF]/g, "").normalize("NFKD");
}

export function countNWordOccurrences(text: string): number {
  if (!text) return 0;
  const cleaned = cleanText(text);
  const matches = cleaned.match(NWORD_REGEX);
  return matches ? matches.length : 0;
}

const COUNTER_REACTIONS: readonly ((userId: string, count: number) => string)[] = [
  (userId, count) =>
    `<@${userId}> Caught in 4K. Your N-word count is now **${count}**.`,
  (userId, count) =>
    `<@${userId}> You've been spotted. Total N-word count: **${count}**.`,
  (userId, count) =>
    `Did you really just say that, <@${userId}>? Your N-word count is now **${count}**.`,
  (userId, count) =>
    `<@${userId}> Watch your language. Your N-word count is now **${count}**.`,
  (userId, count) =>
    `<@${userId}> Added to your record. Total N-word count: **${count}**.`,
  (userId, count) =>
    `<@${userId}> Caught red-handed. Your N-word count is now **${count}**.`,
  (userId, count) =>
    `<@${userId}> That was recorded. Total N-word count: **${count}**.`,
  (userId, count) =>
    `<@${userId}> The counter has spoken. You're now at **${count}**.`,
  (userId, count) =>
    `<@${userId}> Logged. Your N-word count is now **${count}**.`,
  (userId, count) =>
    `<@${userId}> Another one on your record. Total count: **${count}**.`,
  (userId, count) =>
    `<@${userId}> You thought you could slip that in? Current count: **${count}**.`,
  (userId, count) =>
    `<@${userId}> Detected. Your N-word count has increased to **${count}**.`,
];

export function formatCounterResponse(userId: string, count: number): string {
  const reactionFn =
    COUNTER_REACTIONS[Math.floor(Math.random() * COUNTER_REACTIONS.length)];
  return reactionFn(userId, count);
}

const guildConfigCache = new Map<string, boolean>();

export async function isNWordCounterEnabled(guildId: string): Promise<boolean> {
  const cached = guildConfigCache.get(guildId);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const config = await prisma.guildConfig.findUnique({
      where: { guildId },
    });
    const enabled = config ? config.nwordEnabled : true;
    guildConfigCache.set(guildId, enabled);
    return enabled;
  } catch (error) {
    logger.warn({ err: error, guildId }, "Failed to fetch guild config, defaulting to enabled");
    return true;
  }
}

export async function setNWordCounterEnabled(
  guildId: string,
  enabled: boolean,
): Promise<boolean> {
  try {
    await prisma.guildConfig.upsert({
      where: { guildId },
      create: {
        guildId,
        nwordEnabled: enabled,
      },
      update: {
        nwordEnabled: enabled,
      },
    });
    guildConfigCache.set(guildId, enabled);
    return true;
  } catch (error) {
    logger.error({ err: error, guildId }, "Failed to update guild config in database");
    return false;
  }
}

export async function getUserNWordCount(
  guildId: string,
  userId: string,
): Promise<number> {
  try {
    const record = await prisma.nWordCount.findUnique({
      where: {
        guildId_userId: {
          guildId,
          userId,
        },
      },
    });
    return record?.count ?? 0;
  } catch (error) {
    logger.warn({ err: error, guildId, userId }, "Failed to fetch user N-word count");
    return 0;
  }
}

export async function getNWordLeaderboard(
  guildId: string,
  limit = 10,
): Promise<{ userId: string; count: number }[]> {
  try {
    const records = await prisma.nWordCount.findMany({
      where: {
        guildId,
        count: { gt: 0 },
      },
      orderBy: {
        count: "desc",
      },
      take: limit,
      select: {
        userId: true,
        count: true,
      },
    });
    return records;
  } catch (error) {
    logger.warn({ err: error, guildId }, "Failed to fetch N-word leaderboard");
    return [];
  }
}

export function createLeaderboardEmbed(
  guildName: string,
  rows: readonly { userId: string; count: number }[],
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`N-Word Leaderboard — ${guildName}`)
    .setTimestamp();

  if (rows.length === 0) {
    embed.setDescription("No N-word detections have been recorded in this server yet.");
  } else {
    const medals = ["🥇", "🥈", "🥉"];
    const lines = rows.map((row, index) => {
      const medal = medals[index];
      const prefix = medal ?? `**${index + 1}.**`;
      return `${prefix} <@${row.userId}> — **${row.count}** time${row.count === 1 ? "" : "s"}`;
    });
    embed.setDescription(lines.join("\n"));
  }

  embed.setFooter({ text: "Dea Counter System" });
  return embed;
}

export async function handleNWordMessage(message: Message): Promise<boolean> {
  if (!message.guild || !message.channel) {
    return false;
  }

  if (message.author.bot || message.webhookId || message.system) {
    return false;
  }

  if (message.client.user && message.author.id === message.client.user.id) {
    return false;
  }

  if (processedMessageIds.has(message.id)) {
    return false;
  }

  const occurrences = countNWordOccurrences(message.content);
  if (occurrences <= 0) {
    return false;
  }

  const isEnabled = await isNWordCounterEnabled(message.guild.id);
  if (!isEnabled) {
    return false;
  }

  markMessageProcessed(message.id);

  try {
    const existing = await prisma.processedMessage.findUnique({
      where: { messageId: message.id },
    });
    if (existing) {
      return false;
    }

    const [_, userCount] = await prisma.$transaction([
      prisma.processedMessage.create({
        data: {
          messageId: message.id,
          guildId: message.guild.id,
        },
      }),
      prisma.nWordCount.upsert({
        where: {
          guildId_userId: {
            guildId: message.guild.id,
            userId: message.author.id,
          },
        },
        create: {
          guildId: message.guild.id,
          userId: message.author.id,
          count: occurrences,
        },
        update: {
          count: {
            increment: occurrences,
          },
        },
      }),
    ]);

    const replyText = formatCounterResponse(message.author.id, userCount.count);
    await message.reply({
      content: replyText,
      allowedMentions: { repliedUser: true },
    });
    return true;
  } catch (error) {
    logger.error(
      { err: error, guildId: message.guild.id, messageId: message.id },
      "Error processing N-word message",
    );
    return false;
  }
}
