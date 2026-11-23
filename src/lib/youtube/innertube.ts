import { Innertube, Log, Platform, UniversalCache } from "youtubei.js";
import { createPlayerEvaluator } from "./player-evaluator";

/**
 * One shared Innertube session per server process.
 *
 * Session creation downloads and parses YouTube's player script, which is what turns
 * a `signatureCipher` / `n` challenge into a playable URL, so the session is kept
 * alive. It is deliberately *not* persisted to disk by default: a player script that
 * survived a restart (or a YouTube rotation) still parses fine but produces URLs that
 * googlevideo answers with 403, and that failure mode is invisible until playback.
 * Set YT_CACHE_DIR to opt into an on-disk cache anyway.
 */
let instance: Promise<Innertube> | null = null;
let resetting: Promise<void> | null = null;

function create(): Promise<Innertube> {
  Log.setLevel(Log.Level.ERROR);
  Platform.shim.eval = createPlayerEvaluator();

  const cookie = process.env.YOUTUBE_COOKIE?.trim();
  const poToken = process.env.YOUTUBE_PO_TOKEN?.trim();
  const visitorData = process.env.YOUTUBE_VISITOR_DATA?.trim();
  const cacheDir = process.env.YT_CACHE_DIR?.trim();

  // A PO token is only accepted for the visitor it was minted for. Passing one without the
  // other produces URLs that look valid and answer 403 upstream, which is indistinguishable
  // from "no token" except in time lost, so say so instead of failing silently.
  if (poToken && !visitorData) {
    console.warn(
      "[innertube] YOUTUBE_PO_TOKEN is set without YOUTUBE_VISITOR_DATA; ignoring the token. " +
        "Set both, or use YT_PO_TOKEN_PROVIDER_URL instead."
    );
  }
  // A cookie is what turns a challenged datacenter IP into a signed-in session, but one
  // without `VISITOR_INFO1_LIVE` is the most common half-configured setup.
  if (cookie && !visitorData && !/VISITOR_INFO1_LIVE/i.test(cookie)) {
    console.warn(
      "[innertube] YOUTUBE_COOKIE looks incomplete (no VISITOR_INFO1_LIVE); " +
        "copy the full Cookie header from a signed-in youtube.com request."
    );
  }

  return Innertube.create({
    lang: process.env.YT_LANG || "id",
    location: process.env.YT_LOCATION || "ID",
    // Skip the extra /visitor_id round-trip; a local session is enough for playback.
    generate_session_locally: true,
    // Required for deciphering stream URLs.
    retrieve_player: true,
    cache: cacheDir ? new UniversalCache(true, cacheDir) : new UniversalCache(false),
    ...(cookie ? { cookie } : {}),
    ...(poToken && visitorData ? { po_token: poToken } : {}),
    ...(visitorData ? { visitor_data: visitorData } : {}),
  });
}

/**
 * PO token for one InnerTube client.
 *
 * `YOUTUBE_PO_TOKEN_<CLIENT>` (e.g. `YOUTUBE_PO_TOKEN_IOS`) pins the token that actually
 * matches the client being resolved with, which is what YouTube checks; a single
 * `YOUTUBE_PO_TOKEN` stays the fallback for the default client.
 */
export function poTokenForClient(client: string): string | undefined {
  const scoped = process.env[`YOUTUBE_PO_TOKEN_${client}`]?.trim();
  return scoped || process.env.YOUTUBE_PO_TOKEN?.trim() || undefined;
}

export async function getInnertube(): Promise<Innertube> {
  // Wait for an in-progress rebuild so callers never receive the session being replaced.
  if (resetting) await resetting;
  if (!instance) {
    instance = create().catch((err) => {
      instance = null;
      throw err;
    });
  }
  return instance;
}

/**
 * Drop the session so the next request rebuilds it with a freshly downloaded player
 * script. Concurrent calls share a single rebuild instead of stampeding YouTube.
 */
export function resetInnertube(): Promise<void> {
  instance = null;
  if (!resetting) {
    resetting = Promise.resolve()
      .then(() => {
        Log.info("Innertube", "Session reset requested");
      })
      .finally(() => {
        resetting = null;
      });
  }
  return resetting;
}

