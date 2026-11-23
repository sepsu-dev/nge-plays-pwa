import { isPlaylistId } from "@/lib/player-state";

/**
 * App URLs.
 *
 * Menus (Home, Songs, Albums, Artists, Library, Queue, album/artist/playlist
 * detail) deliberately have NO route of their own: they all live in `/` as an
 * SPA. Switching menus only changes state, so there is no RSC fetch, no
 * page remount, and the player is never disconnected.
 *
 * `/room` remains the only real route because it is used as the share link for
 * "Listen Together" (`/room?room=CODE`), which must open directly / on refresh.
 */
export const ROUTES = {
  home: "/",
  room: "/room",
} as const;

/** Room share link. `origin` is optional so the result is an absolute URL when used in the browser. */
export function roomLink(code: string, origin = ""): string {
  return `${origin}${ROUTES.room}?room=${encodeURIComponent(code)}`;
}

const SEARCH_PARAM = "search";
const MAX_SEARCH_LEN = 150;

/** Read the search query from `?search=...` (used on boot/refresh). */
export function readSearchParam(search: string): string {
  return (new URLSearchParams(search).get(SEARCH_PARAM) || "").trim().slice(0, MAX_SEARCH_LEN);
}

/** Build a path + query without touching the Next router. */
export function searchPath(pathname: string, search: string, query: string | null): string {
  const params = new URLSearchParams(search);
  if (query) params.set(SEARCH_PARAM, query.trim().slice(0, MAX_SEARCH_LEN));
  else params.delete(SEARCH_PARAM);
  const qs = params.toString();
  return `${pathname}${qs ? `?${qs}` : ""}`;
}

/** Normalize a playlist id from URL/state. UUIDs are always lowercase; legacy ids are left
 *  as-is so they still match stored data (case-insensitive lookup). */
export function normalizePlaylistId(id: string): string {
  const trimmed = id.trim();
  return isPlaylistId(trimmed) ? trimmed.toLowerCase() : trimmed;
}
