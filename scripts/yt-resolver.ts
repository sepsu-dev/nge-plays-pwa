/**
 * End-to-end check of the production resolver.
 *
 * Unlike yt-smoke.ts (which talks to the library directly), this exercises
 * `resolveAudioSource` exactly as the API route does: candidate selection, SABR
 * rejection, probe verification, caching and deep-range serving.
 *
 * Run: bun scripts/yt-resolver.ts [videoId ...]
 */
import { probeSource, resolveAudioSource } from "../src/lib/youtube/audio-source";

const ids = process.argv.slice(2);
if (!ids.length) ids.push("SeSAwqq_Kpo", "dQw4w9WgXcQ", "kJQP7kiw5Fk");

const HEADERS = {
  accept: "*/*",
  origin: "https://www.youtube.com",
  referer: "https://www.youtube.com/",
};

let failures = 0;

for (const videoId of ids) {
  const t0 = Date.now();
  try {
    const source = await resolveAudioSource(videoId);
    const size = source.contentLength || 0;
    console.log(
      `${videoId} client=${source.client} itag=${source.itag} size=${size} ` +
        `mime=${source.mimeType.split(";")[0]} resolve=${Date.now() - t0}ms`
    );

    // Deep ranges are what the <audio> element needs for seeking.
    const deep = await probeSource(source.url, size);
    console.log(`   probe: ok=${deep.ok} statuses=${deep.statuses.join("/")}`);

    const midStart = Math.floor(size * 0.8);
    const res = await fetch(source.url, {
      headers: { ...HEADERS, range: `bytes=${midStart}-${midStart + 4095}` },
      signal: AbortSignal.timeout(15000),
    });
    const bytes = (await res.arrayBuffer()).byteLength;
    console.log(`   80%: status=${res.status} bytes=${bytes}`);

    // Second resolve must be served from cache (no new InnerTube round-trip).
    const t1 = Date.now();
    const again = await resolveAudioSource(videoId);
    console.log(`   cached resolve=${Date.now() - t1}ms same=${again.url === source.url}`);

    if (!deep.ok || res.status !== 206) failures += 1;
  } catch (err) {
    failures += 1;
    console.log(`${videoId} FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (failures) throw new Error(`${failures} of ${ids.length} tracks failed`);
console.log("ALL_TRACKS_RESOLVED");
