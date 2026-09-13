import type { Bip388Policy } from "@/lib/miniscript/bip388";
import {
  formatOrigin,
  normalizeHwPath,
  pathToDerivation,
  type HwKind,
  type HwSession,
  type HwXpub,
} from "./types.ts";

const DEMO_XPUBS = [
  "xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5hqK5Gb4u1Q2ZbQW2kfykAPzh9RQQJwYvNUbaMhEaKfLUWuBvYJMTx5N",
  "xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8",
  "xpub6D4BDPcP2GT577Vvch3R8WUkKAVonqrBH13JC6iqnMuzFjVsT8g3NBRgIQlnAjkE8kKNFUBBSa5RLDjEFtaY3wQaULPgLUfowojV5SMX3sM",
  "xpub6FHa3pjLCk84BayeJxFW2SP4XRrFd1JYnxeLeU8EqN3vDfZmbqBqaGJAyiLjTAwm6ZLRQUMv1ZACTj37sR62cfN7fe5JnJ7dh8zL4fiyLHV",
];

function accountIndex(path: string): number {
  const m = normalizeHwPath(path).match(/\/(\d+)'\/2'$/);
  return m ? Number(m[1]) : 0;
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function demoPairingCode(kind: HwKind): string {
  return kind === "bitbox" ? "K7T9" : "";
}

export function openDemoSession(kind: HwKind): HwSession {
  const fingerprint = kind === "ledger" ? "c0ffee01" : "b17b0b02";
  const label = kind === "ledger" ? "Ledger Nano (Demo)" : "BitBox02 (Demo)";
  return {
    kind,
    demo: true,
    label,
    fingerprint,
    product: kind === "ledger" ? "Ledger Bitcoin App" : "BitBox02 BTC",
    async getXpub(path: string): Promise<HwXpub> {
      await wait(450);
      const derivation = pathToDerivation(path);
      const xpub = DEMO_XPUBS[accountIndex(path) % DEMO_XPUBS.length]!;
      return {
        xpub,
        fingerprint,
        derivation,
        origin: formatOrigin(fingerprint, path, xpub),
      };
    },
    async registerPolicy(_policy: Bip388Policy) {
      await wait(700);
      return { hmac: "00".repeat(32) };
    },
    async getWalletAddress({ policy, change, index }) {
      await wait(180);
      let h = 2166136261;
      const tag = `${policy.name}|${policy.template}|${change}|${index}`;
      for (let i = 0; i < tag.length; i++) h = Math.imul(h ^ tag.charCodeAt(i), 16777619);
      const hex = (h >>> 0).toString(16).padStart(8, "0");
      return `bc1qswdemo${change}${String(index).padStart(3, "0")}${hex}xxxxxxxx`;
    },
    async close() {},
  };
}

export { DEMO_XPUBS };
