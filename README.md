# Movie Proxy

TV-friendly proxy UI for the source movie site (`https://176.97.124.32`). Node.js + Express, no build step.

## What it does

- **Basic auth** on every page (browser remembers it; a cookie is also set so the TV isn't re-prompted).
- **Front page** mirrors the source: "Populiaru dabar", "Naujausi filmai" and "Naujausi serialai" as separate sections.
- **Search bar** (proxies the source's WordPress search).
- **Browse pages** `/filmai` and `/serialai` with pagination.
- **Detail pages** show poster, original title, year, IMDb, runtime, language, genres, description and cast — parsed live from the source.
- **Movies** get a row of source/server buttons; **series** are auto-detected and get an episode list, each with its own server buttons. Order: **YouTube trailer first, then DOOD and STREAMT**, then the rest in source order.
- **Clean playback**: picking a server resolves the real video player URL server-side and embeds the trusted player domain directly — the source's popup-ad wrapper (`p2.php`) is skipped, and the browser never has to connect to the source IP (whose TLS cert many TV browsers reject). Video streams straight from the player CDN to the TV, not through this server. If extraction fails, it falls back to the wrapper automatically.
- **Watched tracking (cross-device)**: opening a real stream provider automatically marks that title as watched (series also record the specific episode; trailers don't count). Watched items get a ✓ badge on every card/search result, plus per-episode ticks on series. State is stored **server-side** in `data/watched.json`, so all devices that use the same server share it — no manual marking, no per-device state. Override the path with the `WATCHED_FILE` env var.
- **TV remote navigation**: arrow keys move focus spatially with a big yellow focus ring; the remote's Back button goes back. Works with mouse/touch on iPad too.

## Run locally

```bash
npm install
npm start          # http://localhost:3000  (login: admin / pass)
```

## Configuration (.env)

| Variable       | Default                  | Meaning                                          |
|----------------|--------------------------|--------------------------------------------------|
| `AUTH_USER`    | `admin`                  | Basic auth username                              |
| `AUTH_PASS`    | `pass`                   | Basic auth password — **change this**            |
| `PORT`         | `3000`                   | HTTP port (Hostinger sets this automatically)    |
| `SOURCE_URL`   | `https://176.97.124.32`  | Source site (change here if its IP ever changes) |
| `INSECURE_TLS` | unset                    | Set `1` only if the source TLS cert breaks       |
| `WATCHED_FILE` | `./data/watched.json`    | Where watched state is stored (JSON file)        |

> Note: after changing `AUTH_PASS`, devices that stored the old auth cookie will be asked to log in again.

## Deploy on Hostinger (Node.js hosting)

1. Upload the project (or connect via Git): `package.json`, `server.js`, `public/`, `.env`.
   Do **not** upload `node_modules` — Hostinger runs `npm install` itself.
2. Framework/backend: **Express**. Node version: 18, 20, 22 or 24 — all work.
3. Start command: `npm start` (entry file `server.js`).
4. Set environment variables in the Hostinger panel (or keep the `.env` file): at minimum `AUTH_USER` and `AUTH_PASS`.
5. Hostinger provides HTTPS on your domain automatically — basic auth credentials are then encrypted in transit.

## How playback resolution works

1. UI button → `GET /play?post=<id>&type=<server-type>&nume=<episode|1>`.
2. Server POSTs `action=doo_player_ajax` to the source's `admin-ajax.php` → gets an embed URL.
3. If the embed is the source's `p2.php` ad-wrapper, the server fetches it and extracts the real player iframe (e.g. `player.eltitbus.xyz`, `imgsto.re`). If no inner player is found, it falls back to the wrapper.
4. The page renders that player full-screen with a back button.
