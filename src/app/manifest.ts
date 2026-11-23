import type { MetadataRoute } from "next";

/**
 * Web app manifest (served at /manifest.webmanifest by Next).
 *
 * `display: standalone` + icons + start_url are what make the app installable on
 * Android/Chrome, while iOS uses the apple-touch-icon and apple-mobile-web-app-*
 * metadata declared in the root layout.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Nge-Plays — Music Player",
    short_name: "Nge-Plays",
    description:
      "A simple, ad-free YouTube Music web player. Search, explore, view synced lyrics, and listen directly from YouTube.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    display_override: ["standalone", "minimal-ui"],
    orientation: "portrait-primary",
    background_color: "#0D0F14",
    theme_color: "#FFD014",
    categories: ["music", "entertainment"],
    lang: "en",
    dir: "ltr",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    shortcuts: [
      { name: "Listen Together", url: "/room", description: "Join or host a listening room" },
    ],
  };
}
