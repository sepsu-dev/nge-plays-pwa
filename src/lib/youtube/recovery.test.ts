import assert from "node:assert/strict";
import { AudioSourceError, type AudioSource } from "./audio-source";
import { createRecovery } from "./recovery";

const makeSource = (videoId: string, client: AudioSource["client"]): AudioSource => ({
  videoId,
  url: `https://example.test/${client}`,
  mimeType: "audio/mp4",
  contentLength: 1000,
  client,
  itag: 140,
  expiresAt: Date.now() + 60_000,
});

// 1. First failure is repaired by re-resolving without the client that failed.
{
  const calls: { exclude: string[]; refresh: boolean }[] = [];
  const recover = createRecovery({
    forget: () => {},
    resolve: async (_id, options) => {
      calls.push({ exclude: [...options.exclude], refresh: options.refresh });
      return makeSource("vid", "IOS");
    },
    reset: async () => {
      throw new Error("session rebuild should not be needed");
    },
  });

  const source = await recover("vid", "YTMUSIC");
  assert.equal(source.client, "IOS");
  assert.deepEqual(calls, [{ exclude: ["YTMUSIC"], refresh: true }]);
}

// 2. A generic resolve failure (stale player script) escalates to a session rebuild.
{
  const events: string[] = [];
  let attempt = 0;
  const recover = createRecovery({
    forget: () => events.push("forget"),
    resolve: async () => {
      attempt += 1;
      if (attempt === 1) throw new AudioSourceError("resolve-failed", "stale player");
      return makeSource("vid", "YTMUSIC");
    },
    reset: async () => {
      events.push("reset");
    },
  });

  const source = await recover("vid", "YTMUSIC");
  assert.equal(source.client, "YTMUSIC");
  assert.deepEqual(events, ["forget", "reset", "forget"]);
}

// 3. A definite verdict (age restriction) must not trigger a rebuild.
{
  let reset = false;
  const recover = createRecovery({
    forget: () => {},
    resolve: async () => {
      throw new AudioSourceError("age-restricted", "age restricted");
    },
    reset: async () => {
      reset = true;
    },
  });

  await assert.rejects(() => recover("vid", "IOS"), (err: unknown) => {
    return err instanceof AudioSourceError && err.code === "age-restricted";
  });
  assert.equal(reset, false, "session rebuild is pointless for an age-restricted track");
}

// 3b. A range restriction is usually a stale player script, so it *does* rebuild.
{
  const events: string[] = [];
  let attempt = 0;
  const recover = createRecovery({
    forget: () => events.push("forget"),
    resolve: async () => {
      attempt += 1;
      if (attempt === 1) throw new AudioSourceError("upstream-restricted", "ranges (206/403/403)");
      return makeSource("vid", "IOS");
    },
    reset: async () => {
      events.push("reset");
    },
  });

  const source = await recover("vid", "YTMUSIC");
  assert.equal(source.client, "IOS");
  assert.deepEqual(events, ["forget", "reset", "forget"]);
}

// 3c. A bot check is IP-level and clears itself: rebuilding the session cannot help, and
// retrying into it is what deepens the block.
{
  let reset = false;
  const recover = createRecovery({
    forget: () => {},
    resolve: async () => {
      throw new AudioSourceError("bot-check", "Login untuk mengonfirmasi bahwa Anda bukan bot", {
        transient: true,
      });
    },
    reset: async () => {
      reset = true;
    },
  });

  await assert.rejects(() => recover("vid", "IOS"), (err: unknown) => {
    return err instanceof AudioSourceError && err.code === "bot-check";
  });
  assert.equal(reset, false, "a bot check is not fixed by rebuilding the Innertube session");
}

// 4. Concurrent 403s from one <audio> element share a single recovery attempt.
{
  let resolves = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const recover = createRecovery({
    forget: () => {},
    resolve: async () => {
      resolves += 1;
      await gate;
      return makeSource("vid", "IOS");
    },
    reset: async () => {},
  });

  const pending = Array.from({ length: 5 }, () => recover("vid", "YTMUSIC"));
  assert.equal(resolves, 1, "only one resolve should be in flight per video");
  release?.();
  const sources = await Promise.all(pending);
  assert.equal(resolves, 1);
  assert.ok(sources.every((source) => source.client === "IOS"));

  // A later failure starts a new recovery instead of reusing a settled one.
  await recover("vid", "IOS");
  assert.equal(resolves, 2);
}

console.log("ALL_RECOVERY_CHECKS_PASSED");
