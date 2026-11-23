/**
 * Which InnerTube client yields a URL that can actually be *seeked*, without a PO token?
 *
 * A URL can look fine (200/206 at the head) yet refuse everything past ~512KB, so the
 * head alone proves nothing. Each candidate is probed at the start, middle and tail.
 *
 * Run: bun scripts/yt-clients.ts [videoId]
 */
import { Innertube, Platform, type Types } from "youtubei.js";
import { createPlayerEvaluator } from "../src/lib/youtube/player-evaluator";

Platform.shim.eval = createPlayerEvaluator();

const clients = [
  "YTMUSIC",
  "IOS",
  "YTMUSIC_ANDROID",
  "VISIONOS",
  "TV_SIMPLY",
  "WEB_EMBEDDED",
  "MWEB",
  "ANDROID_VR",
] as const satisfies readonly Types.InnerTubeClient[];

const videoId = (process.argv[2] || "SeSAwqq_Kpo").slice(0, 11);
const HEADERS = {
  accept: "*/*",
  origin: "https://www.youtube.com",
  referer: "https://www.youtube.com/",
};

const yt = await Innertube.create({
  lang: "id",
  location: "ID",
  generate_session_locally: true,
  retrieve_player: true,
});

console.log(`video=${videoId}\n`);

for (const client of clients) {
  const t0 = Date.now();
  try {
    const info = await yt.getBasicInfo(videoId, { client });
    const status = info.playability_status?.status;
    const formats = (info.streaming_data?.adaptive_formats ?? []).filter(
      (f) => f.has_audio && !f.has_video && !f.is_type_otf
    );
    const format = formats.find((f) => f.mime_type.startsWith("audio/mp4")) ?? formats[0];
    if (!format) {
      console.log(
        `${client.padEnd(16)} status=${status} no-audio ${info.playability_status?.reason ?? ""}`
      );
      continue;
    }
    const url = await format.decipher(yt.session.player);
    const size = format.content_length || 0;
    const offsets = [0, Math.floor(size / 2), Math.max(0, size - 1024)];
    const statuses = await Promise.all(
      offsets.map(async (start) => {
        try {
          const res = await fetch(url, {
            headers: { ...HEADERS, range: `bytes=${start}-${start + 1023}` },
            signal: AbortSignal.timeout(12000),
          });
          await res.body?.cancel();
          return res.status;
        } catch {
          return 0;
        }
      })
    );
    const ok = statuses.every((s) => s === 206 || s === 200);
    console.log(
      `${client.padEnd(16)} status=${status} itag=${String(format.itag).padEnd(4)} ` +
        `size=${String(size).padStart(7)} seek=${statuses.join("/")} ${ok ? "OK" : "restricted"} ` +
        `(${Date.now() - t0}ms)`
    );
  } catch (err) {
    console.log(`${client.padEnd(16)} ERROR ${err instanceof Error ? err.message : String(err)}`);
  }
}

