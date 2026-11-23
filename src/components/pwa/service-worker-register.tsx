"use client";

import { useEffect } from "react";

/**
 * Registers the service worker that makes the app installable and lets it open
 * offline. Registration is deferred until after hydration and skipped outside
 * production builds so `next dev` never serves a stale shell.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    let cancelled = false;

    const register = async () => {
      try {
        const registration = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
          updateViaCache: "none",
        });
        if (cancelled) return;

        // Activate a waiting worker right away: the shell is versioned, so the page
        // only needs a refresh, not a multi-tab handshake.
        if (registration.waiting) registration.waiting.postMessage("SKIP_WAITING");

        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (installing.state === "installed" && navigator.serviceWorker.controller) {
              installing.postMessage("SKIP_WAITING");
            }
          });
        });
      } catch (err) {
        console.warn("Service worker registration failed:", err);
      }
    };

    if (document.readyState === "complete") void register();
    else window.addEventListener("load", register, { once: true });

    return () => {
      cancelled = true;
      window.removeEventListener("load", register);
    };
  }, []);

  return null;
}
