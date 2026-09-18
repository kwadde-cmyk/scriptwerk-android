import { create } from "zustand";
import type { Bip388Policy } from "@/lib/miniscript/bip388";
import { policyCacheKey, isHmacHex } from "@/lib/hw/address-check";
import {
  defaultAccountPath,
  detectHid,
  hwErrorMessage,
  openDemoSession,
  type HidSupport,
  type HwKind,
  type HwSession,
  type HwXpub,
} from "@/lib/hw";
import { useStudio } from "@/store/studio";

export type HwStatus = "idle" | "picking" | "connecting" | "pairing" | "ready" | "busy" | "error";

interface HardwareState {
  open: boolean;
  status: HwStatus;
  kind: HwKind | null;
  demo: boolean;
  label: string;
  fingerprint: string;
  product: string;
  pairingCode: string | null;
  error: string | null;
  pendingKeyId: string | null;
  hid: HidSupport;
  lastHmac: string | null;
  policyHmacKey: string | null;
  session: HwSession | null;
  setOpen: (open: boolean) => void;
  setPendingKey: (id: string | null) => void;
  connect: (kind: HwKind, demo?: boolean) => Promise<void>;
  disconnect: () => Promise<void>;
  fetchXpub: (path?: string, display?: boolean) => Promise<HwXpub>;
  fillKey: (keyId: string, path?: string) => Promise<void>;
  registerPolicy: (policy: Bip388Policy) => Promise<string>;
  getWalletAddress: (opts: {
    policy: Bip388Policy;
    change: number;
    index: number;
    display: boolean;
  }) => Promise<string>;
}

function refreshHid(): HidSupport {
  return detectHid();
}

export const useHardware = create<HardwareState>((set, get) => ({
  open: false,
  status: "idle",
  kind: null,
  demo: false,
  label: "",
  fingerprint: "",
  product: "",
  pairingCode: null,
  error: null,
  pendingKeyId: null,
  hid: "missing",
  lastHmac: null,
  policyHmacKey: null,
  session: null,

  setOpen: (open) => {
    set({ open, hid: refreshHid(), error: open ? get().error : null });
  },
  setPendingKey: (id) => set({ pendingKeyId: id }),

  connect: async (kind, demo = false) => {
    const prev = get().session;
    if (prev) await prev.close().catch(() => undefined);
    set({
      status: demo ? "connecting" : "picking",
      kind,
      demo,
      error: null,
      pairingCode: null,
      session: null,
      hid: refreshHid(),
    });
    try {
      const session = demo
        ? openDemoSession(kind)
        : kind === "ledger"
          ? await (await import("@/lib/hw/ledger")).openLedgerSession()
          : await (
              await import("@/lib/hw/bitbox")
            ).openBitBoxSession(
              (code) => set({ pairingCode: code, status: code ? "pairing" : "connecting" }),
              () => {
                const cur = get();
                if (cur.kind === "bitbox" && !cur.demo) {
                  set({
                    status: "idle",
                    session: null,
                    fingerprint: "",
                    label: "",
                    pairingCode: null,
                  });
                }
              },
            );
      if (demo && kind === "bitbox") {
        set({ status: "pairing", pairingCode: "K7T9", session: null });
        await new Promise((r) => setTimeout(r, 700));
      }
      const keepHmac =
        !session.demo &&
        Boolean(get().lastHmac) &&
        isHmacHex(get().lastHmac) &&
        get().fingerprint === session.fingerprint;
      set({
        status: "ready",
        session,
        kind: session.kind,
        demo: session.demo,
        label: session.label,
        fingerprint: session.fingerprint,
        product: session.product,
        pairingCode: null,
        error: null,
        lastHmac: keepHmac ? get().lastHmac : null,
        policyHmacKey: keepHmac ? get().policyHmacKey : null,
      });
    } catch (err) {
      set({
        status: "error",
        session: null,
        pairingCode: null,
        error: hwErrorMessage(err),
      });
      throw err;
    }
  },

  disconnect: async () => {
    const session = get().session;
    set({
      status: "idle",
      session: null,
      kind: null,
      demo: false,
      label: "",
      fingerprint: "",
      product: "",
      pairingCode: null,
      error: null,
    });
    if (session) await session.close().catch(() => undefined);
  },

  fetchXpub: async (path, display = true) => {
    const session = get().session;
    if (!session) throw new Error("hw.err.notConnected");
    const p = path || defaultAccountPath();
    set({ status: "busy", error: null });
    try {
      const result = await session.getXpub(p, display);
      set({ status: "ready" });
      return result;
    } catch (err) {
      const message = hwErrorMessage(err);
      set({ status: get().session ? "ready" : "error", error: message });
      throw err;
    }
  },

  fillKey: async (keyId, path) => {
    const key = useStudio.getState().keys.find((k) => k.id === keyId);
    const derivation = path || (key?.derivation ? `m/${key.derivation.replace(/^m\//, "")}` : defaultAccountPath());
    const xpub = await get().fetchXpub(derivation, true);
    const err = useStudio.getState().importKeyText(keyId, xpub.origin);
    if (err) throw new Error(err);
    const session = get().session;
    if (session && key && !key.note.trim()) {
      useStudio.getState().updateKey(keyId, { note: session.kind === "ledger" ? "Ledger" : "BitBox" });
    }
  },

  registerPolicy: async (policy) => {
    const session = get().session;
    if (!session) throw new Error("hw.err.notConnected");
    const key = policyCacheKey(policy);
    const cached = get().lastHmac;
    if (get().policyHmacKey === key) {
      if (session.kind !== "ledger") return cached || "ok";
      if (isHmacHex(cached)) return cached;
    }
    set({ status: "busy", error: null });
    try {
      const result = await session.registerPolicy(policy);
      const hmac = result.hmac ?? "";
      if (session.kind === "ledger" && !isHmacHex(hmac)) throw new Error("hw.err.needHmac");
      set({ status: "ready", lastHmac: hmac || null, policyHmacKey: key, error: null });
      return hmac || "ok";
    } catch (err) {
      const message = hwErrorMessage(err);
      set({ status: get().session ? "ready" : "error", error: message });
      throw err;
    }
  },

  getWalletAddress: async ({ policy, change, index, display }) => {
    const session = get().session;
    if (!session) throw new Error("hw.err.notConnected");
    const hmac = await get().registerPolicy(policy);
    set({ status: "busy", error: null });
    try {
      const addr = await session.getWalletAddress({
        policy,
        hmac,
        change,
        index,
        display,
        coin: "btc",
      });
      set({ status: "ready" });
      return addr;
    } catch (err) {
      const raw = err instanceof Error ? err.message : hwErrorMessage(err);
      const message = raw.startsWith("hw.") ? raw : hwErrorMessage(err);
      set({ status: get().session ? "ready" : "error", error: message });
      throw err instanceof Error ? err : new Error(message);
    }
  },
}));
