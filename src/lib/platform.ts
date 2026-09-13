export function isAndroidUA() {
  if (typeof navigator === "undefined") return false;
  return /Android/i.test(navigator.userAgent);
}

export function isMobileUA() {
  if (typeof navigator === "undefined") return false;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export function isNativeCapacitor() {
  if (typeof window === "undefined") return false;
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return Boolean(cap?.isNativePlatform?.());
}

export function isFramed() {
  if (typeof window === "undefined") return false;
  if (isNativeCapacitor()) return false;
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

export function hasWebHid() {
  if (typeof navigator === "undefined") return false;
  if (isNativeCapacitor()) return true;
  return "hid" in navigator && Boolean(navigator.hid);
}

export function hasWebUsb() {
  if (typeof navigator === "undefined") return false;
  if (isNativeCapacitor()) return true;
  return "usb" in navigator && Boolean(navigator.usb);
}

export function hasCameraApi() {
  return typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
}

export type LaunchIntent = "scan" | "usb";

export function parseLaunchIntent(search: string, hash = ""): LaunchIntent | null {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const q = new URLSearchParams(raw);
  if (q.get("scan") === "1" || q.get("cam") === "1") return "scan";
  if (q.get("usb") === "1" || q.get("hid") === "1") return "usb";
  const h = hash.replace(/^#/, "");
  if (h === "scan" || h === "cam") return "scan";
  if (h === "usb") return "usb";
  return null;
}

export function stripLaunchIntent(url: URL): URL {
  const next = new URL(url.href);
  next.searchParams.delete("scan");
  next.searchParams.delete("cam");
  next.searchParams.delete("usb");
  next.searchParams.delete("hid");
  if (/^(scan|cam|usb)$/.test(next.hash.slice(1))) next.hash = "";
  return next;
}

export function openDirectWindow(intent: LaunchIntent): Window | null {
  if (typeof window === "undefined") return null;
  if (isNativeCapacitor()) return null;
  const url = new URL(window.location.href);
  url.searchParams.delete("scan");
  url.searchParams.delete("cam");
  url.searchParams.delete("usb");
  url.searchParams.delete("hid");
  url.searchParams.set(intent, "1");
  url.hash = "";
  return window.open(url.toString(), "scriptwerk-direct");
}

export function cameraErrorKey(err: unknown, framed: boolean): string {
  if (framed) return "qr.iframe";
  const name =
    err && typeof err === "object" && "name" in err ? String((err as { name?: string }).name) : "";
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (name === "NotAllowedError" || /denied|permission/i.test(msg)) return "qr.denied";
  if (name === "NotFoundError" || /requested device not found/i.test(msg)) return "qr.noneFound";
  if (name === "SecurityError" || /iframe|secure context/i.test(msg)) return "qr.iframe";
  return "qr.noCam";
}

export async function ensureNativeCameraPermission(): Promise<boolean> {
  if (!isNativeCapacitor()) return true;
  try {
    const { Camera } = await import("@capacitor/camera");
    const status = await Camera.requestPermissions({ permissions: ["camera"] });
    return status.camera === "granted";
  } catch {
    return false;
  }
}

export async function nativeCameraJpeg(): Promise<Blob | null> {
  if (!isNativeCapacitor()) return null;
  try {
    const ok = await ensureNativeCameraPermission();
    if (!ok) return null;
    const { Camera, CameraResultType, CameraSource } = await import("@capacitor/camera");
    const photo = await Camera.getPhoto({
      quality: 90,
      resultType: CameraResultType.Uri,
      source: CameraSource.Camera,
    });
    const url = photo.webPath;
    if (!url) return null;
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.blob();
  } catch {
    return null;
  }
}
