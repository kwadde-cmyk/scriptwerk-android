/** BIP-329 wallet labels — JSON Lines (also accepts a JSON array). */

export const BIP329_TYPES = ["tx", "addr", "pubkey", "input", "output", "xpub"] as const;
export type Bip329Type = (typeof BIP329_TYPES)[number];

export interface Bip329Record {
  type: Bip329Type;
  ref: string;
  label?: string;
  origin?: string;
  spendable?: boolean;
  value?: number;
  height?: number;
  time?: number;
}

export interface StoredLabel {
  type: Bip329Type;
  ref: string;
  label: string;
  origin?: string;
  spendable?: boolean;
}

export function isBip329Type(v: unknown): v is Bip329Type {
  return typeof v === "string" && (BIP329_TYPES as readonly string[]).includes(v);
}

const TYPE_ALIAS: Record<string, Bip329Type> = {
  addr: "addr",
  address: "addr",
  tx: "tx",
  transaction: "tx",
  pubkey: "pubkey",
  input: "input",
  output: "output",
  utxo: "output",
  outpoint: "output",
  xpub: "xpub",
};

export function coerceBip329Type(v: unknown): Bip329Type | null {
  if (typeof v !== "string") return null;
  return TYPE_ALIAS[v.trim().toLowerCase()] ?? null;
}

export function normalizeBip329Ref(type: Bip329Type, ref: string): string {
  const r = ref.trim();
  if (type === "addr") return r.toLowerCase();
  if (type === "tx" || type === "output" || type === "input") return r.toLowerCase();
  return r;
}

export function labelKey(type: Bip329Type, ref: string): string {
  return `${type}:${normalizeBip329Ref(type, ref)}`;
}

export function asStoredLabel(v: unknown): StoredLabel | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const type = coerceBip329Type(o.type);
  if (!type) return null;
  const ref = String(o.ref ?? "").trim();
  if (!ref) return null;
  const label = String(o.label ?? o.tag ?? o.name ?? "").trim();
  const spendable = typeof o.spendable === "boolean" ? o.spendable : undefined;
  if (!label && spendable === undefined) return null;
  const origin = String(o.origin ?? "").trim();
  return {
    type,
    ref: normalizeBip329Ref(type, ref),
    label,
    origin: origin || undefined,
    spendable,
  };
}

export function asStoredLabels(v: unknown): Record<string, StoredLabel> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, StoredLabel> = {};
  for (const val of Object.values(v as Record<string, unknown>)) {
    const rec = asStoredLabel(val);
    if (!rec) continue;
    out[labelKey(rec.type, rec.ref)] = rec;
  }
  return out;
}

function asRecord(v: unknown): Bip329Record | null {
  const stored = asStoredLabel(v);
  if (!stored) {
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    const type = coerceBip329Type(o.type);
    if (!type) return null;
    const ref = String(o.ref ?? "").trim();
    if (!ref) return null;
    return {
      type,
      ref: normalizeBip329Ref(type, ref),
      origin: String(o.origin ?? "").trim() || undefined,
      value: Number.isFinite(Number(o.value)) ? Number(o.value) : undefined,
      height: Number.isFinite(Number(o.height)) ? Number(o.height) : undefined,
      time: Number.isFinite(Number(o.time)) ? Number(o.time) : undefined,
    };
  }
  const o = v as Record<string, unknown>;
  return {
    type: stored.type,
    ref: stored.ref,
    label: stored.label || undefined,
    origin: stored.origin,
    spendable: stored.spendable,
    value: Number.isFinite(Number(o.value)) ? Number(o.value) : undefined,
    height: Number.isFinite(Number(o.height)) ? Number(o.height) : undefined,
    time: Number.isFinite(Number(o.time)) ? Number(o.time) : undefined,
  };
}

export function parseBip329(text: string): { records: Bip329Record[]; skipped: number } {
  const raw = text.replace(/^\uFEFF/, "").trim();
  if (!raw) return { records: [], skipped: 0 };
  if (raw.startsWith("[") || raw.startsWith("{")) {
    try {
      const json: unknown = JSON.parse(raw);
      const list = Array.isArray(json) ? json : [json];
      const records: Bip329Record[] = [];
      let skipped = 0;
      for (const item of list) {
        const rec = asRecord(item);
        if (rec) records.push(rec);
        else skipped += 1;
      }
      if (records.length || Array.isArray(json)) return { records, skipped };
    } catch {
      /* JSONL fallback */
    }
  }
  const records: Bip329Record[] = [];
  let skipped = 0;
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      const rec = asRecord(JSON.parse(s));
      if (rec) records.push(rec);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { records, skipped };
}

export function serializeBip329(records: Bip329Record[]): string {
  const lines = records.map((r) => {
    const row: Record<string, unknown> = { type: r.type, ref: r.ref };
    if (r.label) row.label = r.label;
    if (r.origin) row.origin = r.origin;
    if (typeof r.spendable === "boolean") row.spendable = r.spendable;
    if (typeof r.value === "number" && Number.isFinite(r.value)) row.value = Math.round(r.value);
    if (typeof r.height === "number" && r.height > 0) row.height = Math.floor(r.height);
    if (typeof r.time === "number" && r.time > 0) row.time = Math.floor(r.time);
    return JSON.stringify(row);
  });
  return lines.length ? `${lines.join("\n")}\n` : "";
}

export function storedFromRecords(records: Bip329Record[]): Record<string, StoredLabel> {
  const out: Record<string, StoredLabel> = {};
  for (const r of records) {
    const rec = asStoredLabel(r);
    if (!rec) continue;
    out[labelKey(rec.type, rec.ref)] = rec;
  }
  return out;
}

export function mergeLabels(
  current: Record<string, StoredLabel>,
  incoming: Record<string, StoredLabel>,
): Record<string, StoredLabel> {
  return { ...current, ...incoming };
}

export function lookupLabel(
  labels: Record<string, StoredLabel>,
  type: Bip329Type,
  ref: string,
): StoredLabel | undefined {
  return labels[labelKey(type, ref)];
}

export function labelText(
  labels: Record<string, StoredLabel>,
  type: Bip329Type,
  ref: string,
): string {
  return lookupLabel(labels, type, ref)?.label ?? "";
}

export function coinLabelSource(
  labels: Record<string, StoredLabel>,
  txid: string,
  vout: number,
  address?: string,
): { type: Bip329Type; ref: string; label: string } {
  const tx = txid.trim();
  const outRef = `${tx}:${vout}`;
  const output = labelText(labels, "output", outRef);
  if (output) return { type: "output", ref: outRef, label: output };
  const txLabel = labelText(labels, "tx", tx);
  if (txLabel) return { type: "tx", ref: tx, label: txLabel };
  const addr = (address || "").trim();
  if (addr) {
    const a = labelText(labels, "addr", addr);
    if (a) return { type: "addr", ref: addr, label: a };
  }
  return { type: "output", ref: outRef, label: "" };
}

export function coinLabel(
  labels: Record<string, StoredLabel>,
  txid: string,
  vout: number,
  address?: string,
): string {
  return coinLabelSource(labels, txid, vout, address).label;
}

export function buildBip329Export(opts: {
  labels: Record<string, StoredLabel>;
  origin?: string;
  addresses?: { address: string }[];
  unspents?: { txid: string; vout: number; amount: number; height: number; address?: string }[];
  xpubs?: { xpub: string; origin?: string; note?: string }[];
}): Bip329Record[] {
  const origin = opts.origin?.trim() || undefined;
  const seen = new Set<string>();
  const out: Bip329Record[] = [];

  function push(rec: Bip329Record) {
    const key = labelKey(rec.type, rec.ref);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(rec);
  }

  for (const rec of Object.values(opts.labels)) {
    if (!rec.label && rec.spendable === undefined) continue;
    push({
      type: rec.type,
      ref: rec.ref,
      label: rec.label || undefined,
      origin: rec.origin || origin,
      spendable: rec.spendable,
    });
  }

  for (const a of opts.addresses ?? []) {
    const addr = a.address.trim();
    if (!addr) continue;
    const label = labelText(opts.labels, "addr", addr);
    if (!label) continue;
    push({ type: "addr", ref: normalizeBip329Ref("addr", addr), label, origin });
  }

  for (const u of opts.unspents ?? []) {
    const ref = `${u.txid}:${u.vout}`;
    const label = coinLabel(opts.labels, u.txid, u.vout, u.address);
    const spendable = lookupLabel(opts.labels, "output", ref)?.spendable;
    if (!label && spendable === undefined) continue;
    push({
      type: "output",
      ref: normalizeBip329Ref("output", ref),
      label: label || undefined,
      origin,
      spendable,
      value: Math.round((Number(u.amount) || 0) * 100_000_000),
      height: u.height > 0 ? u.height : undefined,
    });
  }

  for (const k of opts.xpubs ?? []) {
    const xpub = k.xpub.trim();
    if (!xpub) continue;
    const label = labelText(opts.labels, "xpub", xpub) || k.note?.trim() || "";
    if (!label) continue;
    push({
      type: "xpub",
      ref: xpub,
      label,
      origin: k.origin?.trim() || origin,
    });
  }

  return out;
}
