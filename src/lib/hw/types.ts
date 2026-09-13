import type { Bip388Policy } from "@/lib/miniscript/bip388";
import { hasWebHid, hasWebUsb, isFramed } from "../platform.ts";

export type HwKind = "ledger" | "bitbox";

export interface HwXpub {
  xpub: string;
  fingerprint: string;
  derivation: string;
  origin: string;
}

export interface HwSession {
  kind: HwKind;
  demo: boolean;
  label: string;
  fingerprint: string;
  product: string;
  getXpub: (path: string, display?: boolean) => Promise<HwXpub>;
  registerPolicy: (policy: Bip388Policy) => Promise<{ hmac?: string }>;
  getWalletAddress: (opts: {
    policy: Bip388Policy;
    hmac: string;
    change: number;
    index: number;
    display: boolean;
    coin?: "btc";
  }) => Promise<string>;
  close: () => Promise<void>;
}

export type HidSupport = "ok" | "usb" | "missing" | "iframe";
export type LedgerTransportKind = "hid" | "usb" | "iframe" | "none";

export function detectHid(): HidSupport {
  if (typeof window === "undefined") return "missing";
  if (isFramed()) return "iframe";
  if (hasWebHid()) return "ok";
  if (hasWebUsb()) return "usb";
  return "missing";
}

export function pickLedgerTransport(access: HidSupport): LedgerTransportKind {
  if (access === "iframe") return "iframe";
  if (access === "ok") return "hid";
  if (access === "usb") return "usb";
  return "none";
}

export function ledgerUsbAvailable(access: HidSupport): boolean {
  return access === "ok" || access === "usb";
}

export function bitboxUsbAvailable(access: HidSupport): boolean {
  return access === "ok";
}

export function defaultAccountPath(account = 0): string {
  const n = Number.isFinite(account) ? Math.max(0, Math.floor(account)) : 0;
  return `m/48'/0'/${n}'/2'`;
}

export function normalizeHwPath(path: string): string {
  const p = path.trim().replace(/h/gi, "'");
  if (!p) return "m/48'/0'/0'/2'";
  return p.startsWith("m/") ? p : `m/${p.replace(/^\//, "")}`;
}

export function pathToDerivation(path: string): string {
  return normalizeHwPath(path).replace(/^m\//, "");
}

export function formatOrigin(fingerprint: string, path: string, xpub: string): string {
  const fp = fingerprint.replace(/^#/, "").slice(0, 8).toLowerCase();
  const der = pathToDerivation(path);
  return `[${fp}/${der}]${xpub}`;
}

export function hwErrorMessage(err: unknown): string {
  if (!err) return "Unbekanntes Gerät-Fehler.";
  if (typeof err === "string") return err;
  const e = err as { message?: string; name?: string; statusCode?: number };
  const msg = e.message || "";
  if (msg.startsWith("hw.")) return msg;
  if (/NotFoundError|No device selected/i.test(msg)) return "hw.err.none";
  if (/NotAllowedError|denied|permission/i.test(msg)) return "hw.err.denied";
  if (/iframe|SecurityError/i.test(msg)) return "hw.err.iframe";
  if (/user abort|cancelled|0x6985|denied by the user/i.test(msg)) return "hw.err.abort";
  if (/0x6a82|FILE_NOT_FOUND/i.test(msg) || e.statusCode === 0x6a82) return "hw.err.6a82";
  if (/0x6a80|INCORRECT_DATA|Invalid data received/i.test(msg) || e.statusCode === 0x6a80) return "hw.err.6a80";
  if (/locked|pin/i.test(msg)) return "hw.err.locked";
  if (/Bitcoin|wrong app|ins not supported|0x6d00/i.test(msg)) return "hw.err.app";
  if (/WebUSB|usb/i.test(msg) && /unsupported|unavailable|not available/i.test(msg)) return "hw.err.usb";
  if (/HID|WebHID|unsupported/i.test(msg)) return "hw.err.hid";
  return msg || "hw.err.generic";
}
