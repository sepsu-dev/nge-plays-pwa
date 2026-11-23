import type { Types } from "youtubei.js";
import { getInnertube, poTokenForClient } from "./innertube";
import { potContentBinding, providerPoToken } from "./po-token";

export type AudioSourceErrorCode =
  | "invalid-id"
  | "unavailable"
  | "login-required"
  | "bot-check"
  | "age-restricted"
  | "no-audio"
  | "upstream-restricted"
  | "resolve-failed";

/**
 * InnerTube clients that hand out plain (non-SABR) audio URLs that googlevideo
 * accepts as a ranged GET.
 *
 * Order matters, and it is measured rather than guessed (`bun scripts/yt-clients.ts`):
 *  - WEB / MWEB / ANDROID only return SABR streaming data ("No valid URL to decipher"),
 *    which needs UMP and cannot be proxied as a single byte range.
 *  - ANDROID_VR / TV currently answer LOGIN_REQUIRED ("confirm you're not a bot").
 *  - IOS URLs carry no `n` parameter at all, which keeps them working even when the
 *    cached player script is too old to transform signatures; m4a/AAC plays everywhere.
 */
export const AUDIO_CLIENT_CANDIDATES = ["YTMUSIC", "IOS"] as const;
export type AudioClient = (typeof AUDIO_CLIENT_CANDIDATES)[number];

/** One client's verdict, kept so a 502 can explain *why* every candidate failed. */
export interface CandidateFailure {
  client: AudioClient;
  code: AudioSourceErrorCode;
  message: string;
}

export class AudioSourceError extends Error {
  code: AudioSourceErrorCode;
  /** A timeout / network hiccup rather than a verdict from YouTube: safe to retry soon. */
  transient: boolean;
  /** Per-client reasons, filled in when a whole candidate pass failed. */
  candidates: CandidateFailure[];

  constructor(
    code: AudioSourceErrorCode,
    message: string,
    details: { transient?: boolean; candidates?: CandidateFailure[] } = {}
  ) {
    super(message);
    this.name = "AudioSourceError";
    this.code = code;
    this.transient = details.transient ?? false;
    this.candidates = details.candidates ?? [];
  }
}

/** HTTP status the stream route answers with for each failure mode. */
export const AUDIO_SOURCE_HTTP_STATUS: Record<AudioSourceErrorCode, number> = {
  "invalid-id": 400,
  unavailable: 404,
  "login-required": 403,
  // Not 403: the user does not need to sign in, this server's IP is being challenged and
  // the block clears itself. 503 + retry-after says exactly that.
  "bot-check": 503,
  "age-restricted": 403,
  "no-audio": 404,
  "upstream-restricted": 502,
  "resolve-failed": 502,
};

/**
 * `LOGIN_REQUIRED` covers two very different failures: a real sign-in / age gate for the
 * track, and YouTube's bot check on the requesting IP ("Sign in to confirm you're not a
 * bot" / "Login untuk mengonfirmasi bahwa Anda bukan bot"). The reason is localized by
 * `YT_LANG`, so it is matched in several languages — `bot\b` also matches the Indonesian
 * wording, whose sentence ends in "bot".
 */
export function isBotCheckReason(reason: string): boolean {
  return /bot\b|robot|unusual traffic|verify|not a robot/i.test(reason);
}

/**
 * YouTube's bot check is per IP and decays with time, and every extra resolution while it is
 * active deepens it. A challenge therefore opens this breaker: resolution fails fast instead
 * of probing again. It gates *resolution only* — a track that already has a cached URL keeps
 * streaming, which is why the check lives here rather than in the route or the player.
 */
const CHALLENGE_COOLDOWN_MS = 90_000;
let challengedUntil = 0;

export function markChallenged(now = Date.now()): void {
  challengedUntil = Math.max(challengedUntil, now + CHALLENGE_COOLDOWN_MS);
}

/** Seconds until resolution may be attempted again, or 0 when no challenge is active. */
export function challengeRetryAfterSeconds(now = Date.now()): number {
  const remaining = challengedUntil - now;
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

/** Drop the breaker state (test/ops hook). */
export function forgetChallenge(): void {
  challengedUntil = 0;
}

function activeChallenge(): AudioSourceError | null {
  const retryAfter = challengeRetryAfterSeconds();
  if (!retryAfter) return null;
  return new AudioSourceError("bot-check", `YouTube bot check on this IP (retry in ${retryAfter}s)`, {
    transient: true,
  });
}

export interface AudioSource {
  videoId: string;
  /** Deciphered googlevideo URL. Bound to this server's IP — never expose it to clients. */
  url: string;
  mimeType: string;
  contentLength?: number;
  durationMs?: number;
  /** InnerTube client and itag that produced this URL (used for failover and logging). */
  client: AudioClient;
  itag: number;
  /** Epoch ms after which the URL is no longer valid upstream. */
  expiresAt: number;
}

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
// Refresh a minute early so a cached URL never expires mid-stream.
const EXPIRY_SKEW_MS = 60_000;
// Even when googlevideo allows a longer life, stop trusting a URL after an hour.
const MAX_TTL_MS = 60 * 60 * 1000;
const MAX_CACHED_SOURCES = 60;
// How long a (video, client) pair that failed the probe is deprioritised.
const CANDIDATE_COOLDOWN_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 5000;
const UPSTREAM_HEADERS = {
  accept: "*/*",
  origin: "https://www.youtube.com",
  referer: "https://www.youtube.com/",
};

const sources = new Map<string, AudioSource>();
const inflight = new Map<string, Promise<AudioSource>>();
const candidateCooldown = new Map<string, number>();
// A video that just failed is not re-attempted on every client retry: hammering the
// same track is what gets the IP throttled by googlevideo.
const failureCache = new Map<string, { error: AudioSourceError; until: number }>();

export function isVideoId(value: string): boolean {
  return VIDEO_ID_RE.test(value);
}

/**
 * Candidate order for one resolve attempt: healthy clients first, then clients that
 * failed a probe recently, then the ones the caller explicitly excluded (a fresh URL
 * from the same client can still work, so it stays as the last resort).
 * Pure, so the failover policy is unit-tested instead of inferred.
 */
export function orderCandidates({
  exclude = [],
  blocked = new Set<string>(),
}: { exclude?: readonly string[]; blocked?: ReadonlySet<string> } = {}): AudioClient[] {
  const excluded = new Set(exclude);
  const healthy: AudioClient[] = [];
  const cooling: AudioClient[] = [];
  const lastResort: AudioClient[] = [];
  for (const client of AUDIO_CLIENT_CANDIDATES) {
    if (excluded.has(client)) lastResort.push(client);
    else if (blocked.has(client)) cooling.push(client);
    else healthy.push(client);
  }
  return [...healthy, ...cooling, ...lastResort];
}

/** A URL with `sabr=1` needs UMP segment streaming, so a plain ranged GET is refused. */
export function isProxySafeUrl(url: string): boolean {
  try {
    return new URL(url).searchParams.get("sabr") !== "1";
  } catch {
    return false;
  }
}

/** Never keep a URL around longer than MAX_TTL_MS, and never past its own expiry. */
export function capExpiry(expiresAt: number, now = Date.now()): number {
  return Math.min(expiresAt, now + MAX_TTL_MS);
}

function cooldownKey(videoId: string, client: AudioClient): string {
  return `${videoId}:${client}`;
}

export function markCandidateFailed(videoId: string, client: AudioClient, now = Date.now()): void {
  candidateCooldown.set(cooldownKey(videoId, client), now + CANDIDATE_COOLDOWN_MS);
}

export function blockedCandidates(videoId: string, now = Date.now()): Set<string> {
  const blocked = new Set<string>();
  for (const [key, until] of candidateCooldown) {
    if (until <= now) candidateCooldown.delete(key);
    else if (key.startsWith(`${videoId}:`)) blocked.add(key.slice(videoId.length + 1));
  }
  return blocked;
}

export function forgetCandidateFailures(videoId: string): void {
  for (const key of candidateCooldown.keys()) {
    if (key.startsWith(`${videoId}:`)) candidateCooldown.delete(key);
  }
}

function readExpiry(url: string): number {
  try {
    const expire = Number(new URL(url).searchParams.get("expire"));
    if (Number.isFinite(expire) && expire > 0) return expire * 1000;
  } catch {}
  return Date.now() + MAX_TTL_MS;
}

function remember(source: AudioSource): void {
  sources.delete(source.videoId);
  sources.set(source.videoId, source);
  while (sources.size > MAX_CACHED_SOURCES) {
    const oldest = sources.keys().next().value;
    if (!oldest) break;
    sources.delete(oldest);
  }
}

export function forgetAudioSource(videoId: string): void {
  sources.delete(videoId);
}

/** Forget the short-lived failure marker so the next call really retries. */
export function forgetAudioFailure(videoId: string): void {
  failureCache.delete(videoId);
}

/**
 * Ranges used to verify a URL before it is cached.
 *
 * googlevideo serves some URLs only up to a shallow offset (≈512KB) while an otherwise
 * identical URL for the same video serves the whole file; requesting beyond the limit
 * answers 403. That restriction is invisible to `chooseFormat`/`decipher`, so the only
 * reliable check is to ask for the start, the middle and the tail. Each probe is 1KB.
 */
export function probeRanges(contentLength?: number): string[] {
  const ranges = ["bytes=0-1023"];
  const size = Number(contentLength) || 0;
  if (size > 8192) {
    const mid = Math.floor(size * 0.5);
    ranges.push(`bytes=${mid}-${mid + 1023}`);
    ranges.push(`bytes=${Math.max(0, size - 1024)}-${size - 1}`);
  }
  return ranges;
}

export interface ProbeResult {
  ok: boolean;
  statuses: number[];
}

/**
 * Cheap liveness check before a URL is cached: 1KB from the start, middle and tail
 * through the same headers the proxy uses. A URL that only serves its first chunk
 * still looks valid to `decipher`, and that is exactly what this catches — at resolve
 * time, so playback can switch candidates instead of failing mid-track.
 */
export async function probeSource(url: string, contentLength?: number): Promise<ProbeResult> {
  const statuses = await Promise.all(
    probeRanges(contentLength).map(async (range) => {
      try {
        const res = await fetch(url, {
          method: "GET",
          headers: { ...UPSTREAM_HEADERS, range },
          cache: "no-store",
          redirect: "follow",
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        await res.body?.cancel();
        return res.status;
      } catch {
        return 0;
      }
    })
  );

  // 206 is the expected answer; 200 means googlevideo ignored the range but served it.
  return { ok: statuses.every((status) => status === 206 || status === 200), statuses };
}

/**
 * Audio-only formats in preference order: AAC/m4a first (every mobile browser,
 * including iOS Safari, can decode it), then opus/webm, then whatever is original.
 */
type VideoInfo = Awaited<ReturnType<Awaited<ReturnType<typeof getInnertube>>["getBasicInfo"]>>;
type AudioFormat = ReturnType<VideoInfo["chooseFormat"]>;

export interface ResolveOptions {
  /** Ignore the memoised source and resolve a fresh URL. */
  refresh?: boolean;
  /** Clients that already failed for this request; they are tried last. */
  exclude?: readonly string[];
  /** Verify the URL with a one-byte ranged request before caching it (default true). */
  probe?: boolean;
}

/** ResolveOptions after defaults are applied. */
type ResolveFlags = { exclude: readonly string[]; probe: boolean };

function pickAudioFormat(info: VideoInfo): AudioFormat | null {
  const attempts = [
    { type: "audio", format: "mp4", quality: "best" },
    { type: "audio", format: "webm", quality: "best" },
    { type: "audio", quality: "best" },
  ] as const;

  for (const options of attempts) {
    try {
      const format = info.chooseFormat(options);
      // Segmented (live / OTF) formats need a DASH manifest and cannot be proxied as one stream.
      if (!format.is_type_otf && format.has_audio && !format.has_video) return format;
    } catch {}
  }
  return null;
}

/**
 * Resolve one (video, client) pair. Throws an AudioSourceError describing *why* this
 * client could not provide a usable URL, so the caller can decide to fail over.
 */
async function attemptClient(
  videoId: string,
  client: AudioClient,
  { probe }: { probe: boolean }
): Promise<AudioSource> {
  const yt = await getInnertube();
  // A PO token is only valid for the client (and usually the video) it was minted for, so
  // pinning one per client is what turns a 403 into a playable URL when bypassing IP checks.
  // A configured token wins (no round-trip); otherwise ask the provider for this video.
  const poToken =
    poTokenForClient(client) ??
    (await providerPoToken(potContentBinding(videoId, client), client));

  let info: VideoInfo;
  try {
    info = await yt.getBasicInfo(videoId, poToken ? { client, po_token: poToken } : { client });
  } catch (err) {
    throw toAudioSourceError(err);
  }

  const status = info.playability_status?.status;
  if (status === "LOGIN_REQUIRED") {
    const reason = info.playability_status?.reason || "";
    // Checked before the bot check: an age gate also says "confirm", and Indonesian says
    // "konfirmasi usia", so the two must not be confused.
    if (/age\b|usia|umur/i.test(reason)) {
      throw new AudioSourceError("age-restricted", "This track is age restricted");
    }
    if (isBotCheckReason(reason)) {
      markChallenged();
      throw new AudioSourceError(
        "bot-check",
        `YouTube bot check on this IP: ${reason || "no reason given"}`,
        { transient: true }
      );
    }
    throw new AudioSourceError("login-required", reason || "This track requires sign-in");
  }
  if (status === "ERROR") {
    throw new AudioSourceError("unavailable", info.playability_status?.reason || "Track unavailable");
  }
  if (status && status !== "OK") {
    throw new AudioSourceError("unavailable", info.playability_status?.reason || `Track is ${status}`);
  }

  const format = pickAudioFormat(info);
  if (!format) throw new AudioSourceError("no-audio", "No audio stream available for this track");

  const url = await format.decipher(yt.session.player).catch((err) => {
    throw toAudioSourceError(err);
  });
  if (!url) throw new AudioSourceError("resolve-failed", "Failed to decipher the audio URL");
  if (!isProxySafeUrl(url)) {
    // SABR URLs only serve UMP segments; a ranged GET is guaranteed to fail.
    throw new AudioSourceError("resolve-failed", "Client returned a SABR-only stream");
  }

  if (probe) {
    const result = await probeSource(url, format.content_length);
    if (!result.ok) {
      const refused = result.statuses.some((status) => [401, 403, 410].includes(status));
      // A URL that only serves its first chunk cannot be used for seeking: drop this
      // candidate for a while so the next attempt asks YouTube for a different host.
      if (refused) markCandidateFailed(videoId, client);
      throw new AudioSourceError(
        "upstream-restricted",
        `YouTube refused ${client} itag ${format.itag} ranges (${result.statuses.join("/")}; ` +
          `po_token=${poToken ? "yes" : "no"})`,
        // Status 0 means the probe timed out. Without a real refusal that is our network,
        // not a restriction, so it must not be remembered as a verdict about the track.
        { transient: !refused && result.statuses.includes(0) }
      );
    }
  }

  const durationMs =
    Number(format.approx_duration_ms) || Number(info.basic_info.duration ?? 0) * 1000 || undefined;

  return {
    videoId,
    url,
    mimeType: format.mime_type,
    contentLength: format.content_length,
    durationMs,
    client,
    itag: format.itag,
    expiresAt: capExpiry(readExpiry(url)),
  };
}


/**
 * Translate library errors (InnertubeError and friends) into the route's vocabulary.
 * Anything unrecognised stays a 502 instead of pretending the track is missing.
 */
function toAudioSourceError(err: unknown): AudioSourceError {
  if (err instanceof AudioSourceError) return err;
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (/unavailable|not available|does not exist|removed|private/i.test(message)) {
    return new AudioSourceError("unavailable", message || "Track unavailable");
  }
  // Bot check before the sign-in check: its reason usually contains "sign in" too, and the
  // two need opposite handling (back off vs. supply a cookie).
  if (isBotCheckReason(message)) {
    markChallenged();
    return new AudioSourceError("bot-check", message || "YouTube bot check", { transient: true });
  }
  if (/login_required|sign in|login required/i.test(message)) {
    return new AudioSourceError("login-required", message || "This track requires sign-in");
  }
  return new AudioSourceError("resolve-failed", message || "Failed to resolve audio");
}

/**
 * Each `getBasicInfo` call returns freshly signed URLs, and they are load-balanced
 * across googlevideo hosts: some serve the whole file, others only its first ~512KB.
 *
 * Measured on a track that reliably plays (`bun scripts/yt-clients.ts <videoId>` run in a
 * loop): the same client alternates between `206/403/403` (restricted host) and
 * `206/206/206` (fine) across attempts. One pass over the candidates is therefore *not*
 * enough — that is why playback of a healthy track sometimes 502s. A pass that failed only
 * because of restricted ranges is retried with fresh URLs, bounded so a genuinely
 * protected track still fails fast instead of hammering YouTube (which is what gets the
 * whole IP throttled).
 */
const MAX_CANDIDATE_PASSES = 3;
const MIN_FAILURE_CACHE_MS = 20_000;
// A pass can fail inside one throttle bucket; spacing passes out lands them in another.
const PASS_GAP_MS = 350;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface AttemptFailure {
  client: AudioClient;
  error: AudioSourceError;
}

/** Fold per-client failures into the detail a 502 response can show. */
function summarize(failures: AttemptFailure[]): {
  transient: boolean;
  candidates: CandidateFailure[];
} {
  return {
    // Only transient when *every* candidate failed for a transient reason.
    transient: failures.length > 0 && failures.every((f) => f.error.transient),
    candidates: failures.map(({ client, error }) => ({
      client,
      code: error.code,
      message: error.message,
    })),
  };
}

async function resolveUncached(videoId: string, { exclude, probe }: ResolveFlags): Promise<AudioSource> {
  // A challenged IP stays challenged for a while; asking again immediately is what turns a
  // minute-long block into a long one, so resolution fails fast until the breaker expires.
  // (Cached URLs are untouched: this function only runs on a cache miss or explicit refresh.)
  const challenged = activeChallenge();
  if (challenged) {
    console.warn(`[audio] ${videoId} skipped: ${challenged.message}`);
    throw challenged;
  }

  const failures: AttemptFailure[] = [];
  const candidates = orderCandidates({ exclude, blocked: blockedCandidates(videoId) });

  passes: for (let pass = 1; pass <= MAX_CANDIDATE_PASSES; pass += 1) {
    const passStart = failures.length;
    for (const client of candidates) {
      try {
        return await attemptClient(videoId, client, { probe });
      } catch (err) {
        const error = toAudioSourceError(err);
        failures.push({ client, error });
        console.warn(
          `[audio] ${videoId} candidate ${client} failed (${error.code}): ${error.message}` +
            (pass > 1 ? ` [pass ${pass}]` : "")
        );
        // A definite verdict from YouTube ends the search: another client cannot help.
        if (error.code === "unavailable" || error.code === "age-restricted") {
          throw new AudioSourceError(error.code, error.message, summarize(failures));
        }
        // A bot check is IP-wide and every extra request deepens it: stop right here.
        if (error.code === "bot-check") break passes;
      }
    }
    // Only a restricted range is worth retrying: another signed URL may land on a host
    // that serves the whole file. Sign-in / no-audio verdicts belong to the track itself.
    const passFailures = failures.slice(passStart);
    const retryable =
      passFailures.length > 0 &&
      passFailures.every((f) => f.error.code === "upstream-restricted" && !f.error.transient);
    if (!retryable) break;
    if (pass < MAX_CANDIDATE_PASSES) await sleep(PASS_GAP_MS);
  }

  // Report the most actionable verdict: an IP challenge explains every candidate failing at
  // once, then a definite verdict about the track, then sign-in / no-audio, and only then a
  // per-URL range restriction (the most likely thing to heal on its own).
  const pick = (...codes: AudioSourceErrorCode[]) =>
    failures.find((f) => codes.includes(f.error.code));
  const chosen =
    pick("bot-check") ??
    pick("age-restricted", "unavailable") ??
    pick("login-required", "no-audio") ??
    failures[failures.length - 1];
  throw new AudioSourceError(
    chosen?.error.code ?? "resolve-failed",
    chosen?.error.message ?? "No usable audio source",
    summarize(failures)
  );
}

/**
 * Resolve (and memoise) a playable audio URL for `videoId`.
 *
 * Concurrent callers share one in-flight lookup, so parallel range requests only
 * trigger a single InnerTube round-trip. Every candidate is probe-checked before it
 * is cached, and a client that answers 403 is deprioritised for this video for a
 * while, which is what keeps a stale player script from turning into playback errors.
 */
export async function resolveAudioSource(
  videoId: string,
  options: ResolveOptions = {}
): Promise<AudioSource> {
  const { refresh = false, exclude = [], probe = true } = options;

  if (!isVideoId(videoId)) {
    throw new AudioSourceError("invalid-id", "Invalid video id");
  }

  if (!refresh) {
    const cached = sources.get(videoId);
    if (cached && cached.expiresAt - EXPIRY_SKEW_MS > Date.now()) return cached;
    const failed = failureCache.get(videoId);
    if (failed && failed.until > Date.now()) throw failed.error;
    if (failed) failureCache.delete(videoId);
  } else {
    // Keep the current source: if the refresh cannot find a working URL, serving a
    // slightly old one beats failing the request outright.
    failureCache.delete(videoId);
  }

  const previous = sources.get(videoId);
  const usablePrevious = () =>
    previous && previous.expiresAt - EXPIRY_SKEW_MS > Date.now() ? previous : null;

  const key = `${videoId}|${[...exclude].sort().join(",")}|${refresh ? "r" : ""}`;
  const pending = inflight.get(key);
  if (pending) return pending;

  const task = resolveUncached(videoId, { exclude, probe })
    .then((source) => {
      remember(source);
      forgetCandidateFailures(videoId);
      failureCache.delete(videoId);
      return source;
    })
    .catch((err) => {
      const error =
        err instanceof AudioSourceError
          ? err
          : new AudioSourceError("resolve-failed", err instanceof Error ? err.message : "Resolve failed");
      const fallback = refresh ? usablePrevious() : null;
      if (fallback) {
        console.warn(`[audio] refresh failed for ${videoId}, keeping the previous source`);
        return fallback;
      }
      // Do not cache a verdict about the track itself; only transient upstream trouble.
      // A transient failure (probe timeout) is likewise not cached: it says nothing about
      // the track and caching it makes a slow network look like a blocked video.
      if (
        !error.transient &&
        (error.code === "resolve-failed" || error.code === "upstream-restricted")
      ) {
        failureCache.set(videoId, { error, until: Date.now() + MIN_FAILURE_CACHE_MS });
      }
      throw error;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, task);
  return task;
}

