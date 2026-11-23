import assert from "node:assert/strict";
import {
  DEFAULT_FAILURE_MESSAGE,
  failureCodeFromStatus,
  failureFromResponse,
  isTerminalFailure,
  MAX_AUTO_RETRIES,
  normalizeFailureCode,
  parseRetryAfterSeconds,
  planStreamRecovery,
  readStreamFailure,
  recoveryNotice,
  retryDelayMs,
  type StreamFailureCode,
} from "./player-recovery";

// The proxy's JSON body is the authoritative reason; the header is a fallback for when the
// body could not be read, and the status is only the last resort.
assert.equal(normalizeFailureCode("bot-check"), "bot-check");
assert.equal(normalizeFailureCode("  BOT-CHECK "), "bot-check");
assert.equal(normalizeFailureCode("rate-limited"), "rate-limited");
assert.equal(normalizeFailureCode("nonsense"), null);
assert.equal(normalizeFailureCode(undefined), null);
assert.equal(normalizeFailureCode(503), null);

assert.equal(failureCodeFromStatus(0), "network");
assert.equal(failureCodeFromStatus(404), "unavailable");
assert.equal(failureCodeFromStatus(403), "login-required");
assert.equal(failureCodeFromStatus(429), "rate-limited");
assert.equal(failureCodeFromStatus(503), "bot-check");
assert.equal(failureCodeFromStatus(502), "upstream-error");
assert.equal(failureCodeFromStatus(418), "unknown");

assert.deepEqual(
  readStreamFailure({
    status: 503,
    retryAfter: "90",
    errorHeader: "bot-check",
    body: { error: "bot-check", message: "YouTube is challenging this server" },
  }),
  { code: "bot-check", message: "YouTube is challenging this server", retryAfterSeconds: 90 }
);
// Body missing (or unreadable): the header still names the failure.
assert.equal(
  readStreamFailure({ status: 502, errorHeader: "upstream-restricted" }).code,
  "upstream-restricted"
);
// Neither: the status decides, and a 403 without detail is treated as a sign-in gate.
assert.equal(readStreamFailure({ status: 403 }).code, "login-required");
assert.equal(readStreamFailure({ status: 0 }).code, "network");
// Unknown body codes must not become a code the policy does not understand.
assert.equal(readStreamFailure({ status: 500, body: { error: "boom" } }).code, "upstream-error");

const now = 1_700_000_000_000;
assert.equal(parseRetryAfterSeconds("90", now), 90);
assert.equal(parseRetryAfterSeconds(45, now), 45);
assert.equal(parseRetryAfterSeconds(new Date(now + 30_000).toUTCString(), now), 30);
assert.equal(parseRetryAfterSeconds(new Date(now - 30_000).toUTCString(), now), 0, "past date");
assert.equal(parseRetryAfterSeconds("", now), 0);
assert.equal(parseRetryAfterSeconds(null, now), 0);
assert.equal(parseRetryAfterSeconds("soon", now), 0);
assert.equal(parseRetryAfterSeconds("999999", now), 86_400, "clamped to a day");

// A retry can never change these: they describe the track, so playback stops with the
// real reason instead of spinning.
const terminal: StreamFailureCode[] = [
  "invalid-id",
  "unavailable",
  "age-restricted",
  "login-required",
  "no-audio",
];
for (const code of terminal) {
  assert.equal(isTerminalFailure(code), true, `${code} must be terminal`);
}
const recoverable: StreamFailureCode[] = [
  "bot-check",
  "upstream-restricted",
  "upstream-error",
  "resolve-failed",
  "rate-limited",
  "network",
  "unknown",
];
for (const code of recoverable) {
  assert.equal(isTerminalFailure(code), false, `${code} must be retryable`);
}

// Progressive backoff, capped, so a burst of range requests cannot pile up.
const transient = { code: "network" as const, message: "", retryAfterSeconds: 0 };
assert.equal(retryDelayMs(transient, 0), 3_000);
assert.equal(retryDelayMs(transient, 1), 6_000);
assert.equal(retryDelayMs(transient, 2), 10_000);
assert.equal(retryDelayMs(transient, 99), 30_000);
// A server-provided wait wins: retrying a bot check early only deepens it.
const challenge = { code: "bot-check" as const, message: "", retryAfterSeconds: 90 };
assert.equal(retryDelayMs(challenge, 0), 90_000);
assert.equal(retryDelayMs(challenge, 7), 90_000);
// ...but an absurd value is clamped, and a tiny one is floored.
assert.equal(
  retryDelayMs({ code: "bot-check", message: "", retryAfterSeconds: 3600 }, 0),
  120_000
);
assert.equal(retryDelayMs({ code: "rate-limited", message: "", retryAfterSeconds: 1 }, 0), 5_000);

// The decision itself: keep playing while the cause can heal, stop on a real verdict.
const botCheck = readStreamFailure({ status: 503, retryAfter: "90", errorHeader: "bot-check" });
assert.deepEqual(planStreamRecovery(botCheck, 0), {
  action: "retry",
  delayMs: 90_000,
  message: DEFAULT_FAILURE_MESSAGE,
});
assert.equal(planStreamRecovery(botCheck, MAX_AUTO_RETRIES - 1).action, "retry");
assert.equal(planStreamRecovery(botCheck, MAX_AUTO_RETRIES).action, "stop", "bounded");

const restricted = readStreamFailure({
  status: 502,
  errorHeader: "upstream-restricted",
  body: { message: "YouTube only served the first part of this stream" },
});
assert.deepEqual(planStreamRecovery(restricted, 1), {
  action: "retry",
  delayMs: 6_000,
  message: "YouTube only served the first part of this stream",
});

const removed = readStreamFailure({
  status: 404,
  errorHeader: "unavailable",
  body: { message: "Track unavailable" },
});
assert.deepEqual(planStreamRecovery(removed, 0), {
  action: "stop",
  delayMs: 0,
  message: "Track unavailable",
});

// No verdict at all (offline, explanation request failed) is still worth retrying.
assert.deepEqual(planStreamRecovery(null, 1), {
  action: "retry",
  delayMs: 6_000,
  message: DEFAULT_FAILURE_MESSAGE,
});

// The user-facing line while recovering must promise that playback resumes by itself.
for (const code of ["bot-check", "rate-limited", "upstream-restricted"] as const) {
  const notice = recoveryNotice({ code, message: "", retryAfterSeconds: 0 });
  assert.ok(notice.length > 0, `${code} needs a notice`);
}
assert.match(recoveryNotice({ code: "bot-check", message: "", retryAfterSeconds: 0 }), /resumes automatically/);

// Reading the reason straight off a real Response is where the body-consumed trap lives:
// `json()` locks the stream, so cancelling it afterwards throws and the reason is lost.
const challengeResponse = new Response(
  JSON.stringify({
    error: "bot-check",
    message: "YouTube is temporarily challenging this server (bot check). Retry in a minute.",
  }),
  {
    status: 503,
    headers: { "content-type": "application/json", "retry-after": "90", "x-stream-error": "bot-check" },
  }
);
const fromChallenge = await failureFromResponse(challengeResponse);
assert.equal(fromChallenge.code, "bot-check");
assert.equal(fromChallenge.retryAfterSeconds, 90);
assert.match(fromChallenge.message, /bot check/);
assert.equal(planStreamRecovery(fromChallenge, 0).delayMs, 90_000);

// An okay response means the proxy works: the failure was local, so only the status counts.
const okResponse = await failureFromResponse(new Response(new Uint8Array(4), { status: 206 }));
assert.equal(okResponse.code, failureCodeFromStatus(206));
assert.equal(okResponse.message, "");

// A body that is not JSON must not hide the header the route always sends.
const brokenBody = await failureFromResponse(
  new Response("not json", { status: 502, headers: { "x-stream-error": "upstream-restricted" } })
);
assert.equal(brokenBody.code, "upstream-restricted");
assert.equal(isTerminalFailure(brokenBody.code), false);

// A rate limiter that answers with an HTTP date is understood as well.
const dated = await failureFromResponse(
  new Response(JSON.stringify({ error: "rate-limited" }), {
    status: 429,
    headers: { "retry-after": new Date(Date.now() + 20_000).toUTCString() },
  })
);
assert.equal(dated.code, "rate-limited");
assert.ok(dated.retryAfterSeconds >= 18 && dated.retryAfterSeconds <= 20, String(dated.retryAfterSeconds));

console.log("ALL_PLAYER_RECOVERY_CHECKS_PASSED");
