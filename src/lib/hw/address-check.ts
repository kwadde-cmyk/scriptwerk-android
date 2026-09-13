import type { Bip388Policy } from "../miniscript/bip388.ts";
import { descsumCreate, stripChecksum } from "../miniscript/checksum.ts";

export type AddressKind = "receive" | "change";

export interface AddressCheckRow {
  index: number;
  kind: AddressKind;
  path: string;
  ledger: string;
  core: string;
  match: boolean;
  ledgerError?: string;
  coreError?: string;
}

export function policyCacheKey(policy: Bip388Policy): string {
  const keys = policy.keys.map((k) => k.origin || k.xpub).join("|");
  return `${policy.name}\n${policy.template}\n${keys}`;
}

export interface WatchOnlyKey {
  name: string;
  label: string;
  fingerprint: string;
  xpub: string;
  origin: string;
}

/** Cosigner account xpubs. The wallet itself has no single xpub — watch-only is the descriptor. */
export function watchOnlyKeys(policy: Bip388Policy): WatchOnlyKey[] {
  return policy.keys
    .filter((k) => k.xpub.trim())
    .map((k) => {
      const raw = k.xpub.replace(/^\[.*?\]/, "").trim();
      return {
        name: k.name,
        label: k.label || k.name,
        fingerprint: k.fingerprint.replace(/^#/, "").slice(0, 8).toLowerCase(),
        xpub: raw,
        origin: k.origin || k.xpub,
      };
    });
}

export function isHmacHex(hex: string | null | undefined): hex is string {
  return Boolean(hex && /^[0-9a-f]{64}$/i.test(hex.trim()));
}

/** Device-owned key origins must use the coin type the Bitcoin app actually has. */
export function alignLedgerOrigin(origin: string, deviceFp: string, coin: "0'" | "1'"): string {
  const m = origin.match(/^\[([0-9a-fA-F]{8})\/([^\]]+)\](.+)$/);
  if (!m) return origin;
  const fp = deviceFp.replace(/^#/, "").slice(0, 8).toLowerCase();
  if (m[1]!.toLowerCase() !== fp) return origin;
  const der = m[2]!.replace(/^(48|84|86)'\/(?:0'|1')\//, `$1'/${coin}/`).replace(
    /\/(48|84|86)'\/(?:0'|1')\//g,
    `/$1'/${coin}/`,
  );
  return `[${m[1]}/${der}]${m[3]}`;
}

/** Core wants a single-branch descriptor. `<a;b>/*` → `/a/*` (receive) or `/b/*` (change). */
export function descriptorForBranch(descriptor: string, change: 0 | 1): string {
  const body = stripChecksum(descriptor);
  let next = body.replace(/\/<(\d+);(\d+)>(\/\*)?/g, (_m, a: string, b: string, star?: string) => {
    const pick = change === 0 ? a : b;
    return `/${pick}${star ?? "/*"}`;
  });
  if (next === body) {
    next = body.replace(/\/(?:\d+)\/\*/g, `/${change}/*`);
  }
  return descsumCreate(next);
}

export function chainMatches(_network: string | undefined, chain: string | undefined): boolean {
  const c = (chain || "").toLowerCase();
  if (!c || c === "demo") return true;
  return c === "main" || c === "bitcoin";
}

export function allRequestedMatch(rows: AddressCheckRow[]): boolean {
  return rows.length > 0 && rows.every((r) => r.match);
}

export function bitboxAddressPath(
  policy: Bip388Policy,
  deviceFp: string,
  change: number,
  index: number,
): string {
  const fp = deviceFp.replace(/^#/, "").slice(0, 8).toLowerCase();
  const ours = policy.keys.find(
    (k) => k.fingerprint.replace(/^#/, "").slice(0, 8).toLowerCase() === fp,
  );
  if (!ours?.derivation) throw new Error("hw.err.notOurKey");
  const account = ours.derivation.replace(/^m\//, "").replace(/\/$/, "");
  return `m/${account}/${change}/${index}`;
}

export function clampIndexRange(from: number, to: number): { from: number; to: number } {
  const a = Math.max(0, Math.min(999, Number.isFinite(from) ? Math.floor(from) : 0));
  const rawTo = Number.isFinite(to) ? Math.floor(to) : a;
  const b = Math.max(a, Math.min(a + 19, rawTo));
  return { from: a, to: b };
}

export function clampUtxoCount(n: number): number {
  const x = Math.floor(Number(n));
  if (!Number.isFinite(x)) return 20;
  return Math.max(1, Math.min(1000, x));
}

export type UtxoScanObject = { desc: string; range: [number, number] };

export function utxoScanObjects(
  descriptor: string,
  count: number,
  receive: boolean,
  change: boolean,
  from = 0,
): UtxoScanObject[] {
  const n = clampUtxoCount(count);
  const start = Math.max(0, Math.min(999, Math.floor(Number(from) || 0)));
  const end = Math.min(999, start + n - 1);
  const range: [number, number] = [start, end];
  const out: UtxoScanObject[] = [];
  if (receive) out.push({ desc: descriptorForBranch(descriptor, 0), range });
  if (change) out.push({ desc: descriptorForBranch(descriptor, 1), range });
  return out;
}

export interface UtxoHit {
  txid: string;
  vout: number;
  amount: number;
  height: number;
  desc: string;
  address?: string;
}

export interface UtxoScanResult {
  height: number;
  total: number;
  unspents: UtxoHit[];
  scanned?: number;
}

export function mergeUtxoResults(a: UtxoScanResult, b: UtxoScanResult): UtxoScanResult {
  const map = new Map<string, UtxoHit>();
  for (const u of [...a.unspents, ...b.unspents]) {
    const id = `${u.txid}:${u.vout}`;
    if (!map.has(id)) map.set(id, u);
  }
  const unspents = [...map.values()];
  return {
    height: Math.max(a.height, b.height),
    total: unspents.reduce((s, u) => s + u.amount, 0),
    unspents,
    scanned: Math.max(a.scanned ?? 0, b.scanned ?? 0),
  };
}

export const UTXO_SCAN_CAP = 1000;

function asBtc(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function parseScantxoutset(raw: unknown): UtxoScanResult {
  if (!raw || typeof raw !== "object") throw new Error("hw.utxo.bad");
  const r = raw as Record<string, unknown>;
  const rows = Array.isArray(r.unspents) ? r.unspents : [];
  const unspents: UtxoHit[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const u = row as Record<string, unknown>;
    const txid = String(u.txid ?? "").trim();
    if (!txid) continue;
    unspents.push({
      txid,
      vout: Number(u.vout) || 0,
      amount: asBtc(u.amount),
      height: Number(u.height) || 0,
      desc: String(u.desc ?? ""),
    });
  }
  return {
    height: Number(r.height) || 0,
    total: asBtc(r.total_amount),
    unspents,
  };
}

export function formatBtc(n: number): string {
  return (Number.isFinite(n) ? n : 0).toFixed(8);
}

export function formatBtcTrim(n: number): string {
  return formatBtc(n).replace(/0+$/, "").replace(/\.$/, "") || "0";
}

export type AmountUnit = "btc" | "sats" | "auto";

export function isAmountUnit(v: unknown): v is AmountUnit {
  return v === "btc" || v === "sats" || v === "auto";
}

export const SATS_PER_BTC = 100_000_000;
export const AUTO_SATS_BELOW = 0.1;

export function toSats(btc: number): number {
  return Math.round((Number.isFinite(btc) ? btc : 0) * SATS_PER_BTC);
}

export function resolveAmountUnit(btc: number, unit: AmountUnit): "btc" | "sats" {
  if (unit === "sats") return "sats";
  if (unit === "btc") return "btc";
  const n = Math.abs(Number.isFinite(btc) ? btc : 0);
  return n > 0 && n < AUTO_SATS_BELOW ? "sats" : "btc";
}

/** Always eight fraction digits, locale grouping (DE: 1.234,56789000 / EN: 1,234.56789000). */
export function formatBtcDisplay(n: number, loc = "de-DE"): string {
  const v = Number.isFinite(n) ? n : 0;
  return new Intl.NumberFormat(loc, {
    minimumFractionDigits: 8,
    maximumFractionDigits: 8,
  }).format(v);
}

export function formatAmount(
  n: number,
  unit: AmountUnit,
  loc = "de-DE",
): { text: string; suffix: "BTC" | "sats"; kind: "btc" | "sats"; label: string; exact: string } {
  const kind = resolveAmountUnit(n, unit);
  const sats = toSats(n).toLocaleString(loc);
  const full = formatBtcDisplay(n, loc);
  if (kind === "sats") {
    return {
      text: sats,
      suffix: "sats",
      kind: "sats",
      label: `${sats} sats`,
      exact: `${sats} sats · ${full} BTC`,
    };
  }
  return {
    text: full,
    suffix: "BTC",
    kind: "btc",
    label: `${full} BTC`,
    exact: `${full} BTC · ${sats} sats`,
  };
}

export interface WatchAddr {
  address: string;
  kind: AddressKind;
  index: number;
  amount: number;
  coins: number;
}

export interface WatchSnapshot {
  height: number;
  total: number;
  confirmed: number;
  unconfirmed: number;
  scanned: number;
  checksum: string;
  addresses: WatchAddr[];
  unspents: UtxoHit[];
}

export function buildWatchSnapshot(opts: {
  height: number;
  addresses: { address: string; kind: AddressKind; index: number }[];
  unspents: UtxoHit[];
  scanned: number;
  checksum?: string;
}): WatchSnapshot {
  const byAddr = new Map<string, { amount: number; coins: number }>();
  let confirmed = 0;
  let unconfirmed = 0;
  for (const u of opts.unspents) {
    if (u.height > 0) confirmed += Number(u.amount) || 0;
    else unconfirmed += Number(u.amount) || 0;
    const key = String(u.address ?? "").trim();
    if (!key) continue;
    const cur = byAddr.get(key) ?? { amount: 0, coins: 0 };
    cur.amount += Number(u.amount) || 0;
    cur.coins += 1;
    byAddr.set(key, cur);
  }
  const seen = new Set<string>();
  const addresses: WatchAddr[] = [];
  for (const a of opts.addresses) {
    const addr = a.address.trim();
    if (!addr || seen.has(addr)) continue;
    seen.add(addr);
    const hit = byAddr.get(addr);
    addresses.push({
      address: addr,
      kind: a.kind,
      index: a.index,
      amount: hit?.amount ?? 0,
      coins: hit?.coins ?? 0,
    });
  }
  return {
    height: Math.max(0, Math.floor(Number(opts.height) || 0)),
    total: confirmed + unconfirmed,
    confirmed,
    unconfirmed,
    scanned: Math.max(0, Math.floor(Number(opts.scanned) || 0)),
    checksum: opts.checksum ?? "",
    addresses,
    unspents: opts.unspents,
  };
}

export function mergeWatchSnapshots(a: WatchSnapshot, b: WatchSnapshot): WatchSnapshot {
  const merged = mergeUtxoResults(
    { height: a.height, total: a.total, unspents: a.unspents, scanned: a.scanned },
    { height: b.height, total: b.total, unspents: b.unspents, scanned: b.scanned },
  );
  return buildWatchSnapshot({
    height: merged.height,
    addresses: [...a.addresses, ...b.addresses],
    unspents: merged.unspents,
    scanned: Math.max(a.scanned, b.scanned, merged.scanned ?? 0),
    checksum: b.checksum || a.checksum,
  });
}

export function watchSnapshotHasActivity(s: WatchSnapshot): boolean {
  return s.unspents.length > 0 || s.addresses.some((a) => a.coins > 0);
}

