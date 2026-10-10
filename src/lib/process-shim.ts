/**
 * Vite's browser client creates `process` (for `process.env`) without
 * `version`. `@bitcoinerlab/descriptors` then does `global.process.version = ""`.
 * `global` does not exist in the browser, so the client module graph throws
 * and the preview never finishes loading. Set the version before that import.
 *
 * Cast through `unknown`: on the server `globalThis.process` is a Node
 * `Process`, and a partial object must not be checked against that type.
 */
const g = globalThis as unknown as {
  process?: { version?: string; env?: Record<string, string | undefined> };
};
const proc = (g.process ??= { env: {} });
if (proc.version == null) proc.version = "v20.0.0";
