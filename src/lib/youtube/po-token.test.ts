import assert from "node:assert/strict";
import {
  forgetPoTokens,
  poTokenProviderUrl,
  potContentBinding,
  providerPoToken,
  tokenExpiry,
} from "./po-token";

// Provider config is read per call, so a trailing slash in a .env value cannot produce
// `//get_pot` — a mistake that only shows up as a provider "failure" at play time.
process.env.YT_PO_TOKEN_PROVIDER_URL = "http://127.0.0.1:4416/";
assert.equal(poTokenProviderUrl(), "http://127.0.0.1:4416");
process.env.YT_PO_TOKEN_PROVIDER_URL = "  ";
assert.equal(poTokenProviderUrl(), "");
delete process.env.YT_PO_TOKEN_PROVIDER_URL;

// Player tokens are bound to the video id; `web_music` (YTMUSIC) uses a session token,
// which means our visitor data. Without one there is nothing valid to mint.
delete process.env.YOUTUBE_VISITOR_DATA;
assert.equal(potContentBinding("dQw4w9WgXcQ", "IOS"), "dQw4w9WgXcQ");
assert.equal(potContentBinding("dQw4w9WgXcQ", "YTMUSIC"), null);
process.env.YOUTUBE_VISITOR_DATA = " Cgt2aXNpdG9yMA%3D%3D ";
assert.equal(potContentBinding("dQw4w9WgXcQ", "YTMUSIC"), "Cgt2aXNpdG9yMA%3D%3D");
delete process.env.YOUTUBE_VISITOR_DATA;

// Provider expiry is epoch seconds, but tolerate milliseconds and garbage: a wrong unit
// would either evict tokens instantly or keep a dead token for years.
const now = 1_700_000_000_000;
const THIRTY_MIN = 30 * 60 * 1000;
assert.equal(tokenExpiry(1_700_000_600, now), Math.min(1_700_000_600_000, now + THIRTY_MIN));
assert.equal(tokenExpiry(1_700_000_600_000, now), Math.min(1_700_000_600_000, now + THIRTY_MIN));
assert.equal(tokenExpiry(undefined, now), now + THIRTY_MIN);
assert.equal(tokenExpiry("nonsense", now), now + THIRTY_MIN);
assert.equal(tokenExpiry(0, now), now + THIRTY_MIN);

// No provider configured: resolution must continue tokenless instead of reaching out.
forgetPoTokens();
assert.equal(await providerPoToken("dQw4w9WgXcQ"), null);
assert.equal(await providerPoToken(null), null);

console.log("ALL_PO_TOKEN_CHECKS_PASSED");
