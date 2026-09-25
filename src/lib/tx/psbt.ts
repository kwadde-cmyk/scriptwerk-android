import { scriptPubKeyFromAddress } from "../electrum.ts";

const DUST_SATS = 546;
const RBF_SEQUENCE = 0xfffffffd;
const FINAL_SEQUENCE = 0xffffffff;

export type SpendCoin = {
  txid: string;
  vout: number;
  amountBtc: number;
  address: string;
};

export type SpendPlan = {
  inputs: SpendCoin[];
  outputs: { address: string; sats: number }[];
  feeSats: number;
  inputSats: number;
  rbf: boolean;
};

export function satsFromDecimal(text: string): number {
  const t = text.trim().replace(",", ".");
  if (!/^\d+(\.\d{1,8})?$/.test(t)) return Number.NaN;
  const [whole, frac = ""] = t.split(".");
  return Number(whole) * 100_000_000 + Number(frac.padEnd(8, "0").slice(0, 8));
}

export function satsToDecimal(sats: number): string {
  const n = Math.max(0, Math.floor(sats));
  const whole = Math.floor(n / 100_000_000);
  const frac = String(n % 100_000_000).padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

export function btcToSats(btc: number): number {
  if (!Number.isFinite(btc) || btc < 0) return 0;
  const [whole, frac = ""] = btc.toFixed(8).split(".");
  return Number(whole) * 100_000_000 + Number(frac.padEnd(8, "0").slice(0, 8));
}

/** Virtual bytes for a wsh spend. Witness is an estimate: sigs plus a script sized from the key count. */
export function estimateVbytes(opts: { inputs: number; outputs: string[]; sigs: number; keys: number }): number {
  const inputs = Math.max(0, Math.floor(opts.inputs));
  const sigs = Math.max(1, Math.floor(opts.sigs));
  const keys = Math.max(sigs, Math.floor(opts.keys));
  const script = keys * 35 + 15;
  const witness = 1 + sigs * 74 + 1 + script;
  let outputs = 0;
  for (const address of opts.outputs) outputs += outputVbytes(address);
  const nonWitness = 4 + 1 + inputs * 41 + 1 + outputs + 4;
  const weight = nonWitness * 4 + 2 + inputs * witness;
  return Math.max(1, Math.ceil(weight / 4));
}

export function feeFromRate(satPerVb: number, vbytes: number): number {
  if (!Number.isFinite(satPerVb) || satPerVb <= 0 || !Number.isFinite(vbytes) || vbytes < 1) return 0;
  return Math.max(1, Math.ceil(satPerVb * vbytes));
}

function outputVbytes(address: string): number {
  try {
    const script = scriptPubKeyFromAddress(address.trim()).length / 2;
    if (script > 0) return 8 + 1 + script;
  } catch {
    /* unknown address: assume p2wsh */
  }
  return 43;
}

export function planSpend(opts: {
  coins: SpendCoin[];
  payTo: string;
  paySats: number;
  feeSats: number;
  changeAddress?: string;
  sendAll?: boolean;
  rbf?: boolean;
}): SpendPlan {
  const inputs = opts.coins.filter((c) => c.txid && c.address && c.amountBtc > 0);
  if (!inputs.length) throw new Error("tx.needCoins");
  const payTo = opts.payTo.trim();
  if (!payTo) throw new Error("tx.needAddr");
  scriptPubKeyFromAddress(payTo);
  const feeSats = Math.floor(opts.feeSats);
  if (!Number.isFinite(feeSats) || feeSats < 1) throw new Error("tx.err.fee");
  const inputSats = inputs.reduce((s, c) => s + btcToSats(c.amountBtc), 0);
  if (inputSats <= feeSats) throw new Error("tx.funds");

  const budget = inputSats - feeSats;
  const paySats = opts.sendAll ? budget : Math.floor(opts.paySats);
  if (!Number.isFinite(paySats) || paySats < DUST_SATS) throw new Error("tx.dust");
  if (paySats > budget) throw new Error("tx.funds");

  const outputs: { address: string; sats: number }[] = [{ address: payTo, sats: paySats }];
  const changeSats = budget - paySats;
  if (changeSats > 0) {
    if (changeSats < DUST_SATS) throw new Error("tx.dust");
    const change = (opts.changeAddress || "").trim();
    if (!change) throw new Error("tx.err.change");
    scriptPubKeyFromAddress(change);
    outputs.push({ address: change, sats: changeSats });
  }
  return { inputs, outputs, feeSats, inputSats, rbf: opts.rbf !== false };
}

export function planPayments(opts: {
  coins: SpendCoin[];
  payments: { address: string; sats: number }[];
  feeSats: number;
  changeAddress?: string;
  rbf?: boolean;
}): SpendPlan {
  const inputs = opts.coins.filter((c) => c.txid && c.address && c.amountBtc > 0);
  if (!inputs.length) throw new Error("tx.needCoins");
  const feeSats = Math.floor(opts.feeSats);
  if (!Number.isFinite(feeSats) || feeSats < 1) throw new Error("tx.err.fee");
  const payments = opts.payments.filter((p) => p.address.trim());
  if (!payments.length) throw new Error("tx.needAddr");
  for (const p of payments) {
    scriptPubKeyFromAddress(p.address.trim());
    if (!Number.isFinite(p.sats) || p.sats < DUST_SATS) throw new Error("tx.dust");
  }
  const inputSats = inputs.reduce((s, c) => s + btcToSats(c.amountBtc), 0);
  const paySats = payments.reduce((s, p) => s + Math.floor(p.sats), 0);
  if (inputSats < paySats + feeSats) throw new Error("tx.funds");
  const outputs = payments.map((p) => ({ address: p.address.trim(), sats: Math.floor(p.sats) }));
  const changeSats = inputSats - paySats - feeSats;
  if (changeSats > 0) {
    if (changeSats < DUST_SATS) throw new Error("tx.dust");
    const change = (opts.changeAddress || "").trim();
    if (!change) throw new Error("tx.err.change");
    scriptPubKeyFromAddress(change);
    outputs.push({ address: change, sats: changeSats });
  }
  return { inputs, outputs, feeSats, inputSats, rbf: opts.rbf !== false };
}

export function addressFromScan(text: string): string {
  const raw = text.trim();
  const uri = raw.match(/bitcoin:([a-z0-9]+)/i);
  const body = (uri?.[1] || raw).split("?")[0]?.trim() ?? "";
  return body;
}

export function buildPsbt(plan: SpendPlan): string {
  const tx = unsignedTx(plan);
  const parts: Uint8Array[] = [bytes("psbt"), Uint8Array.of(0xff)];
  parts.push(mapEntry(Uint8Array.of(0x00), tx));
  parts.push(Uint8Array.of(0x00));
  for (const coin of plan.inputs) {
    const script = hexToBytes(scriptPubKeyFromAddress(coin.address));
    const value = new Uint8Array(8 + 1 + script.length);
    writeU64(value, 0, btcToSats(coin.amountBtc));
    value[8] = script.length;
    value.set(script, 9);
    parts.push(mapEntry(Uint8Array.of(0x01), value));
    parts.push(Uint8Array.of(0x00));
  }
  for (let i = 0; i < plan.outputs.length; i++) parts.push(Uint8Array.of(0x00));
  return bytesToBase64(concat(parts));
}

function unsignedTx(plan: SpendPlan): Uint8Array {
  const seq = plan.rbf ? RBF_SEQUENCE : FINAL_SEQUENCE;
  const body: Uint8Array[] = [];
  body.push(u32(2));
  body.push(compact(plan.inputs.length));
  for (const coin of plan.inputs) {
    body.push(txidInternal(coin.txid));
    body.push(u32(coin.vout >>> 0));
    body.push(Uint8Array.of(0x00));
    body.push(u32(seq));
  }
  body.push(compact(plan.outputs.length));
  for (const out of plan.outputs) {
    const script = hexToBytes(scriptPubKeyFromAddress(out.address));
    const value = new Uint8Array(8);
    writeU64(value, 0, out.sats);
    body.push(value);
    body.push(compact(script.length));
    body.push(script);
  }
  body.push(u32(0));
  return concat(body);
}

function mapEntry(key: Uint8Array, value: Uint8Array): Uint8Array {
  return concat([compact(key.length), key, compact(value.length), value]);
}

function txidInternal(txid: string): Uint8Array {
  const raw = hexToBytes(txid.trim());
  if (raw.length !== 32) throw new Error("tx.txid");
  return raw.reverse();
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.trim().toLowerCase();
  if (!h || h.length % 2) throw new Error("tx.txid");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    const n = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isFinite(n)) throw new Error("tx.txid");
    out[i] = n;
  }
  return out;
}

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}

function writeU64(buf: Uint8Array, offset: number, n: number): void {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const hi = Math.floor(n / 2 ** 32);
  view.setUint32(offset, n >>> 0, true);
  view.setUint32(offset + 4, hi, true);
}

function compact(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) {
    const b = new Uint8Array(3);
    b[0] = 0xfd;
    new DataView(b.buffer).setUint16(1, n, true);
    return b;
  }
  const b = new Uint8Array(5);
  b[0] = 0xfe;
  new DataView(b.buffer).setUint32(1, n, true);
  return b;
}

function bytes(text: string): Uint8Array {
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function extractSignedTx(text: string): string {
  const raw = text.trim().replace(/\s+/g, "");
  if (!raw) throw new Error("tx.err.empty");
  if (/^[0-9a-fA-F]+$/.test(raw)) {
    if (raw.length < 20 || raw.length % 2) throw new Error("tx.err.signed");
    return raw.toLowerCase();
  }
  const decoded = base64ToBytes(raw);
  if (!decoded || !isPsbt(decoded)) throw new Error("tx.err.signed");
  return bytesToHex(finalizePsbt(decoded));
}

function bytesToBase64(data: Uint8Array): string {
  let bin = "";
  for (const b of data) bin += String.fromCharCode(b);
  if (typeof btoa === "function") return btoa(bin);
  return Buffer.from(data).toString("base64");
}

function isPsbt(buf: Uint8Array): boolean {
  return buf.length > 5 && buf[0] === 0x70 && buf[1] === 0x73 && buf[2] === 0x62 && buf[3] === 0x74 && buf[4] === 0xff;
}

function finalizePsbt(buf: Uint8Array): Uint8Array {
  let i = 5;
  const maps: { key: Uint8Array; value: Uint8Array }[][] = [];
  while (i < buf.length) {
    const map: { key: Uint8Array; value: Uint8Array }[] = [];
    for (;;) {
      const keyLen = readCompact(buf, i);
      i = keyLen.next;
      if (keyLen.n === 0) break;
      const key = readBytes(buf, i, keyLen.n);
      i = key.next;
      const valLen = readCompact(buf, i);
      i = valLen.next;
      const value = readBytes(buf, i, valLen.n);
      i = value.next;
      map.push({ key: key.bytes, value: value.bytes });
    }
    maps.push(map);
    if (i >= buf.length) break;
  }
  const unsigned = (maps[0] ?? []).find((e) => e.key.length === 1 && e.key[0] === 0x00)?.value;
  if (!unsigned) throw new Error("tx.err.signed");
  const parsed = parseUnsigned(unsigned);
  const inputMaps = maps.slice(1, 1 + parsed.inputs.length);
  if (inputMaps.length !== parsed.inputs.length) throw new Error("tx.err.signed");
  const finals = inputMaps.map((map) => {
    const scriptSig = map.find((e) => e.key.length === 1 && e.key[0] === 0x07)?.value ?? new Uint8Array();
    const witness = map.find((e) => e.key.length === 1 && e.key[0] === 0x08)?.value ?? new Uint8Array();
    if (!scriptSig.length && !witness.length) throw new Error("tx.err.unsigned");
    return { scriptSig, witness };
  });
  const witnessFlag = finals.some((f) => f.witness.length > 0);
  const out: Uint8Array[] = [parsed.version];
  if (witnessFlag) out.push(Uint8Array.of(0x00, 0x01));
  out.push(compact(parsed.inputs.length));
  parsed.inputs.forEach((vin, n) => {
    out.push(vin.outpoint, compact(finals[n]!.scriptSig.length), finals[n]!.scriptSig, vin.sequence);
  });
  out.push(parsed.outputs);
  if (witnessFlag) {
    for (const f of finals) out.push(witnessStack(f.witness));
  }
  out.push(parsed.locktime);
  return concat(out);
}

function parseUnsigned(tx: Uint8Array): {
  version: Uint8Array;
  inputs: { outpoint: Uint8Array; sequence: Uint8Array }[];
  outputs: Uint8Array;
  locktime: Uint8Array;
} {
  let i = 0;
  const version = readBytes(tx, i, 4);
  i = version.next;
  const nIn = readCompact(tx, i);
  i = nIn.next;
  const inputs: { outpoint: Uint8Array; sequence: Uint8Array }[] = [];
  for (let n = 0; n < nIn.n; n++) {
    const outpoint = readBytes(tx, i, 36);
    i = outpoint.next;
    const scriptLen = readCompact(tx, i);
    i = scriptLen.next + scriptLen.n;
    const sequence = readBytes(tx, i, 4);
    i = sequence.next;
    inputs.push({ outpoint: outpoint.bytes, sequence: sequence.bytes });
  }
  const outputsAt = i;
  const nOut = readCompact(tx, i);
  i = nOut.next;
  for (let n = 0; n < nOut.n; n++) {
    i += 8;
    const scriptLen = readCompact(tx, i);
    i = scriptLen.next + scriptLen.n;
  }
  const outputs = tx.slice(outputsAt, i);
  const locktime = readBytes(tx, i, 4);
  return { version: version.bytes, inputs, outputs, locktime: locktime.bytes };
}

function witnessStack(blob: Uint8Array): Uint8Array {
  if (!blob.length) return compact(0);
  let i = 0;
  let count = 0;
  while (i < blob.length) {
    const len = readCompact(blob, i);
    i = len.next + len.n;
    if (i > blob.length) throw new Error("tx.err.signed");
    count++;
  }
  return concat([compact(count), blob]);
}

function readCompact(buf: Uint8Array, i: number): { n: number; next: number } {
  if (i >= buf.length) throw new Error("tx.err.signed");
  const flag = buf[i]!;
  if (flag < 0xfd) return { n: flag, next: i + 1 };
  if (flag === 0xfd) return { n: new DataView(buf.buffer, buf.byteOffset + i + 1, 2).getUint16(0, true), next: i + 3 };
  if (flag === 0xfe) return { n: new DataView(buf.buffer, buf.byteOffset + i + 1, 4).getUint32(0, true), next: i + 5 };
  throw new Error("tx.err.signed");
}

function readBytes(buf: Uint8Array, i: number, n: number): { bytes: Uint8Array; next: number } {
  if (i + n > buf.length) throw new Error("tx.err.signed");
  return { bytes: buf.slice(i, i + n), next: i + n };
}

function base64ToBytes(text: string): Uint8Array | null {
  try {
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function bytesToHex(data: Uint8Array): string {
  return [...data].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type SigInput = { index: number; pubkeys: string[]; finalized: boolean };

export function inspectSignatures(text: string): { inputs: SigInput[] } {
  const raw = text.trim().replace(/\s+/g, "");
  if (!raw) throw new Error("tx.err.empty");
  if (/^[0-9a-fA-F]+$/.test(raw)) return { inputs: [] };
  const decoded = base64ToBytes(raw);
  if (!decoded || !isPsbt(decoded)) throw new Error("tx.err.signed");
  const maps = parseMaps(decoded);
  const unsigned = (maps[0] ?? []).find((e) => e.key.length === 1 && e.key[0] === 0x00)?.value;
  const count = unsigned ? parseUnsigned(unsigned).inputs.length : 0;
  const inputs: SigInput[] = [];
  for (let n = 0; n < count; n++) {
    const map = maps[1 + n] ?? [];
    const pubkeys = map
      .filter((e) => e.key.length > 1 && e.key[0] === 0x02)
      .map((e) => bytesToHex(e.key.slice(1)));
    const finalized = map.some((e) => e.key.length === 1 && (e.key[0] === 0x07 || e.key[0] === 0x08) && e.value.length > 0);
    inputs.push({ index: n, pubkeys, finalized });
  }
  return { inputs };
}

export function withPartialSigs(
  psbt: string,
  sigs: { input: number; pubkey: Uint8Array; signature: Uint8Array }[],
): string {
  const decoded = base64ToBytes(psbt);
  if (!decoded || !isPsbt(decoded)) throw new Error("tx.err.signed");
  const maps = parseMaps(decoded);
  for (const sig of sigs) {
    const map = maps[1 + sig.input];
    if (!map) throw new Error("tx.err.signed");
    const key = new Uint8Array(1 + sig.pubkey.length);
    key[0] = 0x02;
    key.set(sig.pubkey, 1);
    map.push({ key, value: sig.signature });
  }
  return bytesToBase64(encodePsbt(maps));
}

function parseMaps(buf: Uint8Array): { key: Uint8Array; value: Uint8Array }[][] {
  let i = 5;
  const maps: { key: Uint8Array; value: Uint8Array }[][] = [];
  while (i < buf.length) {
    const map: { key: Uint8Array; value: Uint8Array }[] = [];
    for (;;) {
      const keyLen = readCompact(buf, i);
      i = keyLen.next;
      if (keyLen.n === 0) break;
      const key = readBytes(buf, i, keyLen.n);
      i = key.next;
      const valLen = readCompact(buf, i);
      i = valLen.next;
      const value = readBytes(buf, i, valLen.n);
      i = value.next;
      map.push({ key: key.bytes, value: value.bytes });
    }
    maps.push(map);
  }
  return maps;
}

function encodePsbt(maps: { key: Uint8Array; value: Uint8Array }[][]): Uint8Array {
  const parts: Uint8Array[] = [bytes("psbt"), Uint8Array.of(0xff)];
  for (const map of maps) {
    for (const entry of map) parts.push(mapEntry(entry.key, entry.value));
    parts.push(Uint8Array.of(0x00));
  }
  return concat(parts);
}
