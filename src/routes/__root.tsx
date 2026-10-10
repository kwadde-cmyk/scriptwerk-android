import "@/lib/process-shim";
import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { AuthProvider } from "@/lib/auth/provider";
import { PreviewHostBridge } from "@/components/preview-host-bridge";
import { StudioShell } from "@/components/studio-shell";
import appCss from "../styles.css?url";

const APP_NAME = "Scriptwerk";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: APP_NAME },
      { name: "theme-color", content: "#0b0c0e" },
      {
        name: "description",
        content: "Miniscript-Wallet bauen: Operatoren, Policy-Baum, Descriptor-Export.",
      },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg?v=s" },
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: "/__grok/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/__grok/icon-180.png" },
    ],
  }),
  component: () => (
    <html lang="de" className="antialiased h-full w-full" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="h-full w-full overflow-x-hidden">
        <PreviewHostBridge />
        <AuthProvider>
          <StudioShell />
        </AuthProvider>
        <Scripts />
      </body>
    </html>
  ),
});
