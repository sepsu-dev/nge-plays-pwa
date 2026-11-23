/**
 * Optional PO token provider.
 *
 * YouTube serves only the first ~512 KB of an unprotected googlevideo URL: the head range
 * answers 206, every deeper range answers 403, which is what the stream route reports as
 * `upstream-restricted` (502). A PO token lifts that limit, but minting one means running
 * BotGuard in a browser-like environment, which this server deliberately does not do.
 *
 * Instead, any process speaking the bgutil-ytdlp-pot-provider protocol can supply tokens:
 *
 *   POST <base>/get_pot  {"content_binding": "<video id>"}
 *     -> {"poToken": "...", "contentBinding": "...", "expiresAt": 1712345678}
 *
 * Set `YT_PO_TOKEN_PROVIDER_URL` (e.g. `http://127.0.0.1:4416`) to enable it. Without it
 * (or when the provider fails) resolution simply continues tokenless, exactly as before.
 */
const PROVIDER_TIMEOUT_MS = 15_000;
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MAX_CACHED_TOKENS = 200;

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokens = new Map<string, CachedToken>();
const inflight = new Map<string, Promise<string | null>>();

export function poTokenProviderUrl(): string {
  return (process.env.YT_PO_TOKEN_PROVIDER_URL || "").trim().replace(/\/+$/, "");
}

/**
 * What a token is bound to. Player tokens are bound to the video id, but `web_music`
 * (`YTMUSIC` here) uses a session token, i.e. the visitor data this server runs with.
 * Without that visitor data the provider cannot mint a usable token for it.
 */
export function potContentBinding(videoId: string, client: string): string | null {
  if (client === "YTMUSIC") return process.env.YOUTUBE_VISITOR_DATA?.trim() || null;
  return videoId;
}

/** Expiry from the provider, tolerating both seconds and milliseconds. */
export function tokenExpiry(value: unknown, now = Date.now()): number {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return now + DEFAULT_TTL_MS;
  return Math.min(raw < 1e12 ? raw * 1000 : raw, now + DEFAULT_TTL_MS);
}

function remember(key: string, token: string, expiresAt: number): void {
  if (tokens.size >= MAX_CACHED_TOKENS) {
    const oldest = tokens.keys().next().value;
    if (oldest) tokens.delete(oldest);
  }
  tokens.set(key, { token, expiresAt });
}

async function requestToken(baseUrl: string, contentBinding: string): Promise<string | null> {
  const res = await fetch(`${baseUrl}/get_pot`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ content_binding: contentBinding }),
    cache: "no-store",
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`provider responded with ${res.status}`);
  }
  const body = (await res.json()) as { poToken?: unknown; expiresAt?: unknown };
  const token = typeof body.poToken === "string" ? body.poToken.trim() : "";
  if (!token) throw new Error("provider returned an empty poToken");
  remember(`${contentBinding}`, token, tokenExpiry(body.expiresAt));
  return token;
}

/**
 * PO token for `contentBinding`, or `null` when no provider is configured / it has nothing
 * usable. Tokens are cached until shortly before they expire, and concurrent callers share
 * one minting request so a burst of range requests cannot stampede the provider.
 */
export async function providerPoToken(contentBinding: string | null): Promise<string | null> {
  if (!contentBinding) return null;
  const baseUrl = poTokenProviderUrl();
  if (!baseUrl) return null;

  const cached = tokens.get(contentBinding);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const pending = inflight.get(contentBinding);
  if (pending) return pending;

  const task = requestToken(baseUrl, contentBinding)
    .catch((err) => {
      console.warn(
        `[po-token] provider at ${baseUrl} failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    })
    .finally(() => {
      inflight.delete(contentBinding);
    });

  inflight.set(contentBinding, task);
  return task;
}

/** Test/ops hook: drop cached tokens (e.g. after restarting the provider). */
export function forgetPoTokens(): void {
  tokens.clear();
}
