import { registerPlugin } from "@capacitor/core";
import type { UtxoScanResult } from "../hw/address-check.ts";
import {
  formatElectrumVersion,
  isLoopbackHost,
  isPublicIndexerHost,
  nativeIndexerHostAllowed,
  parseElectrumUrl,
  scripthashForAddress,
  type ElectrumTarget,
} from "../electrum.ts";
import { nativeRpcAvailable, withDeadline } from "./native-http.ts";

type ElectrumCall = { method: string; params: unknown[] };

type ElectrumHostPlugin = {
  ready: () => Promise<{ ok?: boolean; via?: string; sdk?: number }>;
  ping: (opts: {
    host: string;
    port: number;
    tls: boolean;
    sni?: string;
    timeoutMs?: number;
  }) => Promise<{
    ok?: boolean;
    via?: string;
    version?: string;
    host?: string;
    port?: number;
    error?: string;
    detail?: string;
    ip?: string;
    attempt?: string;
    cert?: string;
  }>;
  rpc: (opts: {
    host: string;
    port: number;
    tls: boolean;
    sni?: string;
    callsJson: string;
    timeoutMs?: number;
  }) => Promise<{ ok?: boolean; results?: unknown[]; error?: string; detail?: string }>;
};

export function mapElectrumUnspents(
  hashes: { address: string; scripthash: string }[],
  rows: unknown[],
): UtxoScanResult {
  const head = rows[0];
  const chainHeight =
    Number(head && typeof head === "object" && head !== null && "height" in head ? (head as { height?: number }).height : head) ||
    0;
  const unspents: UtxoScanResult["unspents"] = [];
  hashes.forEach((h, i) => {
    const list = Array.isArray(rows[i + 1]) ? (rows[i + 1] as Array<{ tx_hash?: string; tx_pos?: number; value?: number; height?: number }>) : [];
    for (const u of list) {
      const sats = Number(u.value) || 0;
      unspents.push({
        txid: String(u.tx_hash ?? ""),
        vout: Number(u.tx_pos) || 0,
        amount: sats / 1e8,
        height: Number(u.height) || 0,
        address: h.address,
        desc: h.address,
      });
    }
  });
  return {
    height: chainHeight,
    total: unspents.reduce((s, u) => s + u.amount, 0),
    unspents,
  };
}

function assertNativeTarget(server: string): ElectrumTarget {
  const target = parseElectrumUrl(server);
  if (!target) throw new Error("hw.utxo.needElectrum");
  if (isPublicIndexerHost(target.host)) throw new Error("hw.utxo.noPublic");
  if (isLoopbackHost(target.host)) throw new Error("hw.utxo.loopback");
  if (!nativeIndexerHostAllowed(target.host)) throw new Error("hw.utxo.lanOnly");
  return target;
}

const ElectrumHost = registerPlugin<ElectrumHostPlugin>("ElectrumHost");

function electrumHost(): ElectrumHostPlugin {
  return ElectrumHost;
}

function sniHost(target: ElectrumTarget, fallback?: string): string | undefined {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(target.host)) return target.host;
  const extra = (fallback || "").trim();
  if (extra && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(extra)) return extra;
  return undefined;
}

function electrumFail(e: unknown): Error {
  const texts: string[] = [];
  const walk = (x: unknown) => {
    if (x instanceof Error) {
      texts.push(x.message, x.name);
      const agg = x as Error & { errors?: unknown[] };
      if (Array.isArray(agg.errors)) agg.errors.forEach(walk);
    } else if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      for (const k of ["message", "errorMessage", "code", "error", "detail"]) {
        if (typeof o[k] === "string") texts.push(o[k] as string);
      }
    } else if (typeof x === "string") {
      texts.push(x);
    }
  };
  walk(e);
  const blob = texts.join(" ");
  const m = blob.match(/hw\.[a-z0-9.]+/i);
  const key = m ? m[0] : "hw.utxo.unreachable";
  const extra = blob.replace(key, "").replace(/\s+/g, " ").trim().slice(0, 180);
  return new Error(extra ? `${key} · ${extra}` : key);
}

function throwIfNativeFail(res: { ok?: boolean; error?: string; detail?: string; ip?: string; attempt?: string; via?: string; cert?: string } | null | undefined) {
  if (res && res.ok === false) {
    const bits = [res.error || "hw.utxo.unreachable", res.ip, res.attempt, res.detail, res.cert].filter(Boolean);
    throw new Error(bits.join(" · "));
  }
}

export async function nativeElectrumRpc(target: ElectrumTarget, calls: ElectrumCall[], timeoutMs = 25000, sniFallback?: string): Promise<unknown[]> {
  if (!nativeRpcAvailable()) throw new Error("hw.utxo.needElectrum");
  const plugin = electrumHost();
  try {
    const res = await withDeadline(
      plugin.rpc({
        host: target.host,
        port: target.port,
        tls: target.tls,
        sni: sniHost(target, sniFallback),
        callsJson: JSON.stringify(calls),
        timeoutMs,
      }),
      timeoutMs + 4000,
      "hw.utxo.unreachable",
    );
    throwIfNativeFail(res);
    return Array.isArray(res?.results) ? res.results : [];
  } catch (e) {
    throw electrumFail(e);
  }
}

export async function nativeElectrumPing(server: string, sniFallback?: string): Promise<{ version: string; host: string; port: number; cert?: string }> {
  const target = assertNativeTarget(server);
  if (!nativeRpcAvailable()) throw new Error("hw.utxo.needElectrum");
  const plugin = electrumHost();
  try {
    const alive = await withDeadline(plugin.ready(), 2500, "hw.utxo.plugin");
    if (!alive?.ok) throw new Error("hw.utxo.plugin");
    const res = await withDeadline(
      plugin.ping({
        host: target.host,
        port: target.port,
        tls: target.tls,
        sni: sniHost(target, sniFallback),
        timeoutMs: 6000,
      }),
      10000,
      "hw.utxo.unreachable",
    );
    throwIfNativeFail(res);
    if (!res || res.ok === false) throw new Error("hw.utxo.unreachable");
    return {
      version: formatElectrumVersion(res.version) || "server.version",
      host: String(res.host || target.host),
      port: Number(res.port) || target.port,
      cert: res.cert,
    };
  } catch (e) {
    throw electrumFail(e);
  }
}

async function deriveDescriptorAddresses(desc: string, from: number, to: number): Promise<string[]> {
  const { Output } = await import("@bitcoinerlab/descriptors");
  const body = String(desc ?? "").replace(/#[a-z0-9]+$/i, "");
  const start = Math.max(0, Math.floor(Number(from) || 0));
  const end = Math.min(start + 199, Math.max(start, Math.floor(Number(to) || start)));
  const addresses: string[] = [];
  for (let i = start; i <= end; i++) {
    try {
      addresses.push(new Output({ descriptor: body, index: i, checksumRequired: false }).getAddress());
    } catch {
      throw new Error("hw.utxo.derive");
    }
  }
  return addresses;
}

function asHex(value: unknown): string {
  if (typeof value === "string") return value.replace(/^0x/i, "").toLowerCase();
  if (value instanceof Uint8Array) {
    let hex = "";
    for (const b of value) hex += b.toString(16).padStart(2, "0");
    return hex;
  }
  return "";
}

/** Same expansion the web host does in /electrum { expand }. The APK has no local server. */
export async function nativeExpandSpots(
  descriptor: string,
  spots: { change: number; index: number }[],
): Promise<{ address: string; witnessScript: string; derivations: { pubkey: string; fingerprint: string; path: string }[] }[]> {
  const { Output } = await import("@bitcoinerlab/descriptors");
  const body = String(descriptor ?? "").replace(/#[a-z0-9]+$/i, "");
  if (!body) throw new Error("tx.err.script");
  const items = [];
  for (const spot of spots.slice(0, 40)) {
    const change = Number(spot?.change) ? 1 : 0;
    const index = Math.max(0, Math.floor(Number(spot?.index) || 0));
    let out;
    try {
      out = new Output({ descriptor: body, index, change, checksumRequired: false });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      throw new Error(msg.includes("not sane") ? "tx.err.sane" : "tx.err.script");
    }
    const script = out.getWitnessScript();
    const map = out.expand()?.expansionMap ?? {};
    const derivations: { pubkey: string; fingerprint: string; path: string }[] = [];
    const seen = new Set<string>();
    for (const info of Object.values(map) as { pubkey?: unknown; masterFingerprint?: unknown; path?: unknown }[]) {
      const pubkey = asHex(info?.pubkey);
      const fingerprint = asHex(info?.masterFingerprint);
      const path = String(info?.path ?? "");
      if (pubkey.length !== 66 || fingerprint.length !== 8 || !path || seen.has(pubkey)) continue;
      seen.add(pubkey);
      derivations.push({ pubkey, fingerprint, path });
    }
    items.push({
      address: out.getAddress(),
      witnessScript: script ? asHex(script) : "",
      derivations,
    });
  }
  return items;
}

export async function nativeElectrumDeriveLookup(
  groups: { desc: string; from: number; to: number; addresses?: string[] }[],
  server: string,
): Promise<UtxoScanResult & { groups: string[][]; used: boolean[][]; more: boolean }> {
  const lists: string[][] = [];
  for (const g of groups) {
    if (g.addresses && g.addresses.length > 0) lists.push(g.addresses.map(String));
    else lists.push(await deriveDescriptorAddresses(g.desc, g.from, g.to));
  }
  const flat = lists.flat().slice(0, 200);
  if (!flat.length) throw new Error("hw.utxo.derive");
  const scanned = await nativeElectrumScanOrdered(flat, server);
  let off = 0;
  const used = lists.map((list) => {
    const slice = scanned.used.slice(off, off + list.length);
    off += list.length;
    return slice;
  });
  return {
    height: scanned.height,
    total: scanned.total,
    unspents: scanned.unspents,
    groups: lists,
    used,
    more: used.some((list) => list.some(Boolean)) || scanned.unspents.length > 0,
  };
}

async function nativeElectrumScanOrdered(addresses: string[], server: string): Promise<UtxoScanResult & { used: boolean[] }> {
  const target = assertNativeTarget(server);
  const hashes: { address: string; scripthash: string }[] = [];
  for (const address of addresses) hashes.push({ address, scripthash: await scripthashForAddress(address) });
  const rows = await nativeElectrumRpc(
    target,
    [
      { method: "blockchain.headers.subscribe", params: [] },
      ...hashes.map((h) => ({ method: "blockchain.scripthash.listunspent", params: [h.scripthash] })),
      ...hashes.map((h) => ({ method: "blockchain.scripthash.get_history", params: [h.scripthash] })),
    ],
    20000,
  );
  const scanned = mapElectrumUnspents(hashes, rows);
  const used = hashes.map((_, i) => {
    const list = rows[i + 1];
    const hist = rows[1 + hashes.length + i];
    return (Array.isArray(list) && list.length > 0) || (Array.isArray(hist) && hist.length > 0);
  });
  return { ...scanned, used };
}

export async function nativeElectrumLookup(addresses: string[], server: string): Promise<UtxoScanResult> {
  const target = assertNativeTarget(server);
  const unique = [...new Set(addresses.filter(Boolean))];
  const hashes: { address: string; scripthash: string }[] = [];
  for (const address of unique) {
    hashes.push({ address, scripthash: await scripthashForAddress(address) });
  }
  const rows = await nativeElectrumRpc(target, [
    { method: "blockchain.headers.subscribe", params: [] },
    ...hashes.map((h) => ({ method: "blockchain.scripthash.listunspent", params: [h.scripthash] })),
  ], 20000);
  return mapElectrumUnspents(hashes, rows);
}

export async function nativeElectrumTip(server: string): Promise<number> {
  const target = assertNativeTarget(server);
  const rows = await nativeElectrumRpc(target, [{ method: "blockchain.headers.subscribe", params: [] }], 8000);
  const head = rows[0];
  const height =
    Number(head && typeof head === "object" && head !== null && "height" in head ? (head as { height?: number }).height : head) ||
    0;
  if (height <= 0) throw new Error("spend.err.tip");
  return height;
}
