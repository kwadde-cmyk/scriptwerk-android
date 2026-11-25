import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { isNativeCapacitor } from "./platform.ts";

export type SafeInsets = { top: number; right: number; bottom: number; left: number };

type SafeAreaPlugin = {
  getInsets(): Promise<SafeInsets>;
  addListener(event: "insets", cb: (ev: SafeInsets) => void): Promise<PluginListenerHandle>;
};

const SafeArea = registerPlugin<SafeAreaPlugin>("SafeArea");

const STYLE_ID = "scriptwerk-safe-area";

/** Capacitor 8 names these --safe-area-inset-*. WebView < 140 leaves env() at 0, so the native plugin fills the variables. */
export const SAFE_AREA_STYLE = `
html.scriptwerk-safe-area .no-print.h-dvh {
  box-sizing: border-box;
  padding-top: var(--safe-area-inset-top, env(safe-area-inset-top, 0px));
  padding-right: var(--safe-area-inset-right, env(safe-area-inset-right, 0px));
  padding-bottom: var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px));
  padding-left: var(--safe-area-inset-left, env(safe-area-inset-left, 0px));
}
/* Current Radix DialogContent sets role="dialog" and does not emit data-radix-dialog-content. */
html.scriptwerk-safe-area [role="dialog"] {
  top: calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) + (100dvh - var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) - var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))) / 2);
  max-height: calc(100dvh - var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) - var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)) - 2rem);
  max-width: calc(100vw - var(--safe-area-inset-left, env(safe-area-inset-left, 0px)) - var(--safe-area-inset-right, env(safe-area-inset-right, 0px)) - 1.5rem);
}
/* Sonner positions with bottom: var(--offset-bottom) / --mobile-offset-bottom. Add the gesture inset on top. */
html.scriptwerk-safe-area [data-sonner-toaster][data-y-position="bottom"] {
  bottom: calc(var(--offset-bottom, 24px) + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))) !important;
}
@media (max-width: 600px) {
  html.scriptwerk-safe-area [data-sonner-toaster][data-y-position="bottom"] {
    bottom: calc(var(--mobile-offset-bottom, 16px) + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))) !important;
  }
}
`;

let installed = false;

export function applySafeInsets(insets: SafeInsets) {
  const root = document.documentElement;
  root.classList.add("scriptwerk-safe-area");
  root.style.setProperty("--safe-area-inset-top", px(insets.top));
  root.style.setProperty("--safe-area-inset-right", px(insets.right));
  root.style.setProperty("--safe-area-inset-bottom", px(insets.bottom));
  root.style.setProperty("--safe-area-inset-left", px(insets.left));
}

function px(n: number) {
  const v = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  return `${v}px`;
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = SAFE_AREA_STYLE;
  document.head.appendChild(style);
}

export async function installSafeAreaPolyfill(): Promise<void> {
  if (installed || typeof document === "undefined") return;
  if (!isNativeCapacitor()) return;
  installed = true;
  try {
    ensureStyle();
    await SafeArea.addListener("insets", applySafeInsets);
  } catch {
    installed = false;
    return;
  }
  try {
    applySafeInsets(await SafeArea.getInsets());
  } catch {
    /* a later layout pass delivers "insets" */
  }
}
