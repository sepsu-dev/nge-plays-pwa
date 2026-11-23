/**
 * Verifies the optional PO token provider end to end.
 *
 * A "restricted" track (206/403/403 across the head/middle/tail probes) is the single
 * most common playback failure, and the provider being down is the most common reason it
 * stays restricted. This checks the three things that can be wrong, in order:
 *
 *   1. the provider answers (GET /ping)
 *   2. it mints a token for this video (POST /get_pot)
 *   3. the production resolver + probe actually serve a seekable URL with it
 *
 * Run: bun scripts/yt-pot-check.ts [videoId]
 * Env: YT_PO_TOKEN_PROVIDER_URL=http://127.0.0.1:4416
 */
import { probeSource, resolveAudioSource } from "../src/lib/youtube/audio-source";
import { poTokenProviderUrl, potContentBinding, providerPoToken } from "../src/lib/youtube/po-token";

const videoId = (process.argv[2] || "SeSAwqq_Kpo").slice(0, 11);
const baseUrl = poTokenProviderUrl();

if (!baseUrl) {
  console.error("YT_PO_TOKEN_PROVIDER_URL is not set — there is nothing to check.");
  process.exit(1);
}

console.log(`provider: ${baseUrl}`);
const ping = await fetch(`${baseUrl}/ping`, { signal: AbortSignal.timeout(5000) })
  .then(async (res) => ({ ok: res.ok, body: await res.json().catch(() => ({})) }))
  .catch((err) => ({
    ok: false,
    body: { error: err instanceof Error ? err.message : String(err) },
  }));
console.log(`ping: ok=${ping.ok} ${JSON.stringify(ping.body)}`);

if (!ping.ok) {
  console.error("Provider is unreachable — start it before using it (see README).");
  process.exit(1);
}

const binding = potContentBinding(videoId, "IOS") ?? videoId;
const token = await providerPoToken(binding, "IOS");
console.log(`token: ${token ? `minted (${token.length} chars, binding=${binding})` : "none"}`);
if (!token) {
  console.error("Provider returned no token; check its logs (BotGuard failures are common).");
  process.exit(1);
}

const t0 = Date.now();
try {
  const source = await resolveAudioSource(videoId);
  console.log(
    `${videoId} client=${source.client} itag=${source.itag} ` +
      `size=${source.contentLength ?? 0} resolve=${Date.now() - t0}ms`
  );
  const probe = await probeSource(source.url, source.contentLength);
  console.log(`probe: ok=${probe.ok} statuses=${probe.statuses.join("/")}`);
  if (!probe.ok) throw new Error("the token did not lift the range restriction");
} catch (err) {
  console.error(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

console.log("PO_TOKEN_OK");
