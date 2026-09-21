import { checksumOf, coreCanonicalBody, stripChecksum } from "../miniscript/checksum.ts";
import { rewriteSortedMultiForCore } from "../miniscript/compile.ts";
import {
  clampUtxoCount,
  descriptorForBranch,
  utxoScanObjects,
  type AddressKind,
  type UtxoScanResult,
  type WatchSnapshot,
  buildWatchSnapshot,
} from "../hw/address-check.ts";

export interface BitcoindConfig {
  url: string;
  username: string;
  password: string;
}

export interface NodeProbe {
  subversion: string;
  version: number;
  chain: string;
  blocks: number;
}

export interface NodeValidateResult {
  descriptor: string;
  checksum: string;
  exportChecksum: string;
  checksumNote: "match" | "receive" | "differ";
  isrange: boolean;
  issolvable: boolean;
  hasprivatekeys: boolean;
  addresses: string[];
  deriveError?: string;
}

type RpcOk = { result: unknown; error: null };
type RpcErr = { result: null; error: { code: number; message: string } };

export function defaultRpcPort(_network?: string): number {
  return 8332;
}

export function normalizeRpcUrl(raw: string, _network?: string): string {
  const fallback = `http://127.0.0.1:${defaultRpcPort()}`;
  try {
    const text = raw.trim().replace(/^['"<]+|[>'"]+$/g, "");
    if (!text) return fallback;
    const embedded = text.match(/https?:\/\/[^\s<>"'`\\]+/i)?.[0];
    if (embedded) {
      const u = new URL(embedded.replace(/[),.;]+$/g, ""));
      if (u.protocol === "http:" || u.protocol === "https:") {
        const path = u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, "");
        return `${u.origin}${path}`;
      }
    }
    const token = (text.split(/\s+/)[0] ?? "").replace(/\/+$/, "");
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) {
      const rest = token.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
      return rest ? normalizeRpcUrl(rest) : fallback;
    }
    const host = token.replace(/^\/+/, "");
    if (!host) return fallback;
    const withScheme = /:\d+$/.test(host) ? `http://${host}` : `http://${host}:${defaultRpcPort()}`;
    return new URL(withScheme).origin;
  } catch {
    return fallback;
  }
}

export function splitCookie(user: string, pass: string): { username: string; password: string } {
  const u = user.trim();
  const p = pass.trim();
  if (p) return { username: u, password: p };
  const m = u.match(/^([^:]+):(.+)$/s);
  if (m) return { username: m[1]!.trim(), password: m[2]!.trim() };
  return { username: u, password: p };
}

export function basicToken(user: string, pass: string): string {
  const raw = `${user}:${pass}`;
  if (typeof Buffer !== "undefined") return Buffer.from(raw, "utf8").toString("base64");
  const bytes = new TextEncoder().encode(raw);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function looksLikeStartos(url: string): boolean {
  const text = url.trim().toLowerCase();
  if (text.includes(".local")) return true;
  try {
    const u = new URL(/^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`);
    const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    const ip = /^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname);
    if (u.protocol === "https:" && ip && port !== 443 && port !== 8332 && port !== 18332) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/** StartOS package injects BITCOIND_RPC_SOURCE=startos. Docker/web install uses env. */
export function hostProxyIsStartosSource(source: string): boolean {
  return source.trim().toLowerCase() === "startos";
}

export function isLanIpUrl(url: string): boolean {
  try {
    const raw = /^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(new URL(raw).hostname);
  } catch {
    return false;
  }
}

export function addressSpace(url: string): "local" | "loopback" {
  try {
    const host = new URL(/^https?:\/\//i.test(url) ? url : `http://${url}`).hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1") {
      return "loopback";
    }
  } catch {
    /* ignore */
  }
  return "local";
}

export async function nodeFetch(url: string, init: RequestInit): Promise<Response> {
  const { nativeRpcAvailable, nativeHttp } = await import("./native-http.ts");
  if (nativeRpcAvailable()) {
    try {
      return await nativeHttp(url, init);
    } catch (err) {
      throw classifyFetchError(err);
    }
  }
  const space = addressSpace(url);
  const opts = { ...init, targetAddressSpace: space } as RequestInit;
  try {
    return await fetch(url, opts);
  } catch (first) {
    if (space === "local") {
      try {
        return await fetch(url, { ...init, targetAddressSpace: "private" } as RequestInit);
      } catch {
        throw first;
      }
    }
    throw first;
  }
}

function classifyFetchError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/abort|timeout/i.test(msg)) return new Error("node.err.unreachable");
  return new Error("node.err.blocked");
}

export async function jsonRpcDirect(
  config: BitcoindConfig,
  method: string,
  params: unknown[] = [],
): Promise<unknown> {
  const url = /^https?:\/\//i.test(config.url.trim())
    ? config.url.trim().replace(/\/+$/, "")
    : normalizeRpcUrl(config.url);
  const auth = splitCookie(config.username, config.password);
  const payload = JSON.stringify({ jsonrpc: "1.0", id: "scriptwerk", method, params });
  const token = basicToken(auth.username, auth.password);
  const headerSets: Record<string, string>[] = [
    { "Content-Type": "application/json", Authorization: `Basic ${token}` },
    { "Content-Type": "text/plain", Authorization: `Basic ${token}` },
  ];
  let lastErr: unknown;
  let res: Response | null = null;
  for (const headers of headerSets) {
    try {
      res = await nodeFetch(url, {
        method: "POST",
        mode: "cors",
        cache: "no-store",
        headers,
        body: payload,
        signal: AbortSignal.timeout(15000),
      });
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!res) throw classifyFetchError(lastErr);

  if (res.status === 401) throw new Error("node.err.auth");
  const body = (await res.json().catch(() => null)) as RpcOk | RpcErr | null;
  if (!body) throw new Error("node.err.http");
  if (body.error) throw new Error(body.error.message || `RPC ${body.error.code}`);
  return body.result;
}

export async function jsonRpc(
  config: BitcoindConfig,
  method: string,
  params: unknown[] = [],
): Promise<unknown> {
  const { isBridgeOn, rpcViaBridge } = await import("./bridge.ts");
  if (isBridgeOn()) {
    const a = splitCookie(config.username, config.password);
    return rpcViaBridge(method, params, { user: a.username, pass: a.password });
  }
  if (await hostProxyAvailable()) return rpcViaHost(method, params, config);
  try {
    return await jsonRpcDirect(config, method, params);
  } catch (e) {
    if (!isBridgeOn()) throw e;
    return rpcViaBridge(method, params);
  }
}

let hostProxyMemo: boolean | null = null;
let useHostProxyFlag = true;

/** When false, skip the same-origin proxy so form URL/user/password are used. */
export function setUseHostProxy(on: boolean) {
  useHostProxyFlag = on;
  hostProxyMemo = null;
}

export async function hostProxyAvailable(): Promise<boolean> {
  if (!useHostProxyFlag) return false;
  if (typeof fetch === "undefined") return false;
  if (hostProxyMemo != null) return hostProxyMemo;
  try {
    const info = await hostProxyInfo();
    if (!info?.configured || !hostProxyIsStartosSource(info.source)) {
      hostProxyMemo = false;
      return false;
    }
    const res = await fetch("/bitcoind-rpc", { method: "GET", cache: "no-store" });
    hostProxyMemo = res.status === 204;
  } catch {
    hostProxyMemo = false;
  }
  return hostProxyMemo;
}

export async function hostProxyInfo(): Promise<{
  configured: boolean;
  url: string;
  user: string;
  password: string;
  source: string;
  locked: boolean;
  build: string;
} | null> {
  if (typeof fetch === "undefined") return null;
  try {
    const res = await fetch("/bitcoind-rpc/info", { method: "GET", cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      configured?: boolean;
      url?: string;
      user?: string;
      password?: string;
      source?: string;
      locked?: boolean;
      build?: string;
    };
    if (!body?.configured) return null;
    return {
      configured: true,
      url: body.url ?? "",
      user: body.user ?? "",
      password: body.password ?? "",
      source: body.source ?? "env",
      locked: Boolean(body.locked),
      build: body.build ?? "",
    };
  } catch {
    return null;
  }
}

export async function hostElectrumInfo(): Promise<{
  configured: boolean;
  url: string;
  locked: boolean;
  source: string;
} | null> {
  if (typeof fetch === "undefined") return null;
  try {
    const res = await fetch("/electrum/info", { method: "GET", cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      configured?: boolean;
      url?: string;
      locked?: boolean;
      source?: string;
    };
    if (!body?.configured || !body.url) return null;
    return {
      configured: true,
      url: body.url,
      locked: Boolean(body.locked),
      source: body.source ?? "",
    };
  } catch {
    return null;
  }
}

async function rpcViaHost(method: string, params: unknown[], config: BitcoindConfig): Promise<unknown> {
  const info = await hostProxyInfo();
  const auth = splitCookie(config.username, config.password);
  const res = await fetch("/bitcoind-rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({
      method,
      params,
      ...(info?.locked ? {} : { auth: { user: auth.username, pass: auth.password } }),
    }),
  });
  if (res.status === 401) throw new Error("node.err.auth");
  const body = (await res.json().catch(() => null)) as RpcOk | RpcErr | null;
  if (!body) throw new Error("node.err.http");
  if (body.error) throw new Error(body.error.message || `RPC ${body.error.code}`);
  return body.result;
}

const VALID_PROBE_DESC =
  "pkh(0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798)";

export async function probeNode(config: BitcoindConfig): Promise<NodeProbe> {
  if (typeof navigator !== "undefined" && navigator.permissions?.query) {
    try {
      await navigator.permissions.query({ name: "local-network-access" as PermissionName });
    } catch {
      /* older browsers */
    }
  }
  try {
    const net = (await jsonRpc(config, "getnetworkinfo")) as {
      subversion?: string;
      version?: number;
    };
    let chain = "";
    let blocks = 0;
    const extra = await probeChain(config);
    chain = extra.chain;
    blocks = extra.blocks;
    return {
      subversion: net.subversion || "",
      version: net.version || 0,
      chain,
      blocks,
    };
  } catch (first) {
    try {
      await jsonRpc(config, "getdescriptorinfo", [VALID_PROBE_DESC]);
      return {
        subversion: looksLikeStartos(config.url) ? "/Satoshi:31.1.0/" : "",
        version: 0,
        chain: "",
        blocks: 0,
      };
    } catch {
      throw first;
    }
  }
}

async function probeChain(config: BitcoindConfig): Promise<{ chain: string; blocks: number }> {
  try {
    const info = (await jsonRpc(config, "getblockchaininfo")) as { chain?: string; blocks?: number };
    return { chain: info.chain || "", blocks: info.blocks || 0 };
  } catch {
    /* rpcwhitelist */
  }
  try {
    const mine = (await jsonRpc(config, "getmininginfo")) as { chain?: string; blocks?: number };
    return { chain: mine.chain || "", blocks: mine.blocks || 0 };
  } catch {
    /* rpcwhitelist */
  }
  try {
    const n = await jsonRpc(config, "getblockcount");
    if (typeof n === "number") return { chain: "", blocks: n };
  } catch {
    /* rpcwhitelist */
  }
  return { chain: "", blocks: 0 };
}

export async function validateOnNode(
  config: BitcoindConfig,
  descriptor: string,
): Promise<NodeValidateResult> {
  const payload = rewriteSortedMultiForCore(stripChecksum(descriptor));
  const exportChecksum = checksumOf(payload);
  const info = (await jsonRpc(config, "getdescriptorinfo", [payload])) as {
    descriptor: string;
    checksum: string;
    isrange: boolean;
    issolvable: boolean;
    hasprivatekeys: boolean;
  };
  const coreDesc = info.descriptor || payload;
  const coreCs = checksumOf(coreDesc) || info.checksum;
  const inputCs = info.checksum || exportChecksum;
  const coreBody = stripChecksum(coreDesc);
  const algoOk = inputCs === exportChecksum || coreCs === exportChecksum;
  const sameBody = coreBody === payload;
  let checksumNote: NodeValidateResult["checksumNote"] = "differ";
  if (sameBody && algoOk) checksumNote = "match";
  else if (algoOk || coreBody === coreCanonicalBody(payload)) checksumNote = "receive";
  let addresses: string[] = [];
  let deriveError: string | undefined;
  try {
    const desc = info.descriptor || payload;
    addresses = await deriveSample(config, desc, Boolean(info.isrange));
  } catch (e) {
    deriveError = e instanceof Error ? e.message : "node.err.derive";
  }
  return {
    descriptor: coreDesc,
    checksum: coreCs,
    exportChecksum,
    checksumNote,
    isrange: Boolean(info.isrange),
    issolvable: Boolean(info.issolvable),
    hasprivatekeys: Boolean(info.hasprivatekeys),
    addresses,
    deriveError,
  };
}

async function deriveSample(config: BitcoindConfig, desc: string, isrange: boolean): Promise<string[]> {
  const candidates = [desc];
  if (desc.includes("/<0;1>/")) candidates.push(desc.replaceAll("/<0;1>/", "/0/"));
  let last: unknown;
  for (const d of candidates) {
    try {
      const raw = isrange || d.includes("/*")
        ? await jsonRpc(config, "deriveaddresses", [d, [0, 2]])
        : await jsonRpc(config, "deriveaddresses", [d]);
      if (Array.isArray(raw)) return raw.map(String);
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error("node.err.derive");
}

export async function deriveAddressRange(
  config: BitcoindConfig,
  descriptor: string,
  begin: number,
  end: number,
): Promise<string[]> {
  const desc = descriptor.includes("#") ? descriptor : `${descriptor}`;
  const raw = await jsonRpc(config, "deriveaddresses", [desc, [begin, end]]);
  if (!Array.isArray(raw)) throw new Error("node.err.derive");
  return raw.map(String);
}

async function electrumLookup(addresses: string[], server: string): Promise<UtxoScanResult> {
  const unique = [...new Set(addresses.filter(Boolean))];
  if (!server.trim()) throw new Error("hw.utxo.needElectrum");
  const { nativeRpcAvailable } = await import("./native-http.ts");
  if (nativeRpcAvailable()) {
    const { nativeElectrumLookup } = await import("./native-electrum.ts");
    return nativeElectrumLookup(unique, server);
  }
  const res = await fetch("/electrum", {
    method: "POST",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ addresses: unique, server }),
  });
  if (res.status === 404) throw new Error("hw.utxo.needElectrum");
  const body = (await res.json().catch(() => null)) as {
    result?: { unspents?: UtxoScanResult["unspents"]; total?: number; height?: number };
    error?: { message?: string };
  } | null;
  if (!body) throw new Error("hw.utxo.bad");
  if (body.error?.message) throw new Error(body.error.message);
  if (res.status >= 400) throw new Error(body.error?.message || "hw.utxo.needElectrum");
  const unspents = Array.isArray(body.result?.unspents) ? body.result.unspents : [];
  return {
    height: Number(body.result?.height) || 0,
    total: Number(body.result?.total) || 0,
    unspents,
  };
}

export async function scanDescriptorUtxos(
  config: BitcoindConfig,
  descriptor: string,
  opts: { count: number; receive: boolean; change: boolean; electrum?: string; from?: number },
): Promise<UtxoScanResult> {
  const objects = utxoScanObjects(descriptor, opts.count, opts.receive, opts.change, opts.from ?? 0);
  if (!objects.length) throw new Error("hw.utxo.none");
  const addresses: string[] = [];
  for (const o of objects) {
    const desc = rewriteSortedMultiForCore(o.desc);
    const list = await deriveAddressRange(config, desc, o.range[0], o.range[1]);
    addresses.push(...list);
  }
  const last = objects[0]?.range[1] ?? -1;
  const res = await electrumLookup(addresses, opts.electrum ?? "");
  return { ...res, scanned: last + 1 };
}

export async function scanWatchWallet(
  config: BitcoindConfig,
  descriptor: string,
  opts: { count: number; receive: boolean; change: boolean; electrum?: string; from?: number; checksum?: string },
): Promise<WatchSnapshot> {
  const from = Math.max(0, Math.floor(Number(opts.from) || 0));
  const n = clampUtxoCount(opts.count);
  const end = from + n - 1;
  const labeled: { address: string; kind: AddressKind; index: number }[] = [];
  const branches: { kind: AddressKind; change: 0 | 1 }[] = [];
  if (opts.receive) branches.push({ kind: "receive", change: 0 });
  if (opts.change) branches.push({ kind: "change", change: 1 });
  if (!branches.length) throw new Error("hw.utxo.none");
  for (const b of branches) {
    const desc = rewriteSortedMultiForCore(descriptorForBranch(descriptor, b.change));
    const list = await deriveAddressRange(config, desc, from, end);
    list.forEach((address, i) => labeled.push({ address, kind: b.kind, index: from + i }));
  }
  const res = await electrumLookup(
    labeled.map((a) => a.address),
    opts.electrum ?? "",
  );
  return buildWatchSnapshot({
    height: res.height,
    addresses: labeled,
    unspents: res.unspents,
    scanned: end + 1,
    checksum: opts.checksum ?? checksumOf(descriptor),
  });
}

export async function probeElectrum(server: string, sniFallback?: string): Promise<{ version: string; host: string; port: number; cert?: string }> {
  const raw = server.trim();
  if (!raw) throw new Error("hw.utxo.needElectrum");
  const { nativeRpcAvailable, withDeadline } = await import("./native-http.ts");
  if (nativeRpcAvailable()) {
    const { nativeElectrumPing } = await import("./native-electrum.ts");
    return nativeElectrumPing(raw, sniFallback);
  }
  const res = await withDeadline(
    fetch("/electrum", {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ ping: true, server: raw }),
    }),
    8000,
    "hw.utxo.unreachable",
  );
  const body = (await res.json().catch(() => null)) as {
    result?: { version?: string; host?: string; port?: number };
    error?: { message?: string };
  } | null;
  if (body?.error?.message) throw new Error(body.error.message);
  if (!res.ok || !body?.result) throw new Error(body?.error?.message || "hw.utxo.needElectrum");
  return {
    version: String(body.result.version || "server.version"),
    host: String(body.result.host || raw),
    port: Number(body.result.port) || 0,
  };
}

export async function fetchElectrumTip(server?: string): Promise<number> {
  const raw = (server ?? "").trim();
  if (!raw) throw new Error("hw.utxo.needElectrum");
  const { nativeRpcAvailable } = await import("./native-http.ts");
  if (nativeRpcAvailable()) {
    const { nativeElectrumTip } = await import("./native-electrum.ts");
    return nativeElectrumTip(raw);
  }
  const res = await fetch("/electrum", {
    method: "POST",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ tip: true, server: server ?? "" }),
  });
  if (res.status === 404) throw new Error("hw.utxo.needElectrum");
  const body = (await res.json().catch(() => null)) as {
    result?: { height?: number };
    error?: { message?: string };
  } | null;
  if (body?.error?.message) throw new Error(body.error.message);
  if (!res.ok) throw new Error(body?.error?.message || "hw.utxo.needElectrum");
  const height = Number(body?.result?.height) || 0;
  if (height <= 0) throw new Error("spend.err.tip");
  return height;
}
