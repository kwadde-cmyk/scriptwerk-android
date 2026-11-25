import { useEffect } from "react";
import { installSafeAreaPolyfill } from "@/lib/native-safe-area";

/** Mounts once at the root. No-op in the browser; on the APK it pads for the status and gesture bars. */
export function NativeSafeArea() {
  useEffect(() => {
    void installSafeAreaPolyfill();
  }, []);
  return null;
}
