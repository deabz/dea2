# Among Us Discord Voice Mute Bot

Discord bot that joins a server voice channel and toggles server mutes for the players in it with slash commands or matching dot-prefix commands.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required secret: `DISCORD_BOT_TOKEN` — Discord bot token, stored through Replit Secrets

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/discord/bot.ts` — Discord client, voice connection, command handling, and server mute behavior
- `artifacts/api-server/src/index.ts` — starts the HTTP health server and Discord bot

## Architecture decisions

- Commands only operate on the voice channel of the member who used them.
- The bot reconnects to the requested channel when a command is issued from a different voice channel.
- The bot itself is excluded from bulk mute/unmute operations.

## Product

Members can use `/join` or `.join` to bring the bot into their current voice channel, `/status` or `.status` to see everyone in that channel and their server-mute state, `/code` or `.code` to save or show the six-letter Among Us lobby code, `/dead @player` or `.dead @player` to mark a player dead and keep them server-muted in their current voice channel, `/list` or `.list` to show every dead player, `/undead` or `.undead` to clear the list and server-unmute dead players for a new round, `/mute` or `.mute` to server-mute everyone currently in their voice channel, and `/unmute` or `.unmute` to restore mutes for living players while keeping dead players muted. Moving a dead-listed player to another voice channel automatically server-unmutes them. A standalone uppercase six-letter code is detected and saved automatically. `/help` and `.help` show a formatted command guide.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- The Discord application must have Server Members and Voice States intents enabled.
- The bot needs Connect, Mute Members, and Send Messages permissions, and its highest role must be above the members it needs to mute.
- Dead-player tracking is held per server while the bot is running; use `.undead` or `/undead` at the start of each new round.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
