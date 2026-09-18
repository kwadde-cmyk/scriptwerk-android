const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32M = 0x2bc830a3;

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i]!;
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] | null {
  let acc = 0;
  let bits = 0;
  const maxv = (1 << to) - 1;
  const out: number[] = [];
  for (const value of data) {
    if (value < 0 || value >> from) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || (acc << (to - bits)) & maxv) {
    return null;
  }
  return out;
}

export function scriptPubKeyFromAddress(addr: string): string {
  const raw = addr.trim();
  const pos = raw.lastIndexOf("1");
  if (pos < 1) throw new Error("hw.utxo.addr");
  const hrp = raw.slice(0, pos).toLowerCase();
  const body = raw.slice(pos + 1).toLowerCase();
  const data: number[] = [];
  for (const c of body) {
    const v = CHARSET.indexOf(c);
    if (v < 0) throw new Error("hw.utxo.addr");
    data.push(v);
  }
  if (data.length < 7) throw new Error("hw.utxo.addr");
  const chk = polymod(hrpExpand(hrp).concat(data));
  if (chk !== 1 && chk !== BECH32M) throw new Error("hw.utxo.addr");
  const conv = convertBits(data.slice(1, -6), 5, 8, false);
  if (!conv) throw new Error("hw.utxo.addr");
  const version = data[0]!;
  const program = conv;
  if (version === 0 && program.length === 20) return `0014${toHex(program)}`;
  if (version === 0 && program.length === 32) return `0020${toHex(program)}`;
  if (version === 1 && program.length === 32) return `5120${toHex(program)}`;
  throw new Error("hw.utxo.addr");
}

function toHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const h = hex.replace(/^0x/, "");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function electrumScripthash(scriptPubKeyHex: string): Promise<string> {
  const bytes = fromHex(scriptPubKeyHex);
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  const hash = new Uint8Array(digest);
  const rev = [...hash].reverse();
  return toHex(rev);
}

export async function scripthashForAddress(addr: string): Promise<string> {
  return electrumScripthash(scriptPubKeyFromAddress(addr));
}

export type ElectrumTarget = { host: string; port: number; tls: boolean };

export function parseElectrumUrl(raw: string): ElectrumTarget | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
      const u = new URL(text);
      const tls = u.protocol === "ssl:" || u.protocol === "tls:" || u.protocol === "electrums:";
      const port = u.port ? Number(u.port) : tls ? 50002 : 50001;
      if (!u.hostname || !Number.isFinite(port)) return null;
      return { host: u.hostname, port, tls };
    }
  } catch {
    return null;
  }
  const m = text.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
  if (!m) return null;
  const host = m[1]!.replace(/^\[|\]$/g, "");
  const port = m[2] ? Number(m[2]) : 50001;
  if (!host || !Number.isFinite(port)) return null;
  return { host, port, tls: port === 50002 };
}

export function electrumHostAllowed(host: string, envUrl = ""): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return false;
  if (h === "localhost" || h === "127.0.0.1" || h === "::1") return true;
  if (h.endsWith(".local") || h.endsWith(".lan")) return true;
  if (/^10(?:\.\d{1,3}){3}$/.test(h)) return true;
  if (/^192\.168(?:\.\d{1,3}){2}$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/.test(h)) return true;
  const env = parseElectrumUrl(envUrl);
  return Boolean(env && env.host.toLowerCase() === h);
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0";
}

export function isPrivateIpv4(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (/^10(?:\.\d{1,3}){3}$/.test(h)) return true;
  if (/^192\.168(?:\.\d{1,3}){2}$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/.test(h)) return true;
  return false;
}

export function isPublicIndexerHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h) return false;
  return (
    h === "mempool.space" ||
    h.endsWith(".mempool.space") ||
    h === "blockstream.info" ||
    h.endsWith(".blockstream.info")
  );
}

export function indexerHostAllowed(host: string, envUrl = ""): boolean {
  return electrumHostAllowed(host, envUrl) && !isPublicIndexerHost(host);
}

export function nativeIndexerHostAllowed(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return false;
  if (isPublicIndexerHost(h) || isLoopbackHost(h)) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return isPrivateIpv4(h);
  return true;
}

export function formatElectrumVersion(raw: unknown): string {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean).join(" ");
  if (raw == null) return "";
  return String(raw);
}
