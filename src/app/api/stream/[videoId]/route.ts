import {
  AUDIO_SOURCE_HTTP_STATUS,
  AudioSourceError,
  isVideoId,
  resolveAudioSource,
  type AudioSource,
} from "@/lib/youtube/audio-source";
import { recoverAudioSource } from "@/lib/youtube/recovery";
import { getClientIp, takeRateLimit } from "@/lib/server-guard";

/**
 * Same-origin audio endpoint.
 *
 * googlevideo URLs are bound to the IP that requested them and reject browser
 * requests (CORS + missing Origin/Referer), so the browser cannot use them directly.
 * This handler resolves the URL server-side and pipes the bytes through, preserving
 * HTTP range requests so the <audio> element can seek.
 *
 * `googlevideo` rejects a URL that no longer matches its signing state (expired, stale
 * player script, or IP throttled after too many requests), so every 401/403/410 goes
 * through one shared recovery path. An <audio> element fires several range requests at
 * once, and recovery coalesces them, so a track never fans out into parallel retries.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPSTREAM_HEADERS = {
  accept: "*/*",
  origin: "https://www.youtube.com",
  referer: "https://www.youtube.com/",
};
const MAX_CLIENT_TTL_SECONDS = 3600;
const RATE_LIMIT_PER_MINUTE = 240;
const STALE_STATUSES = [401, 403, 410];
// A client retry (`?r=1`) should get a genuinely fresh URL, but not faster than this.
const FORCED_REFRESH_COOLDOWN_MS = 2000;
const MAX_REFRESH_KEYS = 500;

type RouteContext = { params: Promise<{ videoId: string }> };

const forcedRefreshAt = new Map<string, number>();

/**
 * `useAudioPlayer` appends `?r=<n>` the first time it reloads a track after an error.
 * Treating that as a request for a new URL is what turns a play button that hit a
 * stale/restricted URL into a real retry instead of the same cached answer. The
 * cooldown keeps the player's immediate second retry from resolving again for nothing.
 */
function takeForcedRefresh(videoId: string, retryToken: number, now = Date.now()): boolean {
  if (retryToken < 1) return false;
  const last = forcedRefreshAt.get(videoId) ?? 0;
  if (now - last < FORCED_REFRESH_COOLDOWN_MS) return false;
  if (forcedRefreshAt.size >= MAX_REFRESH_KEYS) forcedRefreshAt.clear();
  forcedRefreshAt.set(videoId, now);
  return true;
}

function jsonError(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {}
): Response {
  return Response.json(
    { error: code, message, ...extra },
    {
      status,
      headers: {
        "cache-control": "no-store",
        // Surfaces the reason on the network row, so a failed <audio> request explains
        // itself even when the response body is never inspected.
        "x-stream-error": code,
      },
    }
  );
}

/** Client-facing text for failures whose technical detail is not actionable. */
const MESSAGES: Partial<Record<AudioSourceError["code"], string>> = {
  "upstream-restricted":
    "YouTube only served the first part of this stream. Retry, or set YT_PO_TOKEN_PROVIDER_URL / YOUTUBE_PO_TOKEN (see README).",
};

function buildHeaders(upstream: Response, source: AudioSource): Headers {
  const headers = new Headers();
  headers.set("content-type", upstream.headers.get("content-type") || source.mimeType);
  headers.set("accept-ranges", "bytes");
  headers.set("content-disposition", "inline");
  headers.set("vary", "range");
  for (const name of ["content-length", "content-range", "last-modified", "etag"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  const ttl = Math.floor((source.expiresAt - Date.now()) / 1000);
  headers.set("cache-control", `private, max-age=${Math.max(0, Math.min(ttl, MAX_CLIENT_TTL_SECONDS))}`);
  return headers;
}

async function handle(request: Request, context: RouteContext, withBody: boolean): Promise<Response> {
  const { videoId } = await context.params;
  if (!isVideoId(videoId)) return jsonError(400, "invalid-id", "Invalid video id");

  const ip = await getClientIp();
  if (!takeRateLimit(`stream:${ip || "unknown"}`, RATE_LIMIT_PER_MINUTE)) {
    return jsonError(429, "rate-limited", "Too many requests");
  }

  const range = request.headers.get("range") ?? undefined;
  const retryToken = Number(new URL(request.url).searchParams.get("r") || 0) || 0;
  const forceRefresh = takeForcedRefresh(videoId, retryToken);

  const requestUpstream = (source: AudioSource) =>
    fetch(source.url, {
      method: withBody ? "GET" : "HEAD",
      headers: range ? { ...UPSTREAM_HEADERS, range } : UPSTREAM_HEADERS,
      cache: "no-store",
      redirect: "follow",
      signal: request.signal,
    });

  let source: AudioSource;
  let upstream: Response;
  try {
    source = await resolveAudioSource(videoId, forceRefresh ? { refresh: true } : undefined);
    upstream = await requestUpstream(source);

    if (STALE_STATUSES.includes(upstream.status)) {
      console.warn(
        `[stream] upstream ${upstream.status} for ${videoId} (${source.client} itag ${source.itag}); recovering`
      );
      await upstream.body?.cancel();
      source = await recoverAudioSource(videoId, source.client);
      upstream = await requestUpstream(source);
    }
  } catch (err) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    if (err instanceof AudioSourceError) {
      return jsonError(
        AUDIO_SOURCE_HTTP_STATUS[err.code],
        err.code,
        MESSAGES[err.code] ?? err.message,
        {
          // Every candidate's verdict: this is what turns "502 Bad Gateway" into
          // "YouTube refused both YTMUSIC and IOS for this track".
          ...(err.candidates.length ? { candidates: err.candidates } : {}),
          ...(err.transient ? { transient: true } : {}),
        }
      );
    }
    console.error("[stream] resolve failed", err);
    return jsonError(502, "resolve-failed", "Failed to resolve audio");
  }

  const headers = buildHeaders(upstream, source);

  if (upstream.status === 416) {
    await upstream.body?.cancel();
    return new Response(null, { status: 416, headers });
  }
  if (!upstream.ok) {
    await upstream.body?.cancel();
    console.warn(
      `[stream] giving up on ${videoId} (${source.client} itag ${source.itag}): ${upstream.status}`
    );
    const restricted = upstream.status === 403;
    return jsonError(
      502,
      restricted ? "upstream-restricted" : "upstream-error",
      restricted
        ? "YouTube only served the first part of this stream. Retry, or set YT_PO_TOKEN_PROVIDER_URL (see README)."
        : `Upstream responded with ${upstream.status}`,
      { upstreamStatus: upstream.status, client: source.client, itag: source.itag }
    );
  }
  if (!withBody) {
    await upstream.body?.cancel();
    return new Response(null, { status: upstream.status, headers });
  }

  return new Response(upstream.body, { status: upstream.status, headers });
}

export function GET(request: Request, context: RouteContext): Promise<Response> {
  return handle(request, context, true);
}

export function HEAD(request: Request, context: RouteContext): Promise<Response> {
  return handle(request, context, false);
}

