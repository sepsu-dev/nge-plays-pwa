/**
 * Verifies a *deployment* (local or Vercel) against the bot-check failure.
 *
 * The stream route is the only place where the IP that resolves the audio URL matters, so
 * this checks exactly what a browser would do, from the outside:
 *
 *   1. `GET /` answers (the app itself is up)
 *   2. `GET /api/stream/<videoId>` with `Range: bytes=0-1023` answers 206 (not 503 bot-check)
 *   3. the response names the InnerTube client/itag that worked, when it fails to
 *   4. the configured PO token provider answers `GET /ping` from *this* machine
 *
 * Run: bun scripts/yt-deploy-check.ts [baseUrl] [videoId]
 * Example: bun scripts/yt-deploy-check.ts https://nge-plays-pwa.vercel.app dQw4w9WgXcQ
 *
 * Exit code 0 means the deployment served audio. Anything else prints the reason and the
 * env changes that address it (see README → "Deploying to Vercel").
 */
import { pingProvider, poTokenProviderUrl, providerDown } from "../src/lib/youtube/po-token";

const baseUrl = (process.argv[2] || "http://localhost:3000").replace(/\/+$/, "");
const videoId = (process.argv[3] || "dQw4w9WgXcQ").slice(0, 11);
const isRemote = !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(`${baseUrl}/`);

function fail(message: string): never {
  console.error(`FAILED: ${message}`);
  process.exit(1);
}

console.log(`target: ${baseUrl} (${isRemote ? "remote" : "local"})`);
console.log(`video:  ${videoId}`);

const home = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(20_000) }).catch(
  (err) => err as Error
);
if (home instanceof Error) fail(`app unreachable: ${home.message}`);
await home.body?.cancel();
console.log(`home:   ${home.status}`);

// The provider only helps if the deployment can reach it; a loopback URL can never work
// from a serverless function, which is the single most common misconfiguration. Reported
// before the stream check so a failing deployment still shows it.
const providerUrl = poTokenProviderUrl();
if (!providerUrl) {
  console.warn("provider: not configured (YT_PO_TOKEN_PROVIDER_URL is empty)");
} else {
  console.log(`provider: ${providerUrl}`);
  if (isRemote && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(providerUrl)) {
    console.error("provider: loopback URL — unreachable from a deployment, use a public HTTPS URL");
  }
  const ok = await pingProvider(providerUrl);
  console.log(`ping: ${ok ? "ok" : `failed (breaker=${providerDown() ? "open" : "closed"})`}`);
}

const started = Date.now();
const res = await fetch(`${baseUrl}/api/stream/${videoId}`, {
  headers: { range: "bytes=0-1023" },
  signal: AbortSignal.timeout(60_000),
}).catch((err) => err as Error);
if (res instanceof Error) fail(`stream request failed: ${res.message}`);

// A failed stream request explains itself in the body and in `x-stream-error`; both are
// printed so the reason is visible without guessing from a 5xx alone.
const body = await res.text().catch(() => "");
console.log(
  `stream: ${res.status} in ${Date.now() - started}ms ` +
    `content-type=${res.headers.get("content-type") ?? "-"} ` +
    `x-stream-error=${res.headers.get("x-stream-error") ?? "-"} ` +
    `retry-after=${res.headers.get("retry-after") ?? "-"} ` +
    `bytes=${body.length}`
);
const vercelId = res.headers.get("x-vercel-id");
if (vercelId) console.log(`region: ${vercelId}`);

if (res.status === 206 || res.status === 200) {
  console.log("STREAM_OK");
} else {
  console.error(`body: ${body.slice(0, 600)}`);
  const code = res.headers.get("x-stream-error");
  if (code === "bot-check") {
    console.error(
      "\nThis is YouTube challenging the deployment's IP, not a missing track.\n" +
        "Set YOUTUBE_COOKIE + YOUTUBE_VISITOR_DATA (same session) in the Vercel project\n" +
        "and/or point YT_PO_TOKEN_PROVIDER_URL at a publicly reachable bgutil provider.\n" +
        "See README → \"Deploying to Vercel\"."
    );
  }
  process.exit(1);
}
