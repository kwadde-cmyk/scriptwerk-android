import { BIP32Factory, type TinySecp256k1Interface } from "bip32";
import * as ecc from "@bitcoinerlab/secp256k1";
import { baseKeyName, type KeyEntry } from "../miniscript/keys.ts";
import { describeStageSlots, type Stage } from "../miniscript/stages.ts";
import { inspectSignatures, type SigInput } from "./psbt.ts";

const bip32 = BIP32Factory(ecc as TinySecp256k1Interface);
const TESTNET = { bip32: { public: 0x043587cf, private: 0x04358394 }, wif: 0xef };
const SCAN = 80;

type Node = { derive: (index: number) => Node; publicKey: Uint8Array };
type Hit = { name: string; fingerprint: string; path: string };
type Chain = { name: string; fingerprint: string; origin: string; chain: number; node: Node };

const nodeCache = new Map<string, Node | null>();

export type SigPresent = { label: string; path: string; onPath: boolean };

export type InputSignoff = {
  index: number;
  finalized: boolean;
  present: SigPresent[];
  missing: string[];
  need: number;
  haveOnPath: number;
  pathReady: boolean;
};

export type SignatureReport = {
  inputs: InputSignoff[];
  quorum: string;
};

/** Third BIP32 step is the account (`m/48'/0'/1'/2'/…`). */
export function accountOfPath(path: string): number {
  const parts = path.trim().replace(/^m\/?/, "").split("/").filter(Boolean);
  if (parts.length < 3) return 0;
  const n = Number.parseInt(parts[2]!, 10);
  return Number.isFinite(n) ? n : 0;
}

function fingerprintOf(key: { fingerprint: string }): string {
  return key.fingerprint.replace(/^0x/i, "").toLowerCase();
}

function hexOf(data: Uint8Array): string {
  let out = "";
  for (const b of data) out += b.toString(16).padStart(2, "0");
  return out;
}

function originOf(path: string): string {
  return path.trim().replace(/^m\/?/i, "").replace(/\/$/, "").replace(/\/<[^>]+>(?:\/\*)?$/, "").replace(/\/\*$/, "");
}

function leafPath(origin: string, chain: number, index: number): string {
  if (/\/[01]\/\d+$/.test(origin)) return `m/${origin}`;
  return origin ? `m/${origin}/${chain}/${index}` : `m/${chain}/${index}`;
}

function nodeFor(xpub: string): Node | null {
  const cached = nodeCache.get(xpub);
  if (cached !== undefined) return cached;
  let node: Node | null = null;
  try {
    node = bip32.fromBase58(xpub) as Node;
  } catch {
    try {
      node = bip32.fromBase58(xpub, TESTNET as never) as Node;
    } catch {
      node = null;
    }
  }
  nodeCache.set(xpub, node);
  return node;
}

function matchByXpub(keys: KeyEntry[], pubkeys: string[]): Map<string, Hit> {
  const want = new Set(pubkeys.map((p) => p.toLowerCase()).filter((p) => /^[0-9a-f]{66}$/.test(p)));
  if (!want.size) return new Map();
  const chains: Chain[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    const sources = [
      ...(key.xpub.trim() ? [{ xpub: key.xpub.trim(), path: key.derivation, fp: key.fingerprint }] : []),
      ...key.children.filter((c) => c.xpub.trim()).map((c) => ({ xpub: c.xpub.trim(), path: c.path || key.derivation, fp: c.fingerprint || key.fingerprint })),
    ];
    for (const src of sources) {
      if (seen.has(src.xpub)) continue;
      seen.add(src.xpub);
      const node = nodeFor(src.xpub);
      if (!node) continue;
      const origin = originOf(src.path);
      for (const chain of [0, 1]) {
        try {
          chains.push({ name: key.name, fingerprint: src.fp, origin, chain, node: node.derive(chain) });
        } catch {
          /* not a public child */
        }
      }
    }
  }
  const found = new Map<string, Hit>();
  for (let index = 0; index < SCAN && found.size < want.size; index++) {
    for (const chain of chains) {
      let pub = "";
      try {
        pub = hexOf(chain.node.derive(index).publicKey);
      } catch {
        continue;
      }
      if (!want.has(pub)) continue;
      found.set(pub, { name: chain.name, fingerprint: chain.fingerprint, path: leafPath(chain.origin, chain.chain, index) });
    }
  }
  return found;
}

function knownFingerprint(keys: KeyEntry[], fingerprint: string): boolean {
  const fp = fingerprint.toLowerCase();
  return keys.some((k) => fingerprintOf(k) === fp || k.children.some((c) => fingerprintOf(c) === fp));
}

function hitsFor(input: SigInput, keys: KeyEntry[]): Map<string, Hit> {
  const out = new Map<string, Hit>();
  const signed = input.pubkeys.map((pk) => pk.toLowerCase());
  for (const deriv of input.derivations) {
    const pk = deriv.pubkey.toLowerCase();
    if (!signed.includes(pk) || out.has(pk)) continue;
    if (!knownFingerprint(keys, deriv.fingerprint)) continue;
    out.set(pk, { name: "", fingerprint: deriv.fingerprint, path: deriv.path });
  }
  const rest = signed.filter((pk) => !out.has(pk));
  if (rest.length) {
    for (const [pk, hit] of matchByXpub(keys, rest)) out.set(pk, hit);
  }
  return out;
}

function labelOf(keys: KeyEntry[], hit: Hit): string {
  const account = accountOfPath(hit.path);
  const key = hit.name
    ? keys.find((k) => k.name === hit.name)
    : keys.find((k) => fingerprintOf(k) === hit.fingerprint.toLowerCase());
  if (!key) {
    const fp = hit.fingerprint.toLowerCase();
    return fp ? `${fp} · ${hit.path.replace(/^m\/?/, "")}` : hit.path || "—";
  }
  const name = key.note.trim() || key.name;
  return account > 0 ? `${name} ${key.name}${account}` : name;
}

function signerLabel(keys: KeyEntry[], token: string, account: number): string {
  const key = keys.find((k) => k.name === baseKeyName(token));
  const name = key?.note.trim() || token;
  return account > 0 && key ? `${name} ${token}` : name;
}

function matches(signer: { token: string; account: number }, keys: KeyEntry[], hit: Hit): boolean {
  if (accountOfPath(hit.path) !== signer.account) return false;
  if (hit.name) return baseKeyName(signer.token) === hit.name;
  const key = keys.find((k) => k.name === baseKeyName(signer.token));
  if (!key?.fingerprint) return false;
  return fingerprintOf(key) === hit.fingerprint.toLowerCase();
}

export function signatureReport(
  psbt: string,
  opts: { keys: KeyEntry[]; stages: Stage[]; reuse: boolean; pathIndex: number | null },
): SignatureReport {
  const seen = inspectSignatures(psbt);
  const slots = describeStageSlots(opts.stages, opts.reuse);
  const slot = opts.pathIndex == null ? null : (slots[opts.pathIndex] ?? null);
  return {
    quorum: slot?.quorum ?? "",
    inputs: seen.inputs.map((input) => {
      const hits = hitsFor(input, opts.keys);
      const present: SigPresent[] = input.pubkeys.map((pk) => {
        const hit = hits.get(pk.toLowerCase());
        if (!hit) return { label: `${pk.slice(0, 12)}…`, path: "", onPath: false };
        const onPath = slot ? slot.signers.some((s) => matches(s, opts.keys, hit)) : false;
        return { label: labelOf(opts.keys, hit), path: hit.path, onPath };
      });
      const missing = slot
        ? slot.signers
            .filter((s) => ![...hits.values()].some((hit) => matches(s, opts.keys, hit)))
            .map((s) => signerLabel(opts.keys, s.token, s.account))
        : [];
      const haveOnPath = slot ? slot.signers.length - missing.length : present.length;
      const need = slot?.k ?? 0;
      return {
        index: input.index,
        finalized: input.finalized,
        present,
        missing,
        need,
        haveOnPath,
        pathReady: Boolean(slot && (input.finalized || haveOnPath >= need)),
      };
    }),
  };
}
