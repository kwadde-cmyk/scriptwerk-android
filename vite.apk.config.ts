import { defineConfig, type Plugin } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/** Same client rewrite as scriptwerk-startos vite.config. A global define would also hit the server build. */
const LEDGER_PROCESS: [string, string][] = [
  ["process.nextTick", "((fn)=>queueMicrotask(fn))"],
  ["process.browser", "true"],
  ["process.version", JSON.stringify("v20.0.0")],
  ["process.stdout", "undefined"],
  ["process.stderr", "undefined"],
  ["process.env", "({})"],
];

function ledgerProcessPlugin(): Plugin {
  return {
    name: "scriptwerk-ledger-process",
    applyToEnvironment(env) {
      return env.name === "client";
    },
    transform(code, id) {
      if (!/node_modules\/(?:\.pnpm\/)?(?:ledger-bitcoin|readable-stream|process-nextick-args|safe-buffer|string_decoder)\//.test(id)) {
        return null;
      }
      if (!code.includes("process.")) return null;
      let next = code;
      for (const [key, value] of LEDGER_PROCESS) {
        if (next.includes(key)) next = next.split(key).join(value);
      }
      return next === code ? null : { code: next, map: null };
    },
  };
}

/** Static SPA build for the Capacitor APK. Does not replace the Vercel web deploy. */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  optimizeDeps: {
    exclude: ["bitbox-api"],
    esbuildOptions: {
      define: Object.fromEntries(LEDGER_PROCESS),
    },
  },
  ssr: {
    external: ["bitbox-api", "@ledgerhq/hw-transport-webhid", "@ledgerhq/hw-transport-webusb", "ledger-bitcoin"],
  },
  plugins: [
    ledgerProcessPlugin(),
    tailwindcss(),
    tanstackStart({
      spa: { enabled: true },
    }),
    viteReact(),
  ],
});
