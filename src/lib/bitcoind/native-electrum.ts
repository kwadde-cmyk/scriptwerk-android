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
    net?: string;
    attempt?: string;
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

async function electrumHost(): Promise<ElectrumHostPlugin> {
  const { registerPlugin } = await import("@capacitor/core");
  return registerPlugin<ElectrumHostPlugin>("ElectrumHost");
}

function sniHost(target: ElectrumTarget): string | undefined {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(target.host)) return undefined;
  return target.host;
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

function throwIfNativeFail(res: { ok?: boolean; error?: string; detail?: string; ip?: string; net?: string; attempt?: string; via?: string } | null | undefined) {
  if (res && res.ok === false) {
    const bits = [res.error || "hw.utxo.unreachable", res.ip, res.net, res.attempt, res.detail].filter(Boolean);
    throw new Error(bits.join(" · "));
  }
}

export async function nativeElectrumRpc(target: ElectrumTarget, calls: ElectrumCall[], timeoutMs = 25000): Promise<unknown[]> {
  if (!nativeRpcAvailable()) throw new Error("hw.utxo.needElectrum");
  const plugin = await electrumHost();
  try {
    const res = await withDeadline(
      plugin.rpc({
        host: target.host,
        port: target.port,
        tls: target.tls,
        sni: sniHost(target),
        callsJson: JSON.stringify(calls),
        timeoutMs,
      }),
      timeoutMs + 2000,
      "hw.utxo.unreachable",
    );
    throwIfNativeFail(res);
    return Array.isArray(res?.results) ? res.results : [];
  } catch (e) {
    throw electrumFail(e);
  }
}

export async function nativeElectrumPing(server: string): Promise<{ version: string; host: string; port: number }> {
  const target = assertNativeTarget(server);
  if (!nativeRpcAvailable()) throw new Error("hw.utxo.needElectrum");
  const plugin = await electrumHost();
  try {
    const res = await withDeadline(
      plugin.ping({
        host: target.host,
        port: target.port,
        tls: target.tls,
        sni: sniHost(target),
        timeoutMs: 8000,
      }),
      14000,
      "hw.utxo.unreachable",
    );
    throwIfNativeFail(res);
    if (!res || (res.ok === false)) throw new Error("hw.utxo.unreachable");
    return {
      version: formatElectrumVersion(res.version) || "server.version",
      host: String(res.host || target.host),
      port: Number(res.port) || target.port,
    };
  } catch (e) {
    throw electrumFail(e);
  }
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
