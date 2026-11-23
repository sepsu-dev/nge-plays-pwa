"use client";

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { usePlayer } from "./player-provider";
import type { Track } from "@/actions/ytm-core";
import { AlbumsGrid, ArtistsGrid } from "@/components/library/browse-grids";
import { HomeDashboard } from "@/components/library/home-dashboard";
import { LibraryView } from "@/components/library/library-view";
import { TrackListView } from "@/components/library/track-list-view";
import { normalizePlaylistId } from "@/lib/routes";

/**
 * Main content per menu. Every menu renders on the same `/` page (SPA),
 * so switching menus only swaps state — no router navigation, no RSC fetch,
 * and no player remount.
 */
// useLayoutEffect does not run on the server; use useEffect during SSR to avoid a warning.
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export function MainContent() {
  const s = usePlayer();
  const contentRef = useRef<HTMLDivElement>(null);
  const prevTabRef = useRef<string | null>(null);

  // The menu transition animation uses the Web Animations API: it always replays on
  // tab change (no class-reflow dependency) and without remounting the subtree.
  useIsomorphicLayoutEffect(() => {
    if (prevTabRef.current === s.tab) return;
    prevTabRef.current = s.tab;

    const el = contentRef.current;
    if (!el) return;

    window.scrollTo({ top: 0, behavior: "auto" });

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (typeof el.animate !== "function") return;

    // Cancel the previous animation when the user switches menus quickly.
    el.getAnimations().forEach((anim) => anim.cancel());

    el.animate(
      [
        { opacity: 0, transform: "translate3d(0, 14px, 0) scale(0.99)" },
        { opacity: 1, transform: "translate3d(0, 0, 0) scale(1)" },
      ],
      {
        duration: 300,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        fill: "both",
      }
    );
  }, [s.tab]);

  const activeCustomPlaylist = useMemo(
    () => s.customPlaylists.find((p) => p.id === s.activeCustomPlId),
    [s.customPlaylists, s.activeCustomPlId]
  );

  const displayedTracks = useMemo((): Track[] => {
    switch (s.tab) {
      case "artists":
        return s.channelInfo ? s.channelTracks : s.results;
      case "albums":
        return s.activeAlbum ? s.activeAlbum.tracks : s.results;
      case "songs":
        return s.results;
      case "search":
        return s.searchResults;
      case "queue":
        return s.queue;
      case "liked":
        return s.liked;
      case "history":
        return s.history;
      case "playlist":
        return activeCustomPlaylist?.tracks || [];
      default:
        return s.results;
    }
  }, [
    s.tab,
    s.channelInfo,
    s.channelTracks,
    s.activeAlbum,
    s.results,
    s.searchResults,
    s.queue,
    s.liked,
    s.history,
    activeCustomPlaylist,
  ]);

  const recentTracks = useMemo((): Track[] => {
    const seen = new Set<string>();
    const merged: Track[] = [];
    for (const t of [...s.history, ...s.results, ...s.trending]) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      merged.push(t);
      if (merged.length >= 12) break;
    }
    return merged;
  }, [s.history, s.results, s.trending]);

  const listLoading =
    s.tab === "search"
      ? s.searching
      : s.tab === "playlist"
      ? // Never show an empty page: during boot or while the playlist id is not
        // found yet, keep showing the skeleton.
        s.hydrating || !activeCustomPlaylist
      : s.tab === "liked" || s.tab === "history"
      ? s.hydrating
      : s.tab === "queue"
      ? s.hydrating || (s.searching && s.queue.length === 0)
      : s.searching;

  return (
    <div ref={contentRef} className="flex-1 flex flex-col">
      {s.tab === "home" ? (
        <HomeDashboard
          loading={s.searching}
          albums={s.albums}
          trending={s.trending}
          recentTracks={recentTracks}
          artists={s.artists}
          currentTrack={s.currentTrack}
          isPlaying={s.isPlaying}
          onPlayTrack={s.playTrackNow}
          onTogglePlay={s.togglePlay}
          onOpenAlbum={s.openAlbum}
          onOpenArtist={s.openChannel}
          onOpenMenu={s.openTrackMenu}
          onSeeAllSongs={() => s.setTab("songs")}
          onSeeAllAlbums={() => s.setTab("albums")}
          onSeeAllArtists={() => s.setTab("artists")}
        />
      ) : s.tab === "albums" && !s.activeAlbum && s.openingTarget !== "album" ? (
        <AlbumsGrid loading={s.searching} albums={s.albums} onOpenAlbum={s.openAlbum} />
      ) : s.tab === "artists" && !s.channelInfo && s.openingTarget !== "artist" ? (
        <ArtistsGrid loading={s.searching} artists={s.artists} onOpenArtist={s.openChannel} />
      ) : s.tab === "library" ? (
        <LibraryView
          hydrating={s.hydrating}
          likedCount={s.liked.length}
          historyCount={s.history.length}
          customPlaylists={s.customPlaylists}
          onOpenLiked={() => s.setTab("liked")}
          onOpenHistory={() => s.setTab("history")}
          onOpenPlaylist={(id) => {
            const playlistId = normalizePlaylistId(id);
            s.setActiveCustomPlId(playlistId);
            s.navigate({ tab: "playlist", entityId: playlistId });
          }}
          onOpenNewPlaylist={() => s.openCreatePlaylist()}
        />
      ) : (
        <TrackListView
          tab={s.tab}
          searching={listLoading}
          displayedTracks={displayedTracks}
          albums={s.tab === "search" ? s.searchAlbums : s.albums}
          artists={s.tab === "search" ? s.searchArtists : s.artists}
          currentTrack={s.currentTrack}
          isPlaying={s.isPlaying}
          liked={s.liked}
          playlists={s.tab === "search" ? [] : s.playlists}
          activePlaylistId={s.tab === "search" ? "" : s.activePlaylistId}
          heroTitle={s.tab === "search" ? s.searchTitle : s.heroTitle}
          activeAlbum={s.activeAlbum}
          channelInfo={s.channelInfo}
          channelCont={s.channelCont}
          loadingMore={s.loadingMore}
          activeCustomPlaylist={activeCustomPlaylist}
          queueLength={s.queue.length}
          onBack={() => {
            s.setOpeningTarget(null);
            if (s.tab === "liked" || s.tab === "history" || s.tab === "playlist") {
              s.setTab("library");
              return;
            }
            s.setTab("albums");
          }}
          onPlayAll={s.playAll}
          onPlayTrack={s.playTrackNow}
          onTogglePlay={s.togglePlay}
          onOpenAlbum={s.openAlbum}
          onOpenArtist={s.openChannel}
          onSeeAllAlbums={s.tab === "search" ? undefined : () => s.setTab("albums")}
          onSeeAllArtists={s.tab === "search" ? undefined : () => s.setTab("artists")}
          onToggleLike={s.toggleLike}
          onOpenMenu={(track, e, customPlaylistId) => s.openTrackMenu(track, e, customPlaylistId)}
          onSelectPlaylist={s.handleSelectPlaylist}
          onDeleteCustomPlaylist={s.deleteCustomPlaylist}
          onRenameCustomPlaylist={s.openRenamePlaylist}
          onClearQueue={s.clearQueue}
          onClearHistory={s.clearHistory}
          onLoadMoreChannel={s.loadMoreChannel}
        />
      )}
    </div>
  );
}