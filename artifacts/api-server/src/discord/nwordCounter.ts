import fs from "node:fs";
import path from "node:path";
import { EmbedBuilder, type Message } from "discord.js";
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";

const sep = "[\\s._\\-*~/\\\\]*";
const N = "[nñ]";
const I = "[i1!|le3]";
const G = "[g9q6]";
const A = "[a4@]";
const E = "[e3]";
const O = "[o0]";
const R = "[r]";
const GG = `(?:${G}+${sep}${G}+|${G}{2,})`;

const NWORD_REGEX = new RegExp(
  "(?<=^|[^a-zA-Z0-9])(?:" +
    // Standard double-g (nigga, nigger, n199a, n i g g a, nigg, niggs, etc.)
    `${N}+${sep}${I}+${sep}${GG}${sep}(?:${E}+${sep}${R}+s?|${A}+(?:${sep}[szh4]+)*|[u]+${sep}[rh]+s?|${A}+${sep}[z]+|${E}+${sep}[z]+|${I}+${sep}t+s?|s(?=[^a-zA-Z0-9]|$)|(?=[^a-zA-Z0-9]|$))` +
    "|" +
    // Single-g (niga, nigar, negar, etc.)
    `${N}+${sep}${I}+${sep}${G}+${sep}(?:${A}+(?:${sep}[szh4]+)*|${E}+${sep}${R}+s?|${A}+${sep}${R}+s?)` +
    "|" +
    // Negro variations (negro, negros, negroes, negroid, negrito, negrita, negress, negr0)
    `${N}+${sep}${E}+${sep}${G}+${sep}${R}+${sep}(?:${O}+(?:${sep}e?s)?|${O}+${sep}i+d+|i+${sep}t+${sep}[oa]+|e+${sep}s+${sep}s+)` +
    "|" +
    // Nga variations (nga, ngas, ngah, ngaz, ng4, ngga, n g a, etc.)
    `${N}+${sep}${G}+${sep}${A}+(?:${sep}[szh4]+)*` +
    "|" +
    // Nignog, nig nog, nig-nog
    `${N}+${sep}${I}+${sep}${G}+${sep}${N}+${sep}${O}+${sep}${G}+` +
    "|" +
    // Niglet, niglets
    `${N}+${sep}${I}+${sep}${G}+${sep}l+${sep}${E}+${sep}t+s?` +
    ")(?=[^a-zA-Z0-9]|$)",
  "gi",
);

export interface GuildCounterData {
  enabled?: boolean;
  counts: Record<string, number>;
}

export interface NWordStoreData {
  guilds: Record<string, GuildCounterData>;
  processedMessageIds: string[];
}

function getStorageFilePath(): string {
  if (process.env["NWORD_DATA_FILE"]) {
    return path.resolve(process.env["NWORD_DATA_FILE"]);
  }

  const cwd = process.cwd();
  let baseDir: string;
  if (fs.existsSync(path.resolve(cwd, "artifacts/api-server"))) {
    baseDir = path.resolve(cwd, "artifacts/api-server/data");
  } else if (path.basename(cwd) === "api-server") {
    baseDir = path.resolve(cwd, "data");
  } else {
    baseDir = path.resolve(cwd, "data");
  }

  fs.mkdirSync(baseDir, { recursive: true });
  return path.resolve(baseDir, "nword_counts.json");
}

let fileStore: NWordStoreData = { guilds: {}, processedMessageIds: [] };

function loadStoreFromFile(): NWordStoreData {
  const filePath = getStorageFilePath();
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<NWordStoreData>;
      return {
        guilds: parsed.guilds ?? {},
        processedMessageIds: Array.isArray(parsed.processedMessageIds)
          ? parsed.processedMessageIds
          : [],
      };
    }
  } catch (error) {
    logger.error({ err: error, filePath }, "Failed to read N-word counts file");
  }
  return { guilds: {}, processedMessageIds: [] };
}

function saveStoreToFile(): void {
  const filePath = getStorageFilePath();
  const tempPath = `${filePath}.tmp`;
  try {
    if (fileStore.processedMessageIds.length > 2000) {
      fileStore.processedMessageIds = fileStore.processedMessageIds.slice(-2000);
    }
    const content = JSON.stringify(fileStore, null, 2);
    fs.writeFileSync(tempPath, content, "utf-8");
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    logger.error({ err: error, filePath }, "Failed to write N-word counts file");
  }
}

fileStore = loadStoreFromFile();
if (!fs.existsSync(getStorageFilePath())) {
  saveStoreToFile();
}

async function syncFromDatabase(): Promise<void> {
  try {
    const records = await prisma.nWordCount.findMany();
    let changed = false;
    for (const record of records) {
      if (!fileStore.guilds[record.guildId]) {
        fileStore.guilds[record.guildId] = { counts: {} };
      }
      const existing = fileStore.guilds[record.guildId].counts[record.userId] ?? 0;
      if (record.count > existing) {
        fileStore.guilds[record.guildId].counts[record.userId] = record.count;
        changed = true;
      }
    }
    if (changed) {
      saveStoreToFile();
      logger.info("Synchronized existing database counts into JSON counts file");
    }
  } catch {
    // Database may be uninitialized or unavailable; ignore
  }
}
void syncFromDatabase();

const processedMessageIds = new Set<string>();
const MAX_PROCESSED_CACHE = 5000;

function markMessageProcessed(messageId: string): void {
  processedMessageIds.add(messageId);
  if (!fileStore.processedMessageIds.includes(messageId)) {
    fileStore.processedMessageIds.push(messageId);
  }
  if (processedMessageIds.size > MAX_PROCESSED_CACHE) {
    const firstKey = processedMessageIds.keys().next().value;
    if (firstKey) {
      processedMessageIds.delete(firstKey);
    }
  }
}

function cleanText(text: string): string {
  return text
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
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
  if (fileStore.guilds[guildId]?.enabled !== undefined) {
    return fileStore.guilds[guildId].enabled!;
  }
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
    if (!fileStore.guilds[guildId]) {
      fileStore.guilds[guildId] = { counts: {} };
    }
    fileStore.guilds[guildId].enabled = enabled;
    saveStoreToFile();
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
  if (!fileStore.guilds[guildId]) {
    fileStore.guilds[guildId] = { counts: {} };
  }
  fileStore.guilds[guildId].enabled = enabled;
  guildConfigCache.set(guildId, enabled);
  saveStoreToFile();

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
  } catch (error) {
    logger.warn({ err: error, guildId }, "Failed to update guild config in database");
  }
  return true;
}

export async function getUserNWordCount(
  guildId: string,
  userId: string,
): Promise<number> {
  const fileCount = fileStore.guilds[guildId]?.counts[userId];
  if (fileCount !== undefined) {
    return fileCount;
  }

  try {
    const record = await prisma.nWordCount.findUnique({
      where: {
        guildId_userId: {
          guildId,
          userId,
        },
      },
    });
    const count = record?.count ?? 0;
    if (count > 0) {
      if (!fileStore.guilds[guildId]) {
        fileStore.guilds[guildId] = { counts: {} };
      }
      fileStore.guilds[guildId].counts[userId] = count;
      saveStoreToFile();
    }
    return count;
  } catch (error) {
    logger.warn({ err: error, guildId, userId }, "Failed to fetch user N-word count");
    return 0;
  }
}

export async function getNWordLeaderboard(
  guildId: string,
  limit = 10,
): Promise<{ userId: string; count: number }[]> {
  const guildCounts = fileStore.guilds[guildId]?.counts ?? {};
  const fileRows = Object.entries(guildCounts)
    .filter(([_, count]) => count > 0)
    .map(([userId, count]) => ({ userId, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);

  if (fileRows.length > 0) {
    return fileRows;
  }

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
    for (const row of records) {
      if (!fileStore.guilds[guildId]) {
        fileStore.guilds[guildId] = { counts: {} };
      }
      fileStore.guilds[guildId].counts[row.userId] = row.count;
    }
    if (records.length > 0) {
      saveStoreToFile();
    }
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
    const lines = rows.map((row, index) => {
      return `**${index + 1}.** <@${row.userId}> — **${row.count}** time${row.count === 1 ? "" : "s"}`;
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

  if (processedMessageIds.has(message.id) || fileStore.processedMessageIds.includes(message.id)) {
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

  if (!fileStore.guilds[message.guild.id]) {
    fileStore.guilds[message.guild.id] = { counts: {} };
  }
  const currentCount = fileStore.guilds[message.guild.id].counts[message.author.id] ?? 0;
  const newCount = currentCount + occurrences;
  fileStore.guilds[message.guild.id].counts[message.author.id] = newCount;
  saveStoreToFile();

  try {
    await prisma.$transaction([
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
  } catch (error) {
    logger.warn(
      { err: error, guildId: message.guild.id, messageId: message.id },
      "Database transaction failed; persisted to JSON file store instead",
    );
  }

  const replyText = formatCounterResponse(message.author.id, newCount);
  await message.reply({
    content: replyText,
    allowedMentions: { repliedUser: true },
  });
  return true;
}
