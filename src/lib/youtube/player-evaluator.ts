import { createContext, runInContext } from "node:vm";
import type { Types } from "youtubei.js";

/**
 * youtubei.js v18 no longer bundles a JS interpreter, so streaming URLs cannot be
 * deciphered until one is provided through `Platform.shim.eval`.
 *
 * The extracted player script is untrusted remote code, so it runs inside a fresh
 * `node:vm` context that only exposes the web-standard helpers it needs — no
 * `process`, `require`, `fs`, or network APIs. (jintr was evaluated first but cannot
 * execute the player script YouTube currently ships: it lacks ClassExpression and
 * RegExp support.)
 */
export function createPlayerEvaluator() {
  return async (data: Types.BuildScriptResult): Promise<Types.EvalResult> => {
    // `data.output` ends with a top-level `return`, so it only parses inside a function body.
    const source = `(function(){\n${data.output}\n})()`;
    const sandbox = createContext({ URL, encodeURIComponent, decodeURIComponent });
    return runInContext(source, sandbox, { timeout: 5000 }) as Types.EvalResult;
  };
}
