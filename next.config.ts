import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  // Only applies over HTTPS; safe to send over HTTP (browsers ignore it).
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  poweredByHeader: false,
  // youtubei.js reads node builtins, JSON with import attributes and its own player
  // cache; keep it (and its deps) out of the server bundle.
  serverExternalPackages: ["youtubei.js"],
  experimental: {
    serverActions: {
      // Cap the Server Action payload size (default 1MB) to reduce DoS risk.
      bodySizeLimit: "256kb",
    },
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
      // ponytail: allow conditional revalidation (304) on JSON room responses without caching
      // them; the SSE stream sets its own no-cache headers at runtime.
      {
        source: "/api/room",
        headers: [
          { key: "Cache-Control", value: "private, max-age=0, must-revalidate" },
        ],
      },
      // The service worker must never be served stale, or a new build cannot take over.
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      // Audio streaming: tell intermediaries not to buffer or re-compress the body.
      // (Cache-Control is set by the route itself so each response can carry its own TTL.)
      {
        source: "/api/stream/:path*",
        headers: [{ key: "X-Accel-Buffering", value: "no" }],
      },
    ];
  },
};

export default nextConfig;
