/**
 * Verifies the API route's 403 handling against the real network.
 *
 * Instead of faking the resolver, this imports the route module and interferes only
 * with googlevideo calls: the first upstream range request is answered with a synthetic
 * 403 (what a stale signed URL produces), and the route must recover and still serve
 * audio. A second scenario rejects every upstream call to prove the failure is bounded
 * and reported, rather than retried forever.
 *
 * Run: bun scripts/yt-route-recovery.ts [videoId]
 */
import { GET } from "../src/app/api/stream/[videoId]/route";

const videoId = (process.argv[2] || "SeSAwqq_Kpo").slice(0, 11);
const realFetch = globalThis.fetch;
const isGooglevideo = (input: RequestInfo | URL) =>
  String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).includes(
    "googlevideo.com"
  );

let playerCalls = 0;
const countingFetch: typeof fetch = (input, init) => {
  const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.includes("youtubei") || url.includes("/player") || url.includes("/att/get")) {
    playerCalls += 1;
  }
  return realFetch(input, init);
};
globalThis.fetch = countingFetch;

async function call(range: string): Promise<Response> {
  return GET(
    new Request(`http://localhost/api/stream/${videoId}`, {
      headers: { range },
    }),
    { params: Promise.resolve({ videoId }) }
  );
}

// Priming resolve: cache a good source, so the next call is the "stale URL" case.
const prime = await call("bytes=0-1023");
console.log(`prime: ${prime.status}`);
await prime.body?.cancel();
const playerCallsAfterPrime = playerCalls;

// --- Scenario A: the next upstream range request is rejected once (stale URL) ---
let injected = 0;
globalThis.fetch = ((input, init) => {
  if (isGooglevideo(input) && injected === 0) {
    injected += 1;
    return Promise.resolve(new Response("stale", { status: 403 }));
  }
  return countingFetch(input, init);
}) as typeof fetch;

const recovered = await call("bytes=1000-3047");
const recoveredBytes = (await recovered.arrayBuffer()).byteLength;
console.log(
  `after 403: status=${recovered.status} bytes=${recoveredBytes} ` +
    `playerCalls+${playerCalls - playerCallsAfterPrime} injections=${injected}`
);
if (recovered.status !== 206 || recoveredBytes !== 2048) {
  throw new Error("route did not recover from a synthetic 403");
}

// --- Scenario B: every upstream call is rejected -> bounded failure, clear error ---
globalThis.fetch = ((input, init) => {
  if (isGooglevideo(input)) return Promise.resolve(new Response("denied", { status: 403 }));
  return countingFetch(input, init);
}) as typeof fetch;

const t0 = Date.now();
const dead = await call("bytes=0-1023");
const body = await dead.json().catch(() => ({}));
console.log(
  `all-403: status=${dead.status} error=${body.error} took=${Date.now() - t0}ms`
);
if (dead.status !== 502) throw new Error(`expected a bounded 502, got ${dead.status}`);
if (Date.now() - t0 > 20000) throw new Error("failure handling took too long (retry loop?)");

globalThis.fetch = realFetch;
console.log("ROUTE_RECOVERY_OK");
