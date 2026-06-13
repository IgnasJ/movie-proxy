# Movie Proxy

TV-friendly proxy UI for movie/TV streaming sites. Node.js + Express, no build step. Supports three interchangeable sources, chosen after login.

## Sources

After logging in you pick a **source** (stored in the `mpsrc` cookie; switch any time via the link in the header):

- **8filmai** (`https://176.97.124.32`) — a WordPress/DooPlay site with Lithuanian-dubbed content; scraped from server-rendered HTML.
- **TOPfilmai** (`https://213.111.148.194`) — a DataLife Engine site with Lithuanian-dubbed content; scraped from server-rendered HTML. Playback is ad-free by design: every title embeds a **direct MP4** (movies as a single file, series as a per-episode playlist) from the `filmaito.top` CDN, played in our own `<video>`.
- **WatchLuna** — a large English catalog. Its own site is behind a Cloudflare challenge and its API was only ever a thin TMDB proxy, so the catalog is read **straight from TMDB** (needs a free `TMDB_API_KEY`); playback uses embed hosts that take a TMDB id directly (VidSrc / MoviesAPI / MultiEmbed).

All three expose the same UI (home, browse, search, detail, playback) through a small provider abstraction, so the features below work for any of them.

## What it does

- **Login page**: a proper styled form (not the browser's Basic Auth popup). A session cookie keeps you logged in for a year, so the TV isn't re-prompted; an "Atsijungti" link logs out. Credentials come from `.env`.
- **Source selection** screen (`/sources`) right after login.
- **Front page** shows the source's popular/newest movies and series as separate sections.
- **Search bar** queries the active source.
- **Browse pages** `/filmai` and `/serialai` with pagination.
- **Detail pages** show poster, original title, year, rating, runtime, language, genres and description (8filmai also shows cast).
- **Movies** get a row of server buttons; **series** get an episode list, each with its own server buttons. On 8filmai the trailer comes first, then the streaming servers; TopFilmai shows a single direct **Žiūrėti** button (plus an **Anonsas** trailer when one exists).
- **Clean playback**: each source renders the player full-screen inside the app, so the browser never has to connect to the raw source IP (whose TLS cert many TV browsers reject). 8filmai resolves the real player URL server-side and skips the source's `p2.php` popup-ad wrapper (falling back to it only if extraction fails); TopFilmai plays its direct MP4 in our own `<video>`; WatchLuna embeds the chosen server by TMDB id.
- **Ad-free playback (“Be reklamų”)**: where a source's default player wraps the stream in pop-up/redirect ads, a **▶ Be reklamų** shortcut bypasses it and plays the clean stream in our own player. 8filmai's **Streamtape** server is unwrapped to its direct MP4 (served through the signed `/stream` proxy); WatchLuna's **MoviesAPI** server is decrypted to a plain HLS master and played via `/tvproxy`. TopFilmai needs no bypass — every title is already a direct MP4. (The old DoodStream bypass was dropped once its mirrors moved behind a Cloudflare challenge.)
- **Subtitles (LT/EN)**: on WatchLuna a subtitle picker on the detail page offers EN and — when OpenSubtitles has them for that IMDb id — LT; the choice is passed to the embed player as `ds_lang`. In the ad-free HLS player the chosen track is fetched as WebVTT through `/sub` and rendered natively, with a custom on-video caption overlay for smart-TV browsers that won't paint `<track>` cues over hls.js.
- **Watched tracking (cross-device)**: opening a real stream provider automatically marks that title as watched (series also record the specific episode; trailers don't count). Watched items get a ✓ badge on every card/search result, plus per-episode ticks on series. State is stored **server-side** in `data/watched.json`, so all devices that use the same server share it — no manual marking, no per-device state. Override the path with the `WATCHED_FILE` env var.
- **Wishlist (“Mano sąrašas”, `/sarasas`)**: a **+ Į sąrašą** button on any detail page saves the title; the list page groups saved items by source and by film/series. Like watched state it's stored **server-side** (`data/wishlist.json`, override with `WISHLIST_FILE`), so every device sharing the server sees the same list.
- **TV remote navigation**: arrow keys move focus spatially with a big yellow focus ring; the remote's Back button goes back. Works with mouse/touch on iPad too.
- **Live TV (`/tv`)**: IPTV channels from a `data/iptv.m3u` playlist — edit it straight in the hosting file manager, changes apply on the next page load (no restart). Channels are grouped by `group-title` and numbered; the player has prev/next channel buttons.

## Live TV / IPTV

- **Playlist**: standard M3U (`#EXTINF` with `tvg-id`, `tvg-name`, `tvg-logo`, `group-title`, an optional `tvg-embed`, then the URL). The runtime file is `data/iptv.m3u`; path override via the `IPTV_FILE` env var.
- **EPG (program guide)**: the player shows a live schedule sidebar on the right. Each channel's `tvg-id` is used as an [iptvx.one](https://epg.iptvx.one) slug — the server scrapes `https://epg.iptvx.one/id/<tvg-id>` (cached ~30 min) and `/tv/epg?id=<slug>` returns it as JSON; the sidebar highlights what's on now and lists upcoming programmes. Leave `tvg-id=""` for a channel with no guide. Times are treated as Vilnius-local (matches an iPad/TV in Lithuania).
- **Encoded default + live editing**: the repo ships only `iptv.iptv` — a base64-encoded default (so plaintext stream URLs aren't committed). On first run the app decodes it into `data/iptv.m3u`. After that the runtime file is **never overwritten**, so you can edit `data/iptv.m3u` directly in the hosting file manager and your changes survive restarts and redeploys. To force a re-seed, delete `data/iptv.m3u`.
  - Update the baked-in default: edit the local plaintext master `iptv.m3u` (gitignored), run `npm run encode-iptv` (writes `iptv.iptv`), commit `iptv.iptv`.
  - Inspect the encoded file any time: `npm run decode-iptv` (prints the m3u to stdout). The decoder also accepts a plaintext `iptv.iptv`, so hand-editing it works too.
- **Playback**: HLS streams play in a plain HTML5 `<video>` — hls.js where MediaSource is available (Chrome/Firefox/TV browsers), native HLS on iPhone/iPad Safari. Direct mp4/mp3 also work.
- **Direct-first, proxy-fallback**: an `https` channel is tried **directly** first, so geo/IP allow-lists apply to the viewer rather than to the hosting server — some CDNs block datacenter IPs. If the direct attempt fails (CORS, geo-block, network), the same channel is retried through `/tvproxy`. `http://` sources skip the direct attempt (they'd be mixed content on an HTTPS page) and go straight to the proxy.
- **DRM fallback**: some otherwise-clean HLS feeds turn encrypted at times (e.g. SAMPLE-AES/FairPlay applied to a channel during live sports) — hls.js can't decrypt those. When that's detected and the channel declares a licensed `tvg-embed` player, the `<video>` is swapped for that embed iframe (which negotiates Widevine/PlayReady/FairPlay itself) and reverts to clean HLS once the encryption is dropped.
- **Proxy**: `/tvproxy` rewrites HLS playlists so every segment is served same-origin. That makes `http://` streams work on an HTTPS page (no mixed content), fixes missing CORS headers, carries a per-stream `Referer` to locked CDNs, and handles JSON wrapper URLs (a `get_live_url.php`-style endpoint that returns the real stream URL). Proxied URLs are signed, so it's not an open proxy.
- **YouTube**: `youtube.com/watch?v=…` / `youtu.be/…` playlist entries render as a YouTube embed.
- **Embed pages**: URLs containing `/embed` or ending in `.html` (e.g. an `/embed-video/…` player page) render as a plain iframe; prefix a URL with `iframe:` to force this.

## Run locally

```bash
npm install
npm start          # http://localhost:3000  (login: admin / pass)
```

## Configuration (.env)

| Variable       | Default                  | Meaning                                          |
|----------------|--------------------------|--------------------------------------------------|
| `AUTH_USER`    | `admin`                  | Login username                                   |
| `AUTH_PASS`    | `pass`                   | Login password — **change this**                 |
| `PORT`         | `3000`                   | HTTP port (Hostinger sets this automatically)    |
| `SOURCE_URL`   | `https://176.97.124.32`  | 8filmai source base (change if its IP ever changes) |
| `TOPFILMAI_URL`| `https://213.111.148.194`| TOPfilmai source base (change if its IP ever changes) |
| `TMDB_API_KEY` | unset                    | Free TMDB v3 key — **required for the WatchLuna source** |
| `INSECURE_TLS` | unset                    | Set `1` only if a source's TLS cert breaks       |
| `WATCHED_FILE` | `./data/watched.json`    | Where watched state is stored (JSON file)        |
| `WISHLIST_FILE`| `./data/wishlist.json`   | Where the wishlist is stored (JSON file)         |
| `IPTV_FILE`    | `./data/iptv.m3u`        | Runtime Live TV playlist (seeded from `iptv.iptv`, editable in hosting) |
| `IPTV_DEFAULT` | `./iptv.iptv`            | Encoded default playlist, decoded on first run   |

> Note: after changing `AUTH_PASS`, devices that stored the old auth cookie will be asked to log in again.

## Deploy on Hostinger (Node.js hosting)

1. Upload the project (or connect via Git): `package.json`, `server.js`, `iptv-codec.js`, `iptv.iptv`, `public/`, `.env`.
   Do **not** upload `node_modules` — Hostinger runs `npm install` itself. On first start the app decodes `iptv.iptv` into `data/iptv.m3u`; edit that file later in the file manager without redeploying.
2. Framework/backend: **Express**. Node version: 18, 20, 22 or 24 — all work.
3. Start command: `npm start` (entry file `server.js`).
4. Set environment variables in the Hostinger panel (or keep the `.env` file): at minimum `AUTH_USER` and `AUTH_PASS`, plus `TMDB_API_KEY` if you want the WatchLuna source.
5. Hostinger provides HTTPS on your domain automatically — your login credentials are then encrypted in transit.

## How playback resolution works

Every server button links to `GET /play?source=<src>&…&back=<detail-url>`, and `/play` dispatches by source:

**8filmai**
1. Server POSTs `action=doo_player_ajax` to the source's `admin-ajax.php` → gets an embed URL.
2. If the embed is the source's `p2.php` ad-wrapper, the server fetches it and extracts the real player iframe (e.g. `player.eltitbus.xyz`, `imgsto.re`). If no inner player is found, it falls back to the wrapper.

**TOPfilmai**
1. The detail page embeds Playerjs with a direct MP4 — `file:"…"` for a movie, or `file:[{title,file},…]` for a series (one page per season). The server extracts that URL.
2. The CDN is Referer-locked, so `/play` plays the MP4 in our own `<video>` through `/stream` (which sends the required Referer). Movie URLs carry an expiring token, so they're re-resolved from the detail page at click time, not stored. A YouTube trailer, when present, is offered as a second "Anonsas" button (a plain iframe).
3. An **▶ Originalus grotuvas** button plays in the source's own Playerjs instead of the bare `<video>` — its richer controls, and (for a series) a built-in episode list with next/prev. The player script is vendored at `public/playerjs.js` (served from our origin, no external dependency) and is fed the same `/stream`-proxied file(s), so the Referer lock still holds.

**WatchLuna**
1. Metadata comes from TMDB (`/movie/<id>`, `/tv/<id>`); the id and (for series) season/episode are known up front.
2. `/play` builds the embed URL directly from the chosen server template (VidSrc / MoviesAPI / MultiEmbed) — no extra fetch. Picking **▶ Be reklamų** instead resolves the MoviesAPI stream to a decrypted HLS master and plays it in our own player through `/tvproxy`, with the selected LT/EN subtitle attached as a `/sub` WebVTT track.

In all cases the page renders the player full-screen with a back button, and opening it marks the title watched.
