import { AudioSourceError, forgetAudioSource, resolveAudioSource, type AudioSource } from "./audio-source";
import { resetInnertube } from "./innertube";

/**
 * Recovery path for an upstream 401/403/410.
 *
 * A googlevideo URL can go stale in two different ways: the signed URL expired, or the
 * player script that deciphered it is too old (YouTube rotated its challenge). The
 * first is fixed by resolving a fresh URL without the client that just failed; the
 * second only by rebuilding the Innertube session.
 *
 * An <audio> element fires several range requests at once, so every recovery for a
 * video is coalesced: concurrent failures share one attempt instead of each asking
 * YouTube for a new URL (which gets a whole stream blocked by rate limiting).
 */
export interface RecoveryDeps {
  forget: (videoId: string) => void;
  resolve: (
    videoId: string,
    options: { refresh: boolean; exclude: string[] }
  ) => Promise<AudioSource>;
  reset: () => Promise<void>;
  log?: (message: string) => void;
}

export function createRecovery({
  forget,
  resolve,
  reset,
  log = () => {},
}: RecoveryDeps): (videoId: string, failedClient?: string) => Promise<AudioSource> {
  const inflight = new Map<string, Promise<AudioSource>>();

  return function recover(videoId: string, failedClient?: string): Promise<AudioSource> {
    const existing = inflight.get(videoId);
    if (existing) return existing;

    const exclude = failedClient ? [failedClient] : [];
    const task = (async () => {
      forget(videoId);
      try {
        const source = await resolve(videoId, { refresh: true, exclude });
        log(`recovered ${videoId} with ${source.client}`);
        return source;
      } catch (err) {
        // A definite verdict is not worth a session rebuild; a stale player script is.
        if (
          err instanceof AudioSourceError &&
          err.code !== "resolve-failed" &&
          err.code !== "upstream-restricted"
        ) {
          throw err;
        }
        log(`rebuilding session to recover ${videoId}`);
        await reset();
        forget(videoId);
        return resolve(videoId, { refresh: true, exclude });
      }
    })().finally(() => {
      inflight.delete(videoId);
    });

    inflight.set(videoId, task);
    return task;
  };
}

export const recoverAudioSource = createRecovery({
  forget: forgetAudioSource,
  resolve: resolveAudioSource,
  reset: resetInnertube,
  log: (message) => console.warn(`[stream] ${message}`),
});
