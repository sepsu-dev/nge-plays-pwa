# Nge-Plays

A clean, fast, and ad-free web player for YouTube Music. Built with Next.js 16, React 19, and Tailwind CSS.

## Features

- **Ad-Free Playback**: Stream audio straight from YouTube through the app's own audio proxy — no embedded player, no iframe.
- **Unified Music Search**: Search for songs, albums, and artists in real time.
- **Synced Lyrics**: Follow along with timed lyrics when available.
- **Listen Together**: Create or join synchronized rooms to listen with friends via real-time sync.
- **Offline-First Library**: Manage playlists, favorite tracks, and history stored locally in your browser.
- **Installable PWA**: Add Nge-Plays to your home screen on Android, iOS, or desktop and use it as a standalone app.
- **Modern Minimalist UI**: Fast, responsive layout with native dark and light mode support.

## Tech Stack

- **Framework**: [Next.js](https://nextjs.org/) 16 (App Router)
- **Library**: [React](https://react.dev/) 19
- **Language**: [TypeScript](https://www.typescriptlang.org/)
- **Styling**: [Tailwind CSS](https://tailwindcss.com/) v4
- **Icons**: [Lucide React](https://lucide.dev/)
- **Playback**: [youtubei.js](https://ytjs.dev/) + a native `<audio>` element
- **Backend**: Next.js Server Actions & Route Handlers with Server-Sent Events (SSE)

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v20 or higher recommended) or [Bun](https://bun.sh/)

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/your-username/nge-play.git
   cd nge-play
   ```

2. Install dependencies:
   ```bash
   bun install
   # or
   npm install
   ```

3. Run the development server:
   ```bash
   bun dev
   # or
   npm run dev
   ```

4. Open [http://localhost:3000](http://localhost:3000) in your browser.

### Optional environment variables

| Variable | Purpose |
| --- | --- |
| `YOUTUBE_COOKIE` | Full `Cookie` header from a signed-in YouTube session. Helps with age-restricted tracks. |
| `YOUTUBE_PO_TOKEN` | Proof-of-Origin token for the session's default client. **Required for some tracks**: without it YouTube serves only the first ~512KB of a stream, so playback/seeking fails with 403. |
| `YOUTUBE_PO_TOKEN_<CLIENT>` | PO token pinned to one InnerTube client (`YOUTUBE_PO_TOKEN_YTMUSIC`, `YOUTUBE_PO_TOKEN_IOS`, …). Tokens are client-bound, so this is what to set when the resolver plays with a client other than the default one. |
| `YOUTUBE_VISITOR_DATA` | Visitor data the PO token was minted for. A token without its matching visitor data is rejected, so set both together. |
| `YT_PO_TOKEN_PROVIDER_URL` | Base URL of a [bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider) server (e.g. `http://127.0.0.1:4416`). Preferred over a static token: it mints a video-bound token per track, which is what actually lifts the ~512 KB range limit. |
| `YT_LANG` / `YT_LOCATION` | InnerTube language and region (defaults: `id` / `ID`). |
| `YT_CACHE_DIR` | Opt in to an on-disk player-script cache. Off by default: a stale player script produces URLs that look valid but answer 403. |

### How playback works

There is no YouTube iframe and no `iframe_api` script any more:

1. `youtubei.js` runs **only on the server** (`src/lib/youtube/…`) and resolves an audio-only
   format for each video id. Stream URLs are IP-bound and CORS-blocked, so they are never sent
   to the browser.
2. `GET /api/stream/<videoId>` proxies those bytes and forwards HTTP `Range` requests, which is
   what lets the `<audio>` element seek.
3. `useAudioPlayer` (`src/hooks/use-audio-player.ts`) drives one hidden `<audio>` element and
   keeps the existing clock, room sync, and Media Session integration in place.

Because `youtubei.js` v18 ships without a JS interpreter, signature/n-parameter deciphering is
provided by `src/lib/youtube/player-evaluator.ts`, which evaluates YouTube's player script in an
isolated `node:vm` context (no `process`, `require`, or network access). That means the stream
route needs the Node.js runtime (already declared with `export const runtime = "nodejs"`).

#### When a track returns 502 / "YouTube refused this stream"

`googlevideo` does not always hand out a URL that can serve the whole file:

- **Unprotected URLs** (no PO token) are limited to the first ~512 KB. That shows up as
  `206/403/403` from the start/middle/tail probes — head fine, everything deeper refused. The
  resolver rejects such a URL instead of failing mid-track, and the next InnerTube client
  (`YTMUSIC` → `IOS`) is tried, but *no* client can serve the rest of an unprotected URL.
  Set `YT_PO_TOKEN_PROVIDER_URL` (or a static `YOUTUBE_PO_TOKEN`) to lift the limit.
- A stale player script, an expired signature, and per-IP throttling (caused by requesting the
  same track in a loop) all look the same from the outside: `403`. Every 403 goes through
  `src/lib/youtube/recovery.ts`, which resolves a fresh URL and, if that is not enough,
  rebuilds the Innertube session. Failures are cached for ~20 s so a retrying client cannot
  turn one bad track into hundreds of upstream requests.
- Restriction is also *probabilistic*: googlevideo assigns a host per signed URL, and some
  hosts serve the whole file while others stop at ~512 KB. A resolve pass that failed only on
  restricted ranges is therefore retried with fresh URLs — spaced out, because a throttled IP
  can restrict several URLs in a row (`MAX_CANDIDATE_PASSES` / `PASS_GAP_MS` in
  `src/lib/youtube/audio-source.ts`) — instead of declaring the track unplayable.
- **“Login untuk mengonfirmasi bahwa Anda bukan bot” / “Sign in to confirm you're not a
  bot”** is *not* a missing sign-in: it is YouTube's bot check on the server's IP, usually
  after a burst of resolutions. It is reported as `bot-check` (`503` + `retry-after`), and
  resolution backs off for 90 s instead of retrying into it — tracks whose URL is already
  cached keep playing. To stop it happening in the first place, set `YOUTUBE_COOKIE`
  (signed-in session) and/or `YT_PO_TOKEN_PROVIDER_URL`.
- If the error persists for many tracks, the deployment IP is being challenged: set
  `YOUTUBE_PO_TOKEN` (a PO token for the visitor/client used by this server) together with
  `YOUTUBE_VISITOR_DATA`, or set `YOUTUBE_PO_TOKEN_<CLIENT>` for the client the resolver
  actually plays with. Playing less aggressively right after a restart also helps, because
  throttling is per IP and decays.
- **Playback recovers on its own.** A stream request that 403s is retried inside the route
  (fresh signed URL, up to `MAX_UPSTREAM_ATTEMPTS`), and the player's `<audio>` element is
  never allowed to die on a cause that heals: the client reads `x-stream-error` /
  `retry-after` from the failed request, waits exactly as long as the proxy asks (bot check:
  ~90 s, otherwise 3 s → 30 s backoff), and reloads the track from the same position — up to
  `MAX_AUTO_RETRIES` times (`src/lib/player-recovery.ts`). A watchdog also reloads a stream
  that stops delivering data without firing an error (network switch, suspended mobile tab).
  Only verdicts about the track itself (`unavailable`, `age-restricted`, `login-required`,
  `no-audio`) stop playback, with the real reason shown.
- Diagnosing one track: every error response carries its reason in the body and in the
  `x-stream-error` header, and a resolve failure lists each candidate's verdict:

  ```bash
  curl -s -H 'Range: bytes=0-1023' http://localhost:3000/api/stream/<videoId> | jq
  # {"error":"upstream-restricted","candidates":[{"client":"YTMUSIC","code":"upstream-restricted",
  #  "message":"YouTube refused YTMUSIC itag 251 ranges (403/403/403)"}, …]}
  ```

Diagnostics live in `scripts/` and use the production code:

```bash
bun scripts/yt-resolver.ts <videoId...>   # resolve + verify seek ranges end to end
bun scripts/yt-clients.ts <videoId>       # which InnerTube client yields a seekable URL
bun scripts/yt-smoke.ts <videoId>         # raw decipher + ranged fetch timings
bun scripts/yt-route-recovery.ts <videoId># forces upstream 403s through the API route
bun scripts/yt-pot-check.ts <videoId>     # PO token provider: ping, mint, seekable or not
```


### PWA / installable app

- `src/app/manifest.ts` → `/manifest.webmanifest` (standalone display, icons, shortcuts).
- `public/sw.js` → service worker: precaches the shell + `/offline`, caches static assets, and
  never caches audio (`/api/stream/…`) or API responses.
- `src/components/pwa/service-worker-register.tsx` → registers the worker in production builds.
- Icons live in `public/icons/` (192/512/maskable/apple-touch); regenerate them from the SVGs
  there with `rsvg-convert` if the logo changes.

Install from the browser menu ("Add to Home screen" / "Install app"). iOS requires Safari, and
the app must be served over HTTPS (or `localhost`) for the service worker to register.

### Production Build

```bash
bun run build
bun start
# or
npm run build
npm start
```

## Project Structure

```text
nge-plays/
├── public/                 # Service worker, PWA icons, static assets
├── scripts/                # Dev tools (audio engine smoke test)
├── src/
│   ├── actions/            # Server actions (YouTube search, lyrics, albums)
│   ├── app/                # Next.js App Router pages & API routes
│   │   ├── api/room/       # Synchronized room SSE endpoint
│   │   ├── api/stream/     # Audio proxy (youtubei.js → ranged audio bytes)
│   │   ├── manifest.ts     # Web app manifest (installable PWA)
│   │   ├── offline/        # Offline fallback page
│   │   ├── (app)/          # Player shell; all menus are SPA at `/`
│   │   │   ├── room/       # Listen Together deep link (`/room?room=CODE`)
│   │   │   ├── page.tsx    # Main web player interface (all menus)
│   │   │   └── layout.tsx  # Player provider + app shell
│   │   ├── layout.tsx      # Root layout, metadata, and theme configuration
│   ├── components/         # UI and feature components
│   │   ├── layout/         # Header, sidebar, and navigation
│   │   ├── library/        # Playlists, track lists, and dashboard
│   │   ├── player/         # Audio controls and now-playing modal
│   │   ├── pwa/            # Service worker registration
│   │   ├── room/           # Synchronized listening room modal
│   │   └── ui/             # Reusable primitives (tooltips, covers)
│   ├── hooks/              # Custom hooks for state and player sync
│   └── lib/
│       ├── youtube/        # Innertube session, audio resolver, player evaluator
│       └── ...             # Room logic, storage, and helpers
└── package.json            # Scripts and dependencies
```

## License

MIT