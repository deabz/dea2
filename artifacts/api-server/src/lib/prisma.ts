import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger";

function resolveDatabaseUrl(): string {
  if (process.env["DATABASE_URL"]) {
    return process.env["DATABASE_URL"];
  }

  const cwd = process.cwd();
  let prismaDir = path.resolve(cwd, "prisma");
  if (!fs.existsSync(prismaDir)) {
    const nested = path.resolve(cwd, "artifacts/api-server/prisma");
    if (fs.existsSync(nested)) {
      prismaDir = nested;
    }
  }

  fs.mkdirSync(prismaDir, { recursive: true });
  const dbFile = path.resolve(prismaDir, "dev.db");
  const normalized = dbFile.split(path.sep).join("/");
  return `file:${normalized}`;
}

const dbUrl = resolveDatabaseUrl();
process.env["DATABASE_URL"] = dbUrl;

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});

export async function initDatabase(): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "GuildConfig" (
        "guildId" TEXT NOT NULL PRIMARY KEY,
        "nwordEnabled" BOOLEAN NOT NULL DEFAULT 1,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "NWordCount" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "guildId" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "count" INTEGER NOT NULL DEFAULT 0,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "NWordCount_guildId_userId_key" ON "NWordCount"("guildId", "userId");
    `);

    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "NWordCount_guildId_count_idx" ON "NWordCount"("guildId", "count" DESC);
    `);

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "ProcessedMessage" (
        "messageId" TEXT NOT NULL PRIMARY KEY,
        "guildId" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    logger.info("Database initialized successfully");
  } catch (error) {
    logger.error({ err: error }, "Failed to initialize database tables");
  }
}
