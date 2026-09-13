import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/** Static SPA build for the Capacitor APK. Does not replace the Vercel web deploy. */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  optimizeDeps: {
    exclude: ["bitbox-api"],
  },
  ssr: {
    external: ["bitbox-api", "@ledgerhq/hw-transport-webhid", "@ledgerhq/hw-transport-webusb", "ledger-bitcoin"],
  },
  plugins: [
    tailwindcss(),
    tanstackStart({
      spa: { enabled: true },
    }),
    viteReact(),
  ],
});
