function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("hw.err.quiet")), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function openLedgerSession(): Promise<HwSession> {
  return await withTimeout(openLedgerSessionInner(), 45000);
}

import type { Bip388Policy } from "@/lib/miniscript/bip388";
import { withPartialSigs } from "@/lib/tx/psbt";
import { ledgerPolicyReady } from "@/lib/miniscript/bip388";
import { alignLedgerOrigin, isHmacHex, policyCacheKey } from "./address-check.ts";
import { formatOrigin, hwErrorMessage, normalizeHwPath, pathToDerivation, type HwSession } from "./types.ts";
import { installNativeUsbPolyfill } from "./native-usb.ts";

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

type HidDevice = {
  vendorId: number;
  opened?: boolean;
  open: () => Promise<void>;
  close: () => Promise<void>;
};

type LedgerTransport = {
  device: HidDevice;
  close: () => Promise<void>;
  send: (...args: unknown[]) => Promise<{ toString: (enc: string) => string; length: number }>;
};

type TransportCtor = {
  open: (device: HidDevice) => Promise<LedgerTransport>;
};

const LEDGER_VENDOR = 0x2c97;

function hidApi(): { getDevices: () => Promise<HidDevice[]>; requestDevice: (opts: unknown) => Promise<HidDevice | HidDevice[]> } {
  const hid = (navigator as Navigator & { hid?: { getDevices: () => Promise<HidDevice[]>; requestDevice: (opts: unknown) => Promise<HidDevice | HidDevice[]> } }).hid;
  if (!hid) throw new Error("hw.err.hid");
  return hid;
}

/** User-gesture request, then reopen a device another tab left claimed. create() times out on that case. */
async function openTransport(TransportWebHID: TransportCtor) {
  const hid = hidApi();
  let granted: HidDevice[] = [];
  try {
    granted = (await hid.getDevices()).filter((d) => d.vendorId === LEDGER_VENDOR);
  } catch {
    granted = [];
  }
  const picked = granted.length
    ? granted[0]!
    : await (async () => {
        const requested = await hid.requestDevice({ filters: [{ vendorId: LEDGER_VENDOR }] });
        const list = Array.isArray(requested) ? requested : [requested];
        if (!list[0]) throw new Error("hw.err.none");
        return list[0];
      })();

  const claim = async () => TransportWebHID.open(picked);
  try {
    if (picked.opened) await picked.close();
    return await claim();
  } catch (err) {
    const msg = String((err as { message?: string })?.message || err);
    if (!/InvalidState|already open|failed to open/i.test(msg)) throw err;
    await picked.close().catch(() => undefined);
    return claim();
  }
}

async function openLedgerSessionInner(): Promise<HwSession> {
  await ensureBuffer();
  await installNativeUsbPolyfill();
  const { default: TransportWebHID } = await import("@ledgerhq/hw-transport-webhid");
  const { AppClient, WalletPolicy } = await import("ledger-bitcoin");
  const transport = await openTransport(TransportWebHID as unknown as TransportCtor);
  const app = new AppClient(transport as never);
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
  const coin = "0'" as const;

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
    async signPsbt({ psbt, policy, hmac }) {
      try {
        const key = policyCacheKey(policy);
        const wp = bound?.key === key ? bound.wp : walletPolicyOf(policy);
        const hex =
          bound?.key === key && isHmacHex(bound.hmacHex)
            ? bound.hmacHex
            : isHmacHex(hmac)
              ? hmac
              : await registerWp(policy);
        const sigs = await app.signPsbt(psbt, wp, Buffer.from(hex, "hex"));
        return withPartialSigs(
          psbt,
          sigs.map(([input, sig]) => ({
            input,
            pubkey: new Uint8Array(sig.pubkey),
            signature: new Uint8Array(sig.signature),
          })),
        );
      } catch (err) {
        throw new Error(hwErrorMessage(err));
      }
    },
  };
}
