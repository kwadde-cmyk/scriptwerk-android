import { isNativeCapacitor } from "@/lib/platform";

export async function installNativeUsbPolyfill(): Promise<void> {
  if (typeof window === "undefined") return;
  if (!isNativeCapacitor()) return;
  const g = window as Window & { __scriptwerkUsbInstalled?: boolean };
  if (g.__scriptwerkUsbInstalled) return;
  const { installUsbPolyfill } = await import("./usb-polyfill");
  await installUsbPolyfill();
  g.__scriptwerkUsbInstalled = true;
}
