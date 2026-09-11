import { PrismaClient } from "@prisma/client";
import path from "node:path";
import { logger } from "./logger";

if (!process.env["DATABASE_URL"]) {
  const dbPath = path.resolve(process.cwd(), "artifacts/api-server/prisma/dev.db");
  process.env["DATABASE_URL"] = `file:${dbPath.replace(/\\/g, "/")}`;
}

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
