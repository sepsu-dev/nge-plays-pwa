import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  forgetPoTokens,
  pingProvider,
  poTokenProviderAuth,
  poTokenProviderUrl,
  potContentBinding,
  providerDown,
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

// A provider behind a gateway is authenticated with a plain header, and tokens must not be
// shared between clients: a `YTMUSIC` session token handed to `IOS` looks like no token at
// all to YouTube. Both are checked against a real HTTP server so the request shape is
// covered, not just the cache.
{
  const seen: { auth: string | undefined; body: string }[] = [];
  const server = createServer((req, res) => {
    if (req.url === "/ping") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: "test", server_uptime: 1 }));
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ auth: req.headers.authorization, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ poToken: `tok-${seen.length}`, expiresAt: 2_000_000_000 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  process.env.YT_PO_TOKEN_PROVIDER_URL = `http://127.0.0.1:${port}`;
  process.env.YT_PO_TOKEN_PROVIDER_AUTH = "Bearer shared-secret";
  forgetPoTokens();
  assert.equal(poTokenProviderAuth(), "Bearer shared-secret");

  assert.equal(await pingProvider(), true);
  assert.equal(await providerPoToken("dQw4w9WgXcQ", "IOS"), "tok-1");
  // Same binding, different client: a second mint, not a cache hit.
  assert.equal(await providerPoToken("dQw4w9WgXcQ", "YTMUSIC"), "tok-2");
  // Same client + binding is served from cache.
  assert.equal(await providerPoToken("dQw4w9WgXcQ", "IOS"), "tok-1");
  assert.equal(seen.length, 2);
  assert.equal(seen[0].auth, "Bearer shared-secret");
  assert.deepEqual(JSON.parse(seen[0].body), { content_binding: "dQw4w9WgXcQ" });
  assert.equal(providerDown(), false);

  server.close();
  delete process.env.YT_PO_TOKEN_PROVIDER_URL;
  delete process.env.YT_PO_TOKEN_PROVIDER_AUTH;
  forgetPoTokens();
}

console.log("ALL_PO_TOKEN_CHECKS_PASSED");
