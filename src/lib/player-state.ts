import type { Track } from "@/actions/ytm-core";

export interface CustomPlaylist {
  id: string;
  name: string;
  tracks: Track[];
}

/** The playlist id format used in URLs: an RFC 4122 UUID (v1-v5). */
const PLAYLIST_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True when `id` is already a UUID — the only id shape that is safe for URLs. */
export function isPlaylistId(id: string): boolean {
  return PLAYLIST_UUID_RE.test(id.trim());
}

/**
 * Playlist ids are UUIDs so URLs do not depend on the name:
 * renaming a playlist does not change the link, and two playlists with the same name
 * still get different ids. Example: /library/playlist/9f1c2a3e-...
 *
 * Legacy playlists already stored with a non-UUID id (e.g. `pl_<timestamp>`)
 * are migrated via migratePlaylistIds on boot.
 */
export function createPlaylistId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for old browsers / non-secure contexts (randomUUID needs a secure context).
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Upgrade all legacy (non-UUID) playlist ids to UUIDs without changing playlist contents.
 * `aliases` maps the old id -> new UUID, so old links/bookmarks still
 * resolve and redirect to the UUID URL.
 */
export function migratePlaylistIds(
  playlists: CustomPlaylist[],
  makeId: () => string = createPlaylistId
): { playlists: CustomPlaylist[]; aliases: Record<string, string> } {
  const aliases: Record<string, string> = {};
  const used = new Set<string>();
  let changed = false;

  const next = playlists.map((playlist) => {
    const rawId = typeof playlist?.id === "string" ? playlist.id.trim() : "";
    const valid = isPlaylistId(rawId);
    let id = valid ? rawId.toLowerCase() : makeId();
    while (used.has(id)) id = makeId();
    used.add(id);

    if (!valid && rawId) aliases[rawId.toLowerCase()] = id;
    if (id !== playlist.id) changed = true;
    return id === playlist.id ? playlist : { ...playlist, id };
  });

  return { playlists: changed ? next : playlists, aliases };
}

export interface TrackMenuState {
  track: Track;
  x: number;
  y: number;
  customPlaylistId?: string;
  playlistOnly?: boolean;
}

export type TabId =
  | "home"
  | "songs"
  | "albums"
  | "artists"
  | "liked"
  | "history"
  | "queue"
  | "playlist"
  | "library"
  | "search";

export interface SessionSnapshot {
  queue: Track[];
  currentIndex: number;
  activeTrackId?: string;
  currentTime: number;
  isPlaying: boolean;
  volume: number;
  muted: boolean;
  repeat: boolean;
  shuffle: boolean;
  tab: TabId;
  updatedAt?: number;
}

export interface PendingResume {
  videoId: string;
  seekTo: number;
  autoPlay: boolean;
}

export function resolveTrackSwitch(
  track: Track,
  sourceList: Track[] | undefined,
  currentQueue: Track[]
): { queue: Track[]; index: number } {
  const base = sourceList?.length ? sourceList : currentQueue;
  const idx = base.findIndex((t) => t.id === track.id);
  if (idx !== -1) {
    return { queue: base, index: idx };
  }
  return { queue: [track, ...base], index: 0 };
}

export function clearQueueKeepCurrent(
  queue: Track[],
  currentIndex: number
): { queue: Track[]; index: number } {
  const current = queue[currentIndex];
  return {
    queue: current ? [current] : [],
    index: 0,
  };
}

export function resolveExploreFallbackQueue(
  currentQueue: Track[],
  hasUserPlayback: boolean,
  exploreTracks: Track[]
): Track[] {
  if (hasUserPlayback || currentQueue.length > 0) return currentQueue;
  return exploreTracks;
}

export function resolveRestoredIndex(session: Pick<SessionSnapshot, "queue" | "currentIndex" | "activeTrackId">): number {
  if (!session.queue.length) return 0;
  const clamped = Math.min(Math.max(0, Number(session.currentIndex) || 0), session.queue.length - 1);
  if (session.activeTrackId && session.queue[clamped]?.id !== session.activeTrackId) {
    const matched = session.queue.findIndex((t) => t.id === session.activeTrackId);
    if (matched !== -1) return matched;
  }
  return clamped;
}

export function shouldAcceptPlayerEvent(
  eventVideoId: string | undefined,
  activeTrackId: string,
  loadingTargetId: string | null,
  eventState?: number,
  seenTransition?: boolean
): boolean {
  if (!activeTrackId) return false;
  if (eventVideoId && eventVideoId !== activeTrackId) return false;
  if (loadingTargetId) {
    if (eventVideoId === loadingTargetId) return true;
    // Fallback if YouTube's getVideoData() briefly returns empty after buffering -> playing
    if (!eventVideoId && seenTransition && eventState === 1) return true;
    return false;
  }
  return true;
}

type ReadyAction =
  | { type: "none" }
  | { type: "load"; videoId: string; seekTo: number }
  | { type: "cue"; videoId: string; seekTo: number }
  | { type: "resume_initial"; seekTo: number; autoPlay: boolean };

export function resolveReadyAction(
  initialVideoId: string,
  pending: PendingResume | null
): ReadyAction {
  if (!pending) return { type: "none" };
  if (pending.videoId !== initialVideoId) {
    return pending.autoPlay
      ? { type: "load", videoId: pending.videoId, seekTo: pending.seekTo }
      : { type: "cue", videoId: pending.videoId, seekTo: pending.seekTo };
  }
  return {
    type: "resume_initial",
    seekTo: pending.seekTo,
    autoPlay: pending.autoPlay,
  };
}

export function shouldAttemptBackgroundResume({
  isHidden,
  wasPlaying,
  hiddenAtMs,
  manualPauseAtMs,
  nowMs,
  retryCount,
  maxRetries = 4,
}: {
  isHidden: boolean;
  wasPlaying: boolean;
  hiddenAtMs: number;
  manualPauseAtMs: number;
  nowMs: number;
  retryCount: number;
  maxRetries?: number;
}): boolean {
  if (!isHidden || !wasPlaying || retryCount >= maxRetries) return false;
  if (manualPauseAtMs > 0 && nowMs - manualPauseAtMs < 1500) return false;
  return hiddenAtMs > 0 && nowMs - hiddenAtMs < 5000;
}

export function shouldRestorePlayerAudio(
  playerMuted: boolean,
  playerVolume: number,
  userMuted: boolean,
  userVolume: number
): boolean {
  if (userMuted) return false;
  return playerMuted || (userVolume > 0 && playerVolume <= 0);
}
