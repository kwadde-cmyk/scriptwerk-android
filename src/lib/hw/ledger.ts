import type { Bip388Policy } from "@/lib/miniscript/bip388";
import { ledgerPolicyReady } from "@/lib/miniscript/bip388";
import { isNativeCapacitor } from "@/lib/platform";
import { alignLedgerOrigin, isHmacHex, policyCacheKey } from "./address-check.ts";
import { installNativeUsbPolyfill } from "./native-usb.ts";
import {
  detectHid,
  formatOrigin,
  hwErrorMessage,
  normalizeHwPath,
  pathToDerivation,
  pickLedgerTransport,
  type HwSession,
} from "./types.ts";

async function ensureBuffer() {
  const g = globalThis as unknown as { Buffer?: unknown };
  if (g.Buffer) return;
  const { Buffer } = await import("buffer");
  g.Buffer = Buffer;
}

function isFileNotFound(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message || err);
  const code = (err as { statusCode?: number })?.statusCode;
  return /0x6a82|FILE_NOT_FOUND/i.test(msg) || code === 0x6a82;
}

async function openLedgerTransport() {
  await ensureBuffer();
  await installNativeUsbPolyfill();
  const kind = pickLedgerTransport(detectHid());
  if (kind === "iframe") throw new Error("hw.err.iframe");
  if (kind === "none") throw new Error("hw.err.usb");
  if (isNativeCapacitor()) {
    try {
      const { default: TransportWebUSB } = await import("@ledgerhq/hw-transport-webusb");
      return await TransportWebUSB.create();
    } catch {
      const { default: TransportWebHID } = await import("@ledgerhq/hw-transport-webhid");
      return await TransportWebHID.create();
    }
  }
  if (kind === "hid") {
    const { default: TransportWebHID } = await import("@ledgerhq/hw-transport-webhid");
    return await TransportWebHID.create();
  }
  const { default: TransportWebUSB } = await import("@ledgerhq/hw-transport-webusb");
  return await TransportWebUSB.create();
}

export async function openLedgerSession(): Promise<HwSession> {
  const transport = await openLedgerTransport();
  const { AppClient, WalletPolicy } = await import("ledger-bitcoin");
  const app = new AppClient(transport);
  let info: { name: string; version: string } | null = null;
  try {
    info = await app.getAppAndVersion();
  } catch {
    /* older app */
  }
  const appName = (info?.name || "").toLowerCase();
  if (appName && !/bitcoin/i.test(appName)) {
    await transport.close().catch(() => undefined);
    throw new Error("hw.err.app");
  }
  const fingerprint = String(await app.getMasterFingerprint()).toLowerCase();
  const label = info?.name ? `Ledger · ${info.name} ${info.version}` : "Ledger";
  const coin: "0'" = "0'";

  async function pubkey(path: string): Promise<string> {
    return await app.getExtendedPubkey(normalizeHwPath(path), true);
  }

  function walletPolicyOf(policy: Bip388Policy) {
    const ready = ledgerPolicyReady(policy);
    if (!ready.ok) throw new Error(ready.error);
    const name = ready.policy.name.slice(0, 16);
    const keys = ready.policy.keys.map((k) => alignLedgerOrigin(k.origin, fingerprint, coin));
    if (keys.some((o) => !o)) throw new Error("hw.err.needKeys");
    return new WalletPolicy(name, ready.policy.template, keys);
  }

  let bound: { key: string; wp: InstanceType<typeof WalletPolicy>; hmacHex: string } | null = null;

  async function registerWp(policy: Bip388Policy) {
    const wp = walletPolicyOf(policy);
    const [, hmac] = await app.registerWallet(wp);
    const hmacHex = Buffer.from(hmac).toString("hex");
    if (!isHmacHex(hmacHex)) throw new Error("hw.err.needHmac");
    bound = { key: policyCacheKey(policy), wp, hmacHex };
    return hmacHex;
  }

  return {
    kind: "ledger",
    demo: false,
    label,
    fingerprint,
    product: info?.name || "Bitcoin",
    async getXpub(path: string) {
      try {
        const p = normalizeHwPath(path);
        const xpub = await pubkey(p);
        return {
          xpub,
          fingerprint,
          derivation: pathToDerivation(p),
          origin: formatOrigin(fingerprint, p, xpub),
        };
      } catch (err) {
        throw new Error(hwErrorMessage(err));
      }
    },
    async registerPolicy(policy: Bip388Policy) {
      try {
        const hmac = await registerWp(policy);
        return { hmac };
      } catch (err) {
        throw new Error(hwErrorMessage(err));
      }
    },
    async getWalletAddress({ policy, hmac, change, index, display }) {
      try {
        const key = policyCacheKey(policy);
        const wp = bound?.key === key ? bound.wp : walletPolicyOf(policy);
        const hex =
          bound?.key === key && isHmacHex(bound.hmacHex)
            ? bound.hmacHex
            : isHmacHex(hmac)
              ? hmac
              : "";
        if (!isHmacHex(hex)) throw new Error("hw.err.needHmac");
        try {
          return await app.getWalletAddress(wp, Buffer.from(hex, "hex"), change, index, display);
        } catch (err) {
          if (!isFileNotFound(err)) throw err;
          const hmacHex = await registerWp(policy);
          return await app.getWalletAddress(
            bound!.wp,
            Buffer.from(hmacHex, "hex"),
            change,
            index,
            display,
          );
        }
      } catch (err) {
        if (isFileNotFound(err)) throw new Error("hw.err.6a82addr");
        throw new Error(hwErrorMessage(err));
      }
    },
    async close() {
      try {
        await transport.close();
      } catch {
        /* already gone */
      }
    },
  };
}
