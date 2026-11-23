/**
 * Smoke test for the server playback engine.
 *
 * Verifies, before touching the UI:
 *   1. youtubei.js can create a session (player script downloaded + evaluated)
 *   2. the resolved URL is plain (not SABR), so a byte range works
 *   3. the googlevideo URL answers 206 for a range at the start and mid-file (seek)
 *   4. repeated ranged requests keep working (a stale player script shows up here as
 *      an intermittent 403 rather than on the first request)
 *
 * Run: bun scripts/yt-smoke.ts [videoId] [--client=IOS] [--repeat=5]
 */
import { Innertube, Platform, UniversalCache } from "youtubei.js";
import { createPlayerEvaluator } from "../src/lib/youtube/player-evaluator";
import { isProxySafeUrl } from "../src/lib/youtube/audio-source";

Platform.shim.eval = createPlayerEvaluator();

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const has = (name: string) => args.includes(`--${name}`);

const videoId = (args.find((a) => !a.startsWith("--")) || "dQw4w9WgXcQ").slice(0, 11);
const client = (flag("client") || "YTMUSIC") as "YTMUSIC" | "IOS";
const repeat = Math.max(1, Number(flag("repeat") || 3));
const cacheDir = process.env.YT_CACHE_DIR?.trim();

const HEADERS = {
  accept: "*/*",
  origin: "https://www.youtube.com",
  referer: "https://www.youtube.com/",
};

const started = Date.now();

console.log(`[1/4] session… (client=${client} cache=${cacheDir ? "disk" : "memory"})`);
const yt = await Innertube.create({
  lang: "id",
  location: "ID",
  generate_session_locally: true,
  retrieve_player: true,
  cache: cacheDir ? new UniversalCache(true, cacheDir) : new UniversalCache(false),
});
console.log(`      ok in ${Date.now() - started}ms`);

console.log(`[2/4] info ${videoId}…`);
const info = await yt.getBasicInfo(videoId, { client });
console.log(
  `      status=${info.playability_status?.status}` +
    (info.playability_status?.reason ? ` reason=${info.playability_status.reason}` : "") +
    ` title=${JSON.stringify(info.basic_info.title)} dur=${info.basic_info.duration}s`
);

const audioOnly = (info.streaming_data?.adaptive_formats ?? []).filter(
  (f) => f.has_audio && !f.has_video && !f.is_type_otf
);
console.log(
  `      audio itags: ${audioOnly
    .map(
      (f) =>
        `${f.itag}(${f.mime_type.split(";")[0].replace("audio/", "")},${Math.round(
          (f.bitrate || 0) / 1000
        )}k)`
    )
    .join(" ")}`
);

const format =
  audioOnly.find((f) => f.mime_type.startsWith("audio/mp4")) ?? audioOnly[0] ?? null;
if (!format) throw new Error("no usable audio-only format");

console.log(`[3/4] decipher itag ${format.itag}…`);
const url = await format.decipher(yt.session.player);
if (!url) throw new Error("decipher returned an empty url");
const parsed = new URL(url);
console.log(
  `      host=${parsed.host} c=${parsed.searchParams.get("c") ?? "-"}` +
    ` sabr=${parsed.searchParams.get("sabr") ?? "0"}` +
    ` pot=${parsed.searchParams.has("pot") ? "yes" : "no"}` +
    ` n=${parsed.searchParams.get("n") ? "transformed" : "none"}`
);
console.log(`      content_length=${format.content_length} mime=${format.mime_type}`);

if (!isProxySafeUrl(url)) throw new Error("URL is SABR-only: a ranged GET will be rejected");

/** Read one range and return [status, content-range, bytes]. */
async function readRange(range: string): Promise<[number, string | null, number]> {
  const res = await fetch(url, { headers: { ...HEADERS, range } });
  const body = await res.arrayBuffer();
  return [res.status, res.headers.get("content-range"), body.byteLength];
}

const size = format.content_length || 0;
const seekStart = size > 200_000 ? Math.floor(size / 2) : 0;

console.log("[4/4] ranged fetches…");
const [headStatus, headRange, headBytes] = await readRange("bytes=0-2047");
console.log(`      head: status=${headStatus} content-range=${headRange} bytes=${headBytes}`);
if (headStatus !== 206 && headStatus !== 200) throw new Error("upstream rejected the ranged request");

if (seekStart > 0) {
  const [midStatus, midRange, midBytes] = await readRange(`bytes=${seekStart}-${seekStart + 2047}`);
  console.log(`      seek: status=${midStatus} content-range=${midRange} bytes=${midBytes}`);
  if (midStatus !== 206) throw new Error("upstream rejected the seek range");
}

if (repeat > 1) {
  let ok = 0;
  for (let i = 0; i < repeat; i++) {
    const [status] = await readRange("bytes=0-1023").catch(() => [0, null, 0] as const);
    if (status === 206 || status === 200) ok += 1;
    else console.log(`      repeat ${i + 1}/${repeat}: status=${status}`);
  }
  console.log(`      repeat: ${ok}/${repeat} ranged requests OK`);
  if (ok !== repeat) throw new Error("intermittent upstream rejection (stale player script?)");
}

console.log(`done in ${Date.now() - started}ms`);

