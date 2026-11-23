/**
 * Client-side policy for a failed `/api/stream/<videoId>` request.
 *
 * Playback dies for reasons that heal on their own: the googlevideo URL went stale
 * (403), the host only serves the first ~512KB of the file, or YouTube is challenging
 * this server's IP (bot check, 503 + `retry-after`). None of those are worth stopping
 * the music for — the proxy re-resolves a fresh URL, so the player keeps the track
 * alive and retries until it plays. Only a verdict *about the track* (removed,
 * age-restricted, sign-in) ends playback, because no retry can change it.
 *
 * Kept pure so the policy is unit-tested instead of being buried in the hook.
 */

/** Everything the stream route (and the network itself) can report. */
export type StreamFailureCode =
  | "invalid-id"
  | "unavailable"
  | "login-required"
  | "bot-check"
  | "age-restricted"
  | "no-audio"
  | "upstream-restricted"
  | "resolve-failed"
  | "upstream-error"
  | "rate-limited"
  /** The request never reached the server (offline / aborted). */
  | "network"
  /** The proxy answered, but with a shape we could not classify. */
  | "unknown";

export interface StreamFailure {
  code: StreamFailureCode;
  /** User-facing explanation from the proxy, "" when it did not give one. */
  message: string;
  /** Seconds the proxy asked us to wait, 0 when it did not say. */
  retryAfterSeconds: number;
}

export interface StreamFailureInput {
  /** HTTP status; 0 when the request never completed. */
  status: number;
  /** `retry-after` header: seconds or an HTTP date. */
  retryAfter?: string | number | null;
  /** `x-stream-error` header (set on every failure by the stream route). */
  errorHeader?: string | null;
  body?: { error?: unknown; message?: unknown } | null;
}

export const DEFAULT_FAILURE_MESSAGE = "This track cannot be played";

const KNOWN_CODES: ReadonlySet<string> = new Set<StreamFailureCode>([
  "invalid-id",
  "unavailable",
  "login-required",
  "bot-check",
  "age-restricted",
  "no-audio",
  "upstream-restricted",
  "resolve-failed",
  "upstream-error",
  "rate-limited",
  "network",
  "unknown",
]);

/** Coerce whatever the network handed us into a code the policy understands. */
export function normalizeFailureCode(value: unknown): StreamFailureCode | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toLowerCase();
  return KNOWN_CODES.has(code) ? (code as StreamFailureCode) : null;
}

/** Fallback classification when only a status is known. */
export function failureCodeFromStatus(status: number): StreamFailureCode {
  if (status === 0) return "network";
  if (status === 404) return "unavailable";
  if (status === 403) return "login-required";
  if (status === 429) return "rate-limited";
  if (status === 503) return "bot-check";
  if (status >= 500) return "upstream-error";
  return "unknown";
}

/**
 * `retry-after` is seconds or an HTTP date. Clamped to a sane window: too small and the
 * player hammers a challenge, too large and the UI looks frozen for minutes.
 */
export function parseRetryAfterSeconds(
  value: string | number | null | undefined,
  now = Date.now()
): number {
  if (value === null || value === undefined || value === "") return 0;

  const raw = typeof value === "number" ? value : Number(String(value).trim());
  if (Number.isFinite(raw) && raw > 0) return Math.min(Math.ceil(raw), 86_400);

  const at = Date.parse(String(value));
  if (Number.isFinite(at)) {
    const diff = Math.ceil((at - now) / 1000);
    return diff > 0 ? Math.min(diff, 86_400) : 0;
  }
  return 0;
}

/**
 * Turn a failed request into a failure the policy can act on. The JSON body wins (it is
 * written for us), then the `x-stream-error` header (present even when the body is not
 * readable), then the status.
 */
export function readStreamFailure({
  status,
  retryAfter,
  errorHeader,
  body,
}: StreamFailureInput): StreamFailure {
  const fromBody = normalizeFailureCode(body?.error);
  const fromHeader = normalizeFailureCode(errorHeader);
  const code = fromBody ?? fromHeader ?? failureCodeFromStatus(status);
  const message =
    typeof body?.message === "string" && body.message.trim() ? body.message.trim() : "";
  return { code, message, retryAfterSeconds: parseRetryAfterSeconds(retryAfter) };
}

/**
 * Read a failed stream-route `Response` exactly the way the player does.
 *
 * Two traps live here: `json()` consumes the body (cancelling afterwards throws "stream is
 * locked", which used to swallow the reason), and an okay response means the proxy is
 * healthy, so the failure was local (decode/offline) and only the status is usable.
 */
export async function failureFromResponse(res: Response): Promise<StreamFailure> {
  if (res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return readStreamFailure({ status: res.status });
  }
  const body = (await res.json().catch(() => null)) as
    | { error?: unknown; message?: unknown }
    | null;
  return readStreamFailure({
    status: res.status,
    retryAfter: res.headers.get("retry-after"),
    errorHeader: res.headers.get("x-stream-error"),
    body,
  });
}

/**
 * Verdicts about the track itself. Retrying cannot change them, so playback stops and
 * the user is told what is wrong instead of watching a spinner.
 */
export function isTerminalFailure(code: StreamFailureCode): boolean {
  return (
    code === "invalid-id" ||
    code === "unavailable" ||
    code === "age-restricted" ||
    code === "login-required" ||
    code === "no-audio"
  );
}

/**
 * Attempts before the player gives up. With plain backoff that is ~2.5 minutes; when
 * YouTube asks for a 90s `retry-after` (bot check) the same budget stretches to ~12
 * minutes, which is the point — the block is per IP and needs time to decay.
 */
export const MAX_AUTO_RETRIES = 8;

const BACKOFF_MS = [3_000, 6_000, 10_000, 15_000, 20_000, 30_000];
const MIN_SERVER_WAIT_MS = 5_000;
const MAX_SERVER_WAIT_MS = 120_000;

/**
 * How long to wait before retry attempt `attempt` (0-based). A server-provided
 * `retry-after` wins (a bot check lasts ~90s; retrying earlier only deepens it),
 * otherwise back off progressively so a burst of range requests cannot pile up.
 */
export function retryDelayMs(failure: StreamFailure, attempt: number): number {
  const index = Math.min(Math.max(0, Math.floor(attempt)), BACKOFF_MS.length - 1);
  const backoff = BACKOFF_MS[index];
  const serverWait = failure.retryAfterSeconds * 1000;
  if (serverWait <= 0) return backoff;
  return Math.max(backoff, Math.min(Math.max(serverWait, MIN_SERVER_WAIT_MS), MAX_SERVER_WAIT_MS));
}

export interface RecoveryPlan {
  action: "retry" | "stop";
  /** Milliseconds to wait before reloading the source (0 when stopping). */
  delayMs: number;
  /** What to tell the user when stopping. */
  message: string;
}

/**
 * Decide what to do after the source failed even once it was reloaded. `failure` is null
 * when the explanation request itself could not be made (still worth retrying).
 */
export function planStreamRecovery(
  failure: StreamFailure | null,
  attempt: number,
  maxRetries = MAX_AUTO_RETRIES
): RecoveryPlan {
  if (!failure) {
    return {
      action: "retry",
      delayMs: BACKOFF_MS[Math.min(Math.max(0, attempt), BACKOFF_MS.length - 1)],
      message: DEFAULT_FAILURE_MESSAGE,
    };
  }
  if (isTerminalFailure(failure.code) || attempt >= maxRetries) {
    return { action: "stop", delayMs: 0, message: failure.message || DEFAULT_FAILURE_MESSAGE };
  }
  return {
    action: "retry",
    delayMs: retryDelayMs(failure, attempt),
    message: failure.message || DEFAULT_FAILURE_MESSAGE,
  };
}

/** Short line shown while the player heals itself (one toast per outage). */
export function recoveryNotice(failure: StreamFailure): string {
  switch (failure.code) {
    case "bot-check":
      return "YouTube is checking this server (bot check) — playback resumes automatically…";
    case "rate-limited":
      return "Too many stream requests — playback resumes automatically…";
    case "upstream-restricted":
      return "YouTube only served part of this stream — fetching a fresh link…";
    default:
      return "Playback was interrupted — retrying automatically…";
  }
}
