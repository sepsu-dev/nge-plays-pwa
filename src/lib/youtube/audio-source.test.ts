import assert from "node:assert/strict";
import {
  AUDIO_CLIENT_CANDIDATES,
  AUDIO_SOURCE_HTTP_STATUS,
  AudioSourceError,
  capExpiry,
  challengeRetryAfterSeconds,
  forgetChallenge,
  isBotCheckReason,
  isProxySafeUrl,
  isVideoId,
  markChallenged,
  orderCandidates,
  probeRanges,
} from "./audio-source";

// The stream route must never build an upstream URL from an unexpected id shape:
// a valid id is exactly 11 URL-safe characters.
const valid = ["dQw4w9WgXcQ", "9bZkp7q19f0", "kJQP7kiw5Fk", "___________", "-----------"];
const invalid = ["", "dQw4w9WgXc", "dQw4w9WgXcQQ", "dQw4w9WgXc!", "../../etc/passwd", "abcdefghij"];

for (const id of valid) {
  assert.equal(isVideoId(id), true, `expected ${JSON.stringify(id)} to be a valid id`);
}
for (const id of invalid) {
  assert.equal(isVideoId(id), false, `expected ${JSON.stringify(id)} to be rejected`);
}

// Every failure mode maps to a client-safe status: no 5xx leaks for user input,
// and unplayable/restricted tracks never look like a server bug.
assert.equal(AUDIO_SOURCE_HTTP_STATUS["invalid-id"], 400);
for (const code of ["unavailable", "no-audio"] as const) {
  assert.equal(AUDIO_SOURCE_HTTP_STATUS[code], 404, `${code} should be 404`);
}
for (const code of ["login-required", "age-restricted"] as const) {
  assert.equal(AUDIO_SOURCE_HTTP_STATUS[code], 403, `${code} should be 403`);
}
// A bot check is not a sign-in problem: the block is on the server's IP and clears itself,
// so it must not tell the user to log in, and it must be retryable.
assert.equal(AUDIO_SOURCE_HTTP_STATUS["bot-check"], 503);
assert.equal(AUDIO_SOURCE_HTTP_STATUS["resolve-failed"], 502);
// Range-restricted URLs are an upstream/CDN refusal, not a bug in the track.
assert.equal(AUDIO_SOURCE_HTTP_STATUS["upstream-restricted"], 502);

const err = new AudioSourceError("no-audio", "No audio stream available for this track");
assert.equal(err.name, "AudioSourceError");
assert.equal(err.code, "no-audio");
assert.ok(err instanceof Error);
// A plain failure carries no per-client detail and is treated as a real verdict, not a
// transient network hiccup (so it is cached instead of being retried on every request).
assert.equal(err.transient, false);
assert.deepEqual(err.candidates, []);

// A whole-pass failure keeps each client's verdict: the stream route returns them so a 502
// explains itself instead of just saying "Bad Gateway".
const summarized = new AudioSourceError("upstream-restricted", "all failed", {
  transient: true,
  candidates: [
    { client: "YTMUSIC", code: "upstream-restricted", message: "206/403/403" },
    { client: "IOS", code: "upstream-restricted", message: "206/403/403" },
  ],
});
assert.equal(summarized.code, "upstream-restricted");
assert.equal(summarized.transient, true);
assert.equal(summarized.candidates.length, 2);
assert.equal(summarized.candidates[1].client, "IOS");

// SABR-only URLs cannot be proxied as a byte range, so they must never be cached.
assert.equal(
  isProxySafeUrl("https://rr1---sn-x.googlevideo.com/videoplayback?itag=140&expire=1"),
  true
);
assert.equal(
  isProxySafeUrl("https://rr1---sn-x.googlevideo.com/videoplayback?itag=140&sabr=1"),
  false
);
assert.equal(isProxySafeUrl("https://rr1---sn-x.googlevideo.com/videoplayback?sabr=0"), true);
assert.equal(isProxySafeUrl("not a url"), false);

// Failover order: healthy, then cooling down, then explicitly excluded last, so a
// fresh URL from the client that just 403'd still gets a final chance.
const HOUR = 60 * 60 * 1000;
assert.deepEqual(orderCandidates(), [...AUDIO_CLIENT_CANDIDATES]);
const [primary, secondary] = AUDIO_CLIENT_CANDIDATES;

assert.deepEqual(orderCandidates({ exclude: [primary] }), [secondary, primary]);
assert.deepEqual(orderCandidates({ blocked: new Set([primary]) }), [secondary, primary]);
assert.deepEqual(
  orderCandidates({ exclude: [secondary], blocked: new Set([primary]) }),
  [primary, secondary]
);
// An excluded client always sorts after a merely cooling one.
assert.deepEqual(
  orderCandidates({ exclude: [primary], blocked: new Set([secondary]) }),
  [secondary, primary]
);

// Cached URLs are trusted for at most an hour, even when googlevideo allows longer.
const now = 1_700_000_000_000;
assert.equal(capExpiry(now + 5 * HOUR, now), now + HOUR);
assert.equal(capExpiry(now + 60_000, now), now + 60_000);

// Verification must touch the tail too: a URL that only serves its first chunk answers
// 206 for the head and 403 for everything deeper, which is what breaks seeking.
assert.deepEqual(probeRanges(), ["bytes=0-1023"]);
assert.deepEqual(probeRanges(0), ["bytes=0-1023"]);
assert.deepEqual(probeRanges(1024), ["bytes=0-1023"]);
const rangesForTrack = probeRanges(1_000_000);
assert.equal(rangesForTrack.length, 3, "a real track is probed at start, middle and tail");
assert.equal(rangesForTrack[0], "bytes=0-1023");
assert.equal(rangesForTrack[1], "bytes=500000-501023");
assert.equal(rangesForTrack[2], "bytes=998976-999999");

// `LOGIN_REQUIRED` hides two different problems: a real sign-in/age gate, and YouTube's bot
// check on the server's IP. Only the second must be treated as transient and backed off.
for (const reason of [
  "Login untuk mengonfirmasi bahwa Anda bukan bot",
  "Sign in to confirm you're not a bot",
  "Please verify you are not a robot",
  "We detected unusual traffic from your network",
]) {
  assert.equal(isBotCheckReason(reason), true, `expected a bot check: ${reason}`);
}
for (const reason of [
  "This video is age-restricted",
  "Login untuk mengonfirmasi usia Anda",
  "This video requires payment",
  "This track requires sign-in",
  "",
]) {
  assert.equal(isBotCheckReason(reason), false, `not a bot check: ${reason}`);
}

// The breaker makes resolution fail fast for a bounded time, then lets it through again, so
// a challenge cannot be turned into an endless retry loop (which deepens the check).
const challengeAt = 1_700_000_000_000;
forgetChallenge();
assert.equal(challengeRetryAfterSeconds(challengeAt), 0, "nothing to wait for without a check");
markChallenged(challengeAt);
const retryAfter = challengeRetryAfterSeconds(challengeAt);
assert.ok(retryAfter >= 89 && retryAfter <= 90, `expected ~90s of backoff, got ${retryAfter}`);
assert.equal(challengeRetryAfterSeconds(challengeAt + retryAfter * 1000), 0, "breaker expires");
// A second challenge must extend the wait, never shorten it.
markChallenged(challengeAt + 10_000);
assert.ok(challengeRetryAfterSeconds(challengeAt + 10_000) > 80);
forgetChallenge();
assert.equal(challengeRetryAfterSeconds(challengeAt), 0);

console.log("ALL_AUDIO_SOURCE_CHECKS_PASSED");
