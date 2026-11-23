"use client";

import { useCallback, useEffect, useRef } from "react";
import toast from "react-hot-toast";
import type { Track } from "@/actions/ytm-core";
import type { ClockStore } from "@/lib/playback-clock";
import {
  shouldAttemptBackgroundResume,
  type PendingResume,
} from "@/lib/player-state";
import {
  failureFromResponse,
  planStreamRecovery,
  readStreamFailure,
  recoveryNotice,
  type StreamFailure,
} from "@/lib/player-recovery";

/**
 * HTML5 audio playback.
 *
 * Audio bytes come from our own `/api/stream/<videoId>` proxy (youtubei.js
 * resolves + deciphers the googlevideo URL server-side), so there is no iframe,
 * no third-party script tag, and no YouTube branding in the page. A plain
 * <audio> element also means real background playback on mobile and full
 * Media Session / lock-screen support.
 *
 * The public surface mirrors the old YouTube iframe hook so callers did not change,
 * including YouTube's player-state numbering (0 ended, 1 playing, 2 paused, 3 buffering).
 */
const PLAYER_STATE = { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3 } as const;

const AUDIO_ELEMENT_ID = "nge-audio-player";
// localStorage-free cache buster: a retry must not reuse the browser's failed entry.
let retryToken = 0;

export function audioStreamUrl(videoId: string): string {
  return `/api/stream/${encodeURIComponent(videoId)}`;
}

interface UseAudioPlayerParams {
  currentTrack: Track | undefined;
  isPlaying: boolean;
  setIsPlaying: (v: boolean) => void;
  volume: number;
  muted: boolean;
  repeat: boolean;
  shuffle: boolean;
  clock: ClockStore;
  activeTrackIdRef: React.MutableRefObject<string>;
  queueRef: React.MutableRefObject<Track[]>;
  currentIndexRef: React.MutableRefObject<number>;
  pendingResumeRef: React.MutableRefObject<PendingResume | null>;
  onAdvanceTrack: (index: number, list: Track[]) => void;
  onTrackEnded?: () => boolean | void;
  onPlayerPlaying?: (currentTime: number) => void;
  onSaveSession: (
    overrides?: { currentTime?: number; isPlaying?: boolean },
    syncFlush?: boolean
  ) => void;
}

const MAX_PLAY_RETRIES = 2;
const MAX_SOURCE_RETRIES = 1;
// One toast per outage: every recovery attempt updates the same toast instead of stacking.
const RECOVERY_TOAST_ID = "stream-recovery";
// A playing element that cannot get data for this long is stuck, not buffering.
const STALL_TIMEOUT_MS = 20_000;

export function useAudioPlayer({
  currentTrack,
  isPlaying,
  setIsPlaying,
  volume,
  muted,
  repeat,
  shuffle,
  clock,
  activeTrackIdRef,
  queueRef,
  currentIndexRef,
  pendingResumeRef,
  onAdvanceTrack,
  onTrackEnded,
  onPlayerPlaying,
  onSaveSession,
}: UseAudioPlayerParams) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** video id currently bound to the element ("" when nothing is loaded) */
  const loadedVideoIdRef = useRef("");
  const readyRef = useRef(false);
  const loadingTargetIdRef = useRef<string | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  const wantAutoPlayRef = useRef(false);
  const manualPauseAtRef = useRef(0);
  const hiddenAtRef = useRef(0);
  const playRetryCountRef = useRef(0);
  const sourceRetryCountRef = useRef(0);
  /** Automatic recoveries for the current track (reset once it actually plays). */
  const autoRetryCountRef = useRef(0);
  /** True while a failure is being classified / a retry is pending. */
  const recoveringRef = useRef(false);
  /** One toast per outage instead of one per attempt. */
  const recoveryToastShownRef = useRef(false);
  /** Stall watchdog: when the element last had nothing to play. */
  const stalledSinceRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gestureUnlockRef = useRef<(() => void) | null>(null);

  const optsRef = useRef({ isPlaying, volume, muted, repeat, shuffle });
  optsRef.current = { isPlaying, volume, muted, repeat, shuffle };

  const callbacksRef = useRef({
    onAdvanceTrack,
    onTrackEnded,
    onPlayerPlaying,
    onSaveSession,
    setIsPlaying,
  });
  callbacksRef.current = {
    onAdvanceTrack,
    onTrackEnded,
    onPlayerPlaying,
    onSaveSession,
    setIsPlaying,
  };

  const syncPlayerAudio = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    const { volume: v, muted: m } = optsRef.current;
    el.volume = Math.min(1, Math.max(0, v / 100));
    el.muted = m;
  }, []);

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
  }, []);

  /**
   * Autoplay policies (and iOS's aggressive suspend) can reject play(). Retry shortly
   * after, then wait for the next user gesture instead of looping forever.
   */
  const attemptPlay = useCallback((el: HTMLAudioElement) => {
    syncPlayerAudio();
    const started = el.play();
    if (!started || typeof started.catch !== "function") return;
    void started.catch(() => {
      if (gestureUnlockRef.current) return;
      const unlock = () => {
        gestureUnlockRef.current = null;
        window.removeEventListener("pointerdown", unlock);
        window.removeEventListener("keydown", unlock);
        if (wantAutoPlayRef.current && audioRef.current) {
          void audioRef.current.play().catch(() => {});
        }
      };
      gestureUnlockRef.current = unlock;
      window.addEventListener("pointerdown", unlock, { once: true });
      window.addEventListener("keydown", unlock, { once: true });

      // Autoplay was blocked (no gesture yet). Reflect the real state in the UI instead of
      // showing a frozen "playing" track; playback resumes on the next tap/keypress.
      setTimeout(() => {
        const el = audioRef.current;
        if (!el || !el.paused) return;
        loadingTargetIdRef.current = null;
        callbacksRef.current.setIsPlaying(false);
      }, 900);
    });
  }, [syncPlayerAudio]);

  /**
   * Ask the proxy *why* a stream request failed. The route answers with JSON
   * (`error`/`message`) plus `x-stream-error` and, for a bot check, `retry-after`, which
   * is what lets playback back off for exactly as long as YouTube asks instead of dying.
   * A request that succeeds here means the local element failed (decode/offline), and the
   * policy retries it like any other transient problem.
   */
  const readFailure = useCallback(async (videoId: string): Promise<StreamFailure> => {
    try {
      const res = await fetch(audioStreamUrl(videoId), {
        headers: { range: "bytes=0-1" },
        cache: "no-store",
      });
      return await failureFromResponse(res);
    } catch {
      // Offline / aborted: no verdict at all, but worth retrying.
      return readStreamFailure({ status: 0 });
    }
  }, []);

  /**
   * Point the element at the proxy for `videoId`, seek to `startSeconds` once metadata
   * is in, and play when `autoPlay` is set.
   */
  const startSource = useCallback(
    (videoId: string, startSeconds: number, autoPlay: boolean, bustCache = false) => {
      const el = audioRef.current;
      if (!el) return;
      loadedVideoIdRef.current = videoId;
      loadingTargetIdRef.current = videoId;
      pendingSeekRef.current = Math.max(0, Number(startSeconds.toFixed(2))) || 0;
      wantAutoPlayRef.current = autoPlay;
      if (bustCache) retryToken += 1;
      el.src = `${audioStreamUrl(videoId)}${bustCache ? `?r=${retryToken}` : ""}`;
      el.load();
    },
    []
  );

  /**
   * Never give up while the cause can still heal.
   *
   * A reloaded source can fail for a reason that has nothing to do with the track: the
   * server's IP is being challenged by YouTube (bot check, `retry-after`), the URL landed
   * on a googlevideo host that only serves the first ~512KB, our own rate limiter kicked
   * in, or the network dropped. The proxy resolves a brand-new signed URL on every
   * attempt, so the player keeps the track loaded and reloads it after the delay the
   * server asked for. Only a verdict about the track stops playback.
   */
  const recoverStream = useCallback(
    async (videoId: string, resumeAt: number, wasPlaying: boolean) => {
      const failure = await readFailure(videoId);
      // The user may have paused, or another track may have been picked, while we asked.
      const stillWanted = () =>
        loadedVideoIdRef.current === videoId && wantAutoPlayRef.current;

      const plan = planStreamRecovery(failure, autoRetryCountRef.current);
      if (plan.action === "retry" && !wasPlaying) {
        // The track failed while the user was not listening: do not retry in the dark.
        recoveringRef.current = false;
        wantAutoPlayRef.current = false;
        callbacksRef.current.setIsPlaying(false);
        clock.set(resumeAt);
        callbacksRef.current.onSaveSession({ currentTime: resumeAt, isPlaying: false }, true);
        return;
      }
      if (plan.action === "retry") {
        // Stay in "recovering" while we wait: the element holds the dead source, so this is
        // what makes the UI/room sync report buffering instead of a finished track.
        recoveringRef.current = true;
        autoRetryCountRef.current += 1;
        wantAutoPlayRef.current = true;
        // Keep the UI on "playing": the track is still the active one and will resume.
        callbacksRef.current.setIsPlaying(true);
        if (!recoveryToastShownRef.current) {
          recoveryToastShownRef.current = true;
          toast.error(recoveryNotice(failure), { id: RECOVERY_TOAST_ID });
        }
        clearRetryTimer();
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null;
          // A new attempt is in flight from here on: a failure must be handled again.
          recoveringRef.current = false;
          if (!stillWanted()) return;
          // `?r=` makes the proxy resolve a fresh URL instead of serving the failed one.
          startSource(videoId, resumeAt, true, true);
        }, plan.delayMs);
        return;
      }

      // Terminal (removed, age-restricted, sign-in) or out of attempts: stop honestly.
      wantAutoPlayRef.current = false;
      recoveringRef.current = false;
      callbacksRef.current.setIsPlaying(false);
      clock.set(resumeAt);
      callbacksRef.current.onSaveSession({ currentTime: resumeAt, isPlaying: false }, true);
      toast.error(
        recoveryToastShownRef.current
          ? `Still unavailable: ${failure.message || "this track cannot be played"}`
          : failure.message || "This track cannot be played",
        { id: RECOVERY_TOAST_ID }
      );
    },
    [clearRetryTimer, clock, readFailure, startSource]
  );

  const loadVideo = useCallback(
    (videoId: string, startSeconds = 0, autoPlay = true) => {
      manualPauseAtRef.current = 0;
      clearRetryTimer();
      playRetryCountRef.current = 0;
      sourceRetryCountRef.current = 0;
      autoRetryCountRef.current = 0;
      recoveringRef.current = false;
      recoveryToastShownRef.current = false;
      stalledSinceRef.current = 0;
      clock.set(startSeconds, 0);

      const el = audioRef.current;
      if (!el || !el.getAttribute("src")) {
        pendingResumeRef.current = { videoId, seekTo: startSeconds, autoPlay };
        return;
      }
      // Same track already loaded (room resync, repeat): keep the buffer, just reposition.
      if (loadedVideoIdRef.current === videoId && !el.error) {
        if (startSeconds > 0 && el.readyState >= 1) {
          el.currentTime = Math.min(startSeconds, Math.max(0, (el.duration || startSeconds) - 0.25));
          clock.set(el.currentTime);
        }
        if (autoPlay) attemptPlay(el);
        else el.pause();
        return;
      }
      startSource(videoId, startSeconds, autoPlay);
    },
    [attemptPlay, clearRetryTimer, clock, pendingResumeRef, startSource]
  );

  const playVideo = useCallback(() => {
    manualPauseAtRef.current = 0;
    wantAutoPlayRef.current = true;
    playRetryCountRef.current = 0;
    // Pressing play is a fresh start for the recovery budget: if this track already failed
    // (and used up its attempts), the user asking again must retry instead of re-using the
    // old verdict.
    sourceRetryCountRef.current = 0;
    autoRetryCountRef.current = 0;
    recoveringRef.current = false;
    recoveryToastShownRef.current = false;
    stalledSinceRef.current = 0;
    clearRetryTimer();
    if (pendingResumeRef.current) pendingResumeRef.current.autoPlay = true;

    const el = audioRef.current;
    if (!el || !el.getAttribute("src")) return;
    // The previous source is dead (or was abandoned while we waited to retry): reload it.
    if (el.error) {
      startSource(
        loadedVideoIdRef.current,
        Number.isFinite(el.currentTime) ? el.currentTime : 0,
        true,
        true
      );
      return;
    }
    attemptPlay(el);
  }, [attemptPlay, clearRetryTimer, pendingResumeRef, startSource]);

  const pauseVideo = useCallback(() => {
    manualPauseAtRef.current = Date.now();
    wantAutoPlayRef.current = false;
    clearRetryTimer();
    if (pendingResumeRef.current) pendingResumeRef.current.autoPlay = false;
    audioRef.current?.pause();
  }, [clearRetryTimer, pendingResumeRef]);

  const togglePlay = useCallback(() => {
    if (optsRef.current.isPlaying) pauseVideo();
    else playVideo();
  }, [pauseVideo, playVideo]);

  const seekTo = useCallback(
    (val: number) => {
      clock.set(val);
      const el = audioRef.current;
      if (el && el.getAttribute("src")) {
        const duration = Number.isFinite(el.duration) ? el.duration : 0;
        const target = duration > 0 ? Math.min(Math.max(0, val), duration) : Math.max(0, val);
        if (el.readyState >= 1) el.currentTime = target;
        // Metadata not ready yet: apply the seek as soon as it arrives.
        else pendingSeekRef.current = target;
      } else if (pendingResumeRef.current) {
        pendingResumeRef.current.seekTo = val;
      }

      const dur = clock.getSnapshot().duration;
      if (dur > 0 && "mediaSession" in navigator && navigator.mediaSession.setPositionState) {
        try {
          navigator.mediaSession.setPositionState({
            duration: dur,
            playbackRate: 1,
            position: Math.min(Math.max(0, val), dur),
          });
        } catch {}
      }
      callbacksRef.current.onSaveSession({ currentTime: val });
    },
    [clock, pendingResumeRef]
  );

  const setPlayerVolume = useCallback((val: number) => {
    const el = audioRef.current;
    if (!el) return;
    el.muted = false;
    el.volume = Math.min(1, Math.max(0, val / 100));
  }, []);

  const setPlayerMuted = useCallback((mute: boolean, fallbackVol: number) => {
    const el = audioRef.current;
    if (!el) return;
    el.muted = mute;
    if (!mute) el.volume = Math.min(1, Math.max(0, (fallbackVol || 80) / 100));
  }, []);

  /** Mirrors YT.PlayerState so room sync code keeps working unchanged. */
  const getPlayerState = useCallback((): number => {
    const el = audioRef.current;
    if (!readyRef.current || !el || !el.getAttribute("src")) return -1;
    // Mid-recovery the element still holds the dead source: report "buffering" so the UI
    // and room sync say "loading", not "stopped".
    if (recoveringRef.current) return PLAYER_STATE.BUFFERING;
    if (el.error) return -1;
    if (el.ended) return PLAYER_STATE.ENDED;
    if (el.paused) return PLAYER_STATE.PAUSED;
    if (el.readyState < 3) return PLAYER_STATE.BUFFERING;
    return PLAYER_STATE.PLAYING;
  }, []);

  // Create the singleton element once, wire its events, and hand it back to the browser
  // on unmount (full page unload only — the provider lives in the root layout).
  useEffect(() => {
    const existing = document.getElementById(AUDIO_ELEMENT_ID) as HTMLAudioElement | null;
    const audio = existing ?? document.createElement("audio");
    if (!existing) {
      audio.id = AUDIO_ELEMENT_ID;
      audio.setAttribute("playsinline", "");
      audio.setAttribute("webkit-playsinline", "");
      audio.preload = "auto";
      audio.style.display = "none";
      document.body.appendChild(audio);
    }
    audioRef.current = audio;
    readyRef.current = true;
    syncPlayerAudio();

    const handleLoadedMetadata = () => {
      const seek = pendingSeekRef.current;
      pendingSeekRef.current = null;
      if (seek && seek > 0 && Number.isFinite(audio.duration)) {
        audio.currentTime = Math.min(seek, Math.max(0, audio.duration - 0.25));
      }
      if (wantAutoPlayRef.current) attemptPlay(audio);
      const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      if (duration > 0) clock.set(audio.currentTime, duration);
    };

    const handleCanPlay = () => {
      sourceRetryCountRef.current = 0;
      if (wantAutoPlayRef.current && audio.paused) attemptPlay(audio);
    };

    const handlePlaying = () => {
      loadingTargetIdRef.current = null;
      wantAutoPlayRef.current = true;
      playRetryCountRef.current = 0;
      hiddenAtRef.current = 0;
      sourceRetryCountRef.current = 0;
      // Bytes are flowing again: whatever was wrong is over, so the next failure starts
      // with a full budget and the "retrying" toast is not left on screen.
      autoRetryCountRef.current = 0;
      recoveringRef.current = false;
      stalledSinceRef.current = 0;
      if (recoveryToastShownRef.current) {
        recoveryToastShownRef.current = false;
        toast.dismiss(RECOVERY_TOAST_ID);
      }
      syncPlayerAudio();
      callbacksRef.current.setIsPlaying(true);
      const current = audio.currentTime || 0;
      clock.set(current, Number.isFinite(audio.duration) ? audio.duration : 0);
      // Report only once the pending seek applied, so a room user reports a sane position.
      if (!pendingSeekRef.current) callbacksRef.current.onPlayerPlaying?.(current);
    };

    const handlePause = () => {
      // Fires while swapping sources, and while the source is dead: an errored or
      // recovering element is not "paused by the user", and reacting to it here would
      // cancel the automatic recovery before it gets a chance to reload.
      if (loadingTargetIdRef.current || audio.ended || audio.error || recoveringRef.current) return;

      const now = Date.now();
      const isHidden = document.visibilityState === "hidden";
      if (isHidden && !hiddenAtRef.current) hiddenAtRef.current = now;

      const retryable = shouldAttemptBackgroundResume({
        isHidden,
        wasPlaying: optsRef.current.isPlaying,
        hiddenAtMs: hiddenAtRef.current,
        manualPauseAtMs: manualPauseAtRef.current,
        nowMs: now,
        retryCount: playRetryCountRef.current,
        maxRetries: MAX_PLAY_RETRIES,
      });
      if (retryable) {
        const attempt = playRetryCountRef.current;
        playRetryCountRef.current = attempt + 1;
        clearRetryTimer();
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null;
          if (!wantAutoPlayRef.current || !optsRef.current.isPlaying) return;
          attemptPlay(audio);
        }, attempt === 0 ? 250 : 700);
        return;
      }

      clearRetryTimer();
      wantAutoPlayRef.current = false;
      callbacksRef.current.setIsPlaying(false);
      const current = audio.currentTime || 0;
      clock.set(current);
      callbacksRef.current.onSaveSession({ currentTime: current, isPlaying: false }, true);
    };

    const handleEnded = () => {
      loadingTargetIdRef.current = null;
      wantAutoPlayRef.current = false;
      clearRetryTimer();
      if (callbacksRef.current.onTrackEnded?.() === true) return;

      const { repeat: r, shuffle: sh } = optsRef.current;
      const q = queueRef.current;
      const i = currentIndexRef.current;
      if (r) {
        audio.currentTime = 0;
        wantAutoPlayRef.current = true;
        attemptPlay(audio);
        return;
      }
      if (q.length > 0) {
        callbacksRef.current.onAdvanceTrack(
          sh ? Math.floor(Math.random() * q.length) : (i + 1) % q.length,
          q
        );
      }
    };

    const handleError = () => {
      loadingTargetIdRef.current = null;
      const videoId = loadedVideoIdRef.current;
      const resumeAt = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
      const wasPlaying = wantAutoPlayRef.current || optsRef.current.isPlaying;

      if (!videoId) {
        wantAutoPlayRef.current = false;
        callbacksRef.current.setIsPlaying(false);
        toast.error("This track cannot be played");
        return;
      }

      // One silent retry first: it costs nothing, and a stale googlevideo URL or a dropped
      // connection is usually cured by a freshly resolved one.
      if (sourceRetryCountRef.current < MAX_SOURCE_RETRIES) {
        sourceRetryCountRef.current += 1;
        startSource(videoId, resumeAt, wasPlaying, true);
        return;
      }

      // Still failing: find out why, then keep the track alive while the cause can heal
      // (bot check, restricted host, rate limit, flaky network) instead of dropping the
      // whole queue on one bad minute.
      if (recoveringRef.current) return;
      recoveringRef.current = true;
      void recoverStream(videoId, resumeAt, wasPlaying);
    };

    audio.addEventListener("loadedmetadata", handleLoadedMetadata);
    audio.addEventListener("canplay", handleCanPlay);
    audio.addEventListener("playing", handlePlaying);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("error", handleError);

    return () => {
      audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
      audio.removeEventListener("canplay", handleCanPlay);
      audio.removeEventListener("playing", handlePlaying);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("error", handleError);
      clearRetryTimer();
      if (gestureUnlockRef.current) {
        window.removeEventListener("pointerdown", gestureUnlockRef.current);
        gestureUnlockRef.current = null;
      }
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      readyRef.current = false;
      loadedVideoIdRef.current = "";
      audioRef.current = null;
    };
  }, [
    attemptPlay,
    clearRetryTimer,
    clock,
    currentIndexRef,
    queueRef,
    recoverStream,
    startSource,
    syncPlayerAudio,
  ]);

  // Bind the first/current track (restored session, room snapshot, or a fresh pick).
  useEffect(() => {
    const trackId = currentTrack?.id;
    if (!trackId || !readyRef.current) return;
    if (loadedVideoIdRef.current === trackId) return;

    const resume = pendingResumeRef.current;
    const matchesResume = resume?.videoId === trackId;
    const startSec = matchesResume ? Math.max(0, resume.seekTo) : 0;
    const autoPlay = matchesResume ? resume.autoPlay : optsRef.current.isPlaying;
    if (matchesResume) pendingResumeRef.current = null;
    // A new track starts with a clean recovery budget, never inheriting the previous one.
    sourceRetryCountRef.current = 0;
    autoRetryCountRef.current = 0;
    recoveringRef.current = false;
    recoveryToastShownRef.current = false;
    stalledSinceRef.current = 0;
    startSource(trackId, startSec, autoPlay);
  }, [currentTrack?.id, pendingResumeRef, startSource]);

  // Keep the element in sync with the app's volume/mute controls.
  useEffect(() => {
    syncPlayerAudio();
  }, [volume, muted, syncPlayerAudio]);

  /**
   * A dropped upstream connection does not always fire `error`: the element can sit at
   * "playing, no data" indefinitely (common on mobile after a network switch or when the
   * proxy's upstream stalls). Watch for it and reload from the current position, so the
   * track continues instead of freezing for good.
   */
  useEffect(() => {
    const timer = setInterval(() => {
      const el = audioRef.current;
      if (!el || !el.getAttribute("src") || el.error) return;
      if (!wantAutoPlayRef.current || el.paused || el.ended) {
        stalledSinceRef.current = 0;
        return;
      }
      // A reload/seek already has a fresh request in flight; `error` handles real failures.
      if (loadingTargetIdRef.current || retryTimerRef.current) return;
      if (el.readyState >= 3) {
        stalledSinceRef.current = 0;
        return;
      }
      const now = Date.now();
      if (!stalledSinceRef.current) {
        stalledSinceRef.current = now;
        return;
      }
      if (now - stalledSinceRef.current < STALL_TIMEOUT_MS) return;
      stalledSinceRef.current = 0;
      const at = Number.isFinite(el.currentTime) ? el.currentTime : 0;
      console.warn("[audio] no data for", STALL_TIMEOUT_MS, "ms; reloading from", at);
      startSource(loadedVideoIdRef.current, at, true, true);
    }, 5000);
    return () => clearInterval(timer);
  }, [startSource]);

  // Advance the shared clock from the element's real position.
  useEffect(() => {
    if (!isPlaying) return;
    let lastPosSyncMs = 0;
    let lastSaveMs = Date.now();

    const timer = setInterval(() => {
      const el = audioRef.current;
      if (!el || !el.getAttribute("src")) return;
      if (loadingTargetIdRef.current || pendingSeekRef.current !== null) return;
      if (el.paused || el.ended) return;

      const current = el.currentTime || 0;
      const duration = Number.isFinite(el.duration) ? el.duration : 0;
      clock.set(current, duration > 0 ? duration : undefined);

      const now = Date.now();
      if (
        duration > 0 &&
        now - lastPosSyncMs >= 1000 &&
        "mediaSession" in navigator &&
        navigator.mediaSession.setPositionState
      ) {
        lastPosSyncMs = now;
        try {
          navigator.mediaSession.setPositionState({
            duration,
            playbackRate: el.playbackRate || 1,
            position: Math.min(Math.max(0, current), duration),
          });
        } catch {}
      }

      if (now - lastSaveMs >= 6000) {
        lastSaveMs = now;
        callbacksRef.current.onSaveSession({ currentTime: current, isPlaying: true });
      }
    }, 250);

    return () => clearInterval(timer);
  }, [isPlaying, clock]);

  // Flush the position when the page is being backgrounded/closed.
  useEffect(() => {
    const flush = () => {
      const el = audioRef.current;
      if (!el || !el.getAttribute("src")) return;
      const current = Number.isFinite(el.currentTime) ? el.currentTime : 0;
      const playing = !el.paused && !el.ended;
      clock.set(current, Number.isFinite(el.duration) ? el.duration : undefined);
      callbacksRef.current.onSaveSession({ currentTime: current, isPlaying: playing }, true);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        if (!hiddenAtRef.current) hiddenAtRef.current = Date.now();
        flush();
        return;
      }
      hiddenAtRef.current = 0;
      playRetryCountRef.current = 0;
      const el = audioRef.current;
      if (!el) return;
      if (el.paused && !el.ended && wantAutoPlayRef.current) attemptPlay(el);
    };

    window.addEventListener("beforeunload", flush);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [attemptPlay, clock]);

  return {
    loadVideo,
    playVideo,
    pauseVideo,
    togglePlay,
    seekTo,
    setPlayerVolume,
    setPlayerMuted,
    getPlayerState,
  };
}
