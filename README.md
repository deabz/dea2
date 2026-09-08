# Among Us Discord Bot

A Discord bot for coordinating Among Us games, including lobby-code sharing,
voice-channel muting, and dead-player tracking.

## Deploying to Render

Create a new **Web Service** from this repository. Render will detect
`render.yaml`; alternatively, use these settings:

- Build command: `npm ci --include=dev && npm run build`
- Start command: `npm --workspace @workspace/api-server run start`
- Health-check path: `/api/healthz`

Set these environment variables in Render:

- `DISCORD_BOT_TOKEN` (required): your Discord application's bot token.
- `NODE_ENV=production`
- `LOG_LEVEL=info` (optional)

Render supplies `PORT` automatically. Do not set it yourself.

For local development, install Node.js 22+ and npm, then run:

```sh
npm install
PORT=3000 DISCORD_BOT_TOKEN=your-token npm --workspace @workspace/api-server run dev
```

On PowerShell, set the variables first with `$env:PORT = '3000'` and
`$env:DISCORD_BOT_TOKEN = 'your-token'`.
