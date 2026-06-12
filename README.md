# Movie Proxy

TV-friendly proxy UI for movie/TV streaming sites. Node.js + Express, no build step. Supports two interchangeable sources, chosen after login.

## Sources

After logging in you pick a **source** (stored in the `mpsrc` cookie; switch any time via the link in the header):

- **8filmai** (`https://176.97.124.32`) — a WordPress/DooPlay site with Lithuanian-dubbed content; scraped from server-rendered HTML.
- **WatchLuna** (`https://watchluna.com`) — a Nuxt SPA with a large English catalog; read via its public JSON API. Playback uses its embed servers (VidSrc / MoviesAPI / MultiEmbed) keyed by TMDB id.

Both expose the same UI (home, browse, search, detail, playback) through a small provider abstraction, so all the features below work for either.

## What it does

- **Login page**: a proper styled form (not the browser's Basic Auth popup). A session cookie keeps you logged in for a year, so the TV isn't re-prompted; an "Atsijungti" link logs out. Credentials come from `.env`.
- **Source selection** screen (`/sources`) right after login.
- **Front page** shows the source's popular/newest movies and series as separate sections.
- **Search bar** queries the active source.
- **Browse pages** `/filmai` and `/serialai` with pagination.
- **Detail pages** show poster, original title, year, rating, runtime, language, genres and description (8filmai also shows cast).
- **Movies** get a row of server buttons; **series** get an episode list, each with its own server buttons. On 8filmai the order is **YouTube trailer first, then DOOD and STREAMT**, then the rest.
- **Clean playback**: for 8filmai, picking a server resolves the real video player URL server-side and embeds the trusted player domain directly — the source's popup-ad wrapper (`p2.php`) is skipped, and the browser never has to connect to the source IP (whose TLS cert many TV browsers reject); falls back to the wrapper if extraction fails. WatchLuna embeds its player directly by TMDB id.
- **Watched tracking (cross-device)**: opening a real stream provider automatically marks that title as watched (series also record the specific episode; trailers don't count). Watched items get a ✓ badge on every card/search result, plus per-episode ticks on series. State is stored **server-side** in `data/watched.json`, so all devices that use the same server share it — no manual marking, no per-device state. Override the path with the `WATCHED_FILE` env var.
- **TV remote navigation**: arrow keys move focus spatially with a big yellow focus ring; the remote's Back button goes back. Works with mouse/touch on iPad too.
- **Live TV (`/tv`)**: IPTV channels from a `data/iptv.m3u` playlist — edit it straight in the hosting file manager, changes apply on the next page load (no restart). Channels are grouped by `group-title` and numbered; the player has prev/next channel buttons.

## Live TV / IPTV

- **Playlist**: standard M3U (`#EXTINF` with `tvg-id`, `tvg-name`, `tvg-logo`, `group-title`, then the URL). The runtime file is `data/iptv.m3u`; path override via the `IPTV_FILE` env var.
- **EPG (program guide)**: the player shows a live schedule sidebar on the right. Each channel's `tvg-id` is used as an [iptvx.one](https://epg.iptvx.one) slug — the server scrapes `https://epg.iptvx.one/id/<tvg-id>` (cached ~30 min) and `/tv/epg?id=<slug>` returns it as JSON; the sidebar highlights what's on now and lists upcoming programmes. Leave `tvg-id=""` for a channel with no guide. Times are treated as Vilnius-local (matches an iPad/TV in Lithuania).
- **Encoded default + live editing**: the repo ships only `iptv.iptv` — a base64-encoded default (so plaintext stream URLs aren't committed). On first run the app decodes it into `data/iptv.m3u`. After that the runtime file is **never overwritten**, so you can edit `data/iptv.m3u` directly in the hosting file manager and your changes survive restarts and redeploys. To force a re-seed, delete `data/iptv.m3u`.
  - Update the baked-in default: edit the local plaintext master `iptv.m3u` (gitignored), run `npm run encode-iptv` (writes `iptv.iptv`), commit `iptv.iptv`.
  - Inspect the encoded file any time: `npm run decode-iptv` (prints the m3u to stdout). The decoder also accepts a plaintext `iptv.iptv`, so hand-editing it works too.
- **Playback**: HLS streams play in a plain HTML5 `<video>` — hls.js where MediaSource is available (Chrome/Firefox/TV browsers), native HLS on iPhone/iPad Safari. Direct mp4/mp3 also work.
- **Proxy**: streams go through `/tvproxy`, which rewrites HLS playlists so every segment is served same-origin. That makes `http://` streams work on an HTTPS page (no mixed content), fixes missing CORS headers, and handles JSON wrapper URLs (e.g. LRT's `get_live_url.php`). Proxied URLs are signed, so it's not an open proxy.
- **YouTube**: `youtube.com/watch?v=…` / `youtu.be/…` playlist entries render as a YouTube embed.
- **Embed pages**: URLs containing `/embed` or ending in `.html` (e.g. `play.tv3.lt/embed-video/…`) render as a plain iframe; prefix a URL with `iframe:` to force this.

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
| `SOURCE_URL`   | `https://176.97.124.32`  | 8filmai source base (change if its IP ever changes) |
| `WATCHLUNA_URL`| `https://watchluna.com`  | WatchLuna source base                            |
| `INSECURE_TLS` | unset                    | Set `1` only if the source TLS cert breaks       |
| `WATCHED_FILE` | `./data/watched.json`    | Where watched state is stored (JSON file)        |
| `IPTV_FILE`    | `./data/iptv.m3u`        | Runtime Live TV playlist (seeded from `iptv.iptv`, editable in hosting) |
| `IPTV_DEFAULT` | `./iptv.iptv`            | Encoded default playlist, decoded on first run   |

> Note: after changing `AUTH_PASS`, devices that stored the old auth cookie will be asked to log in again.

## Deploy on Hostinger (Node.js hosting)

1. Upload the project (or connect via Git): `package.json`, `server.js`, `iptv-codec.js`, `iptv.iptv`, `public/`, `.env`.
   Do **not** upload `node_modules` — Hostinger runs `npm install` itself. On first start the app decodes `iptv.iptv` into `data/iptv.m3u`; edit that file later in the file manager without redeploying.
2. Framework/backend: **Express**. Node version: 18, 20, 22 or 24 — all work.
3. Start command: `npm start` (entry file `server.js`).
4. Set environment variables in the Hostinger panel (or keep the `.env` file): at minimum `AUTH_USER` and `AUTH_PASS`.
5. Hostinger provides HTTPS on your domain automatically — basic auth credentials are then encrypted in transit.

## How playback resolution works

Every server button links to `GET /play?source=<src>&…&back=<detail-url>`, and `/play` dispatches by source:

**8filmai**
1. Server POSTs `action=doo_player_ajax` to the source's `admin-ajax.php` → gets an embed URL.
2. If the embed is the source's `p2.php` ad-wrapper, the server fetches it and extracts the real player iframe (e.g. `player.eltitbus.xyz`, `imgsto.re`). If no inner player is found, it falls back to the wrapper.

**WatchLuna**
1. The detail page is read from `/api/movies/<id>` or `/api/tv/<id>`; the TMDB id and (for series) season/episode are known.
2. `/play` builds the embed URL directly from the chosen server template (VidSrc / MoviesAPI / MultiEmbed) — no extra fetch.

In both cases the page renders the player full-screen with a back button, and opening it marks the title watched.
