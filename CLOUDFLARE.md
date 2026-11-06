# Hosting Glide! on Cloudflare

One Cloudflare Worker does everything:

- **Serves the game** (the built `dist/` folder) at `https://glide.<your-subdomain>.workers.dev`. Static files are free and unmetered.
- **Runs the online rooms.** Each room code is one Durable Object. Every player holds a single WebSocket to it and it relays messages between them, the same job the host's browser did over PeerJS. Because it's a plain WebSocket to Cloudflare's edge, there's no WebRTC, no NAT punching and no TURN relay to fail: if a player can load a web page, they can play (home Wi-Fi, phone data, school/office networks that block peer to peer).

A third piece, the **Lobby** Durable Object, keeps the list of public rooms for the in-game room browser (`GET /rooms`). Rooms report their player count to it when it changes and every 2 minutes while open; a room it hasn't heard from in 5 minutes drops off. Private rooms are never listed.

The game knows which mode to use from how it was built:

| Build | Online play goes through |
|---|---|
| `npm run build` (old default) | PeerJS public servers, as before |
| `npm run build:cloudflare` / `npm run deploy` / any `wrangler deploy` | the relay on the same Worker |
| `npm run build:itch` | your Cloudflare relay, from an itch.io upload |

You can also override it on any build with the page URL: `?relay=wss://glide.you.workers.dev` or `?relay=peerjs`.

## What it costs

Start on the **Workers Free plan ($0)**. On the free plan nothing is ever billed: if a daily limit is hit, new room traffic fails until 00:00 UTC.

Rough numbers for this game (each player sends ~20 updates a second, the host ~15 more for the AI birds; Cloudflare counts 20 incoming WebSocket messages as 1 request and doesn't charge for outgoing ones or keep-alive pings):

| | Free plan (per day) | Fits roughly |
|---|---|---|
| Durable Object requests | 100,000 | ~10 h of 2-player play, or ~6 h of 4-player play, per day |
| Durable Object duration | 13,000 GB-s | ~28 hours of open rooms per day |
| Static files (the game) | unlimited | as many players as you like |

The room browser adds very little: one request every 4 seconds per player looking at the list, and one every 2 minutes per open public room.

An idle lobby costs nothing: the server uses the Hibernation API and Cloudflare answers keep-alive pings itself.

If it gets popular, the **Workers Paid plan is $5/month** and includes 1 million requests (~55-60 hours of 4-player play) and 400,000 GB-s (~870 room-hours). Past that it's $0.15 per million requests, which works out to about **a quarter of a cent per hour of a 4-player match**. Prices: https://developers.cloudflare.com/durable-objects/platform/pricing/

No TURN service is needed, so there's no bandwidth bill.

## One-time setup (about 10 minutes)

1. **Make a Cloudflare account** at https://dash.cloudflare.com/sign-up (free, no card needed for the Free plan).
2. **Pick your workers.dev subdomain:** in the dashboard open **Workers & Pages**. The first visit asks you to choose a subdomain (e.g. `greg` gives `glide.greg.workers.dev`).
3. **Install and log in** on your computer, in the repo folder:
   ```sh
   npm install
   npx wrangler login
   ```
   A browser tab opens; press **Allow**. (No API token needed for deploying from your own machine.)
4. **Deploy:**
   ```sh
   npm run deploy
   ```
   It builds the game and uploads the Worker. At the end it prints the address, e.g. `https://glide.greg.workers.dev`. Open it, pick **Online**, host a room and send the invite link. That's it.

Every later update is just `npm run deploy` again.

## Keeping the itch.io page too (optional)

After the first deploy, put your Worker address in `.env.itch`:

```
VITE_RELAY=wss://glide.greg.workers.dev
```

then `npm run build:itch` and upload `dist/index.html` to itch as before. Players on itch and on workers.dev use the same rooms, so they can play together.

## Try it locally first (optional)

```sh
npm run cf:dev
```

opens the Worker on http://localhost:8787 with a local copy of the rooms. Open it in two browser tabs, host in one, join in the other.

## Optional extras

- **Your own domain** (e.g. `glide.example.com`): if the domain is on Cloudflare, add `routes = [{ pattern = "glide.example.com", custom_domain = true }]` to `wrangler.toml` and redeploy.
- **Auto-deploy from GitHub**: in the dashboard, **Workers & Pages > glide > Settings > Build**, connect the `ElGrorg/glide` repo with deploy command `npx wrangler deploy` (the build command can stay empty or `npm run build`: `wrangler.toml` always runs `npm run build:cloudflare` before deploying). Then every merge to main redeploys.
- **Usage**: **Workers & Pages > glide > Metrics** shows requests and errors; **Durable Objects** shows room usage against the free limits.
