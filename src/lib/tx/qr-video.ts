const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export type QrVideoProgress = {
  got: number;
  total: number | null;
  payload?: string;
  error?: string;
};

type UrDecoder = {
  receivePart(part: string): boolean;
  isComplete(): boolean;
  isError(): boolean;
  resultUR(): { decodeCBOR(): unknown };
  receivedPartIndexes(): number[];
  expectedPartCount(): number;
};

type Kind = "ur" | "bbqr" | "specter";

export function looksLikePsbt(text: string): boolean {
  const raw = text.trim().replace(/\s+/g, "");
  return raw.startsWith("cHNidP") || (/^[0-9a-fA-F]+$/.test(raw) && raw.toLowerCase().startsWith("70736274"));
}

export function psbtText(text: string): string {
  const raw = text.trim().replace(/\s+/g, "");
  if (raw.startsWith("cHNidP")) return raw;
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.toLowerCase().startsWith("70736274")) return bytesToBase64(hexToBytes(raw));
  return raw;
}

/** Collects one static QR or a looping QR video (UR, BBQr, Specter `p1ofN`). */
export function createQrVideo() {
  let kind: Kind | null = null;
  let ur: UrDecoder | null = null;
  let urReady: Promise<void> | null = null;
  const bbqr = new Map<number, string>();
  let bbqrTotal = 0;
  let bbqrEnc = "";
  const specter = new Map<number, string>();
  let specterTotal = 0;
  const seen = new Set<string>();
  let payload: string | undefined;

  function progress(error?: string): QrVideoProgress {
    if (payload) return { got: totalOf() || 1, total: totalOf(), payload };
    if (kind === "ur" && ur) {
      const total = ur.expectedPartCount() || null;
      return { got: ur.receivedPartIndexes().length, total, error };
    }
    if (kind === "bbqr") return { got: bbqr.size, total: bbqrTotal || null, error };
    if (kind === "specter") return { got: specter.size, total: specterTotal || null, error };
    return { got: 0, total: null, error };
  }

  function totalOf(): number | null {
    if (kind === "bbqr") return bbqrTotal || null;
    if (kind === "specter") return specterTotal || null;
    if (kind === "ur" && ur) return ur.expectedPartCount() || null;
    return payload ? 1 : null;
  }

  return {
    async push(raw: string): Promise<QrVideoProgress> {
      const text = raw.trim();
      if (!text || payload) return progress();
      if (seen.has(text)) return progress();
      seen.add(text);
      try {
        if (!kind) {
          if (looksLikePsbt(text)) {
            payload = psbtText(text);
            return progress();
          }
          if (/^ur:/i.test(text)) kind = "ur";
          else if (/^B\$/i.test(text)) kind = "bbqr";
          else if (/^p\d+of\d+\s/i.test(text)) kind = "specter";
          else return { got: 0, total: null, error: "tx.err.qr" };
        }
        if (kind === "ur") {
          if (!/^ur:/i.test(text)) return progress();
          if (!ur) {
            urReady ??= loadUrDecoder().then((Decoder) => {
              ur = new Decoder();
            });
            await urReady;
          }
          ur!.receivePart(text.toLowerCase());
          if (ur!.isError()) return progress("tx.err.qr");
          if (ur!.isComplete()) payload = bytesToBase64(asBytes(ur!.resultUR().decodeCBOR()));
          return progress();
        }
        if (kind === "bbqr") {
          const part = parseBbqr(text);
          if (!part) return progress();
          if (!bbqrEnc) bbqrEnc = part.enc;
          if (part.enc !== bbqrEnc || (bbqrTotal && part.total !== bbqrTotal)) return progress();
          bbqrTotal = part.total;
          bbqr.set(part.index, part.data);
          if (bbqr.size === bbqrTotal) payload = bytesToBase64(await decodeBbqr(bbqrEnc, joinParts(bbqr, bbqrTotal)));
          return progress();
        }
        const part = parseSpecter(text);
        if (!part) return progress();
        if (specterTotal && part.total !== specterTotal) return progress();
        specterTotal = part.total;
        specter.set(part.index, part.data);
        if (specter.size === specterTotal) payload = psbtText(joinParts(specter, specterTotal));
        return progress();
      } catch {
        return progress("tx.err.qr");
      }
    },
  };
}

async function loadUrDecoder(): Promise<new () => UrDecoder> {
  const g = globalThis as typeof globalThis & { process?: unknown; Buffer?: unknown };
  if (!g.process) {
    g.process = {
      browser: true,
      version: "v20.0.0",
      env: {},
      nextTick: (fn: (...args: unknown[]) => void) => queueMicrotask(() => fn()),
      stdout: undefined,
      stderr: undefined,
      emitWarning: () => undefined,
    } as unknown as typeof process;
  }
  if (!g.Buffer) {
    const mod = await import("buffer");
    g.Buffer = mod.Buffer;
  }
  const ur = await import("@ngraveio/bc-ur");
  return ur.URDecoder as unknown as new () => UrDecoder;
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value && typeof value === "object" && "length" in value && typeof (value as { length: number }).length === "number") {
    return Uint8Array.from(value as ArrayLike<number>);
  }
  throw new Error("tx.err.qr");
}

function parseBbqr(text: string): { enc: string; index: number; total: number; data: string } | null {
  const parts = text.trim().split("$");
  if (parts.length < 5 || parts[0]!.toUpperCase() !== "B") return null;
  const enc = parts[1]!.toUpperCase();
  if (enc !== "H" && enc !== "2" && enc !== "Z") return null;
  const count = parts[3]!.split("/");
  const index = Number(count[0]);
  const total = Number(count[1]);
  if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || total < 1 || index > total) return null;
  return { enc, index, total, data: parts.slice(4).join("$") };
}

function parseSpecter(text: string): { index: number; total: number; data: string } | null {
  const m = text.trim().match(/^p(\d+)of(\d+)\s+([\s\S]+)$/i);
  if (!m) return null;
  const index = Number(m[1]);
  const total = Number(m[2]);
  if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || total < 1 || index > total) return null;
  return { index, total, data: m[3]!.trim() };
}

function joinParts(parts: Map<number, string>, total: number): string {
  let out = "";
  for (let i = 1; i <= total; i++) out += parts.get(i) ?? "";
  return out;
}

async function decodeBbqr(enc: string, payload: string): Promise<Uint8Array> {
  if (enc === "H") return hexToBytes(payload);
  const raw = base32Decode(payload);
  if (enc === "2") return raw;
  const stream = new DecompressionStream("deflate");
  const copy = Uint8Array.from(raw);
  const buf = await new Response(new Blob([copy]).stream().pipeThrough(stream)).arrayBuffer();
  return new Uint8Array(buf);
}

function base32Decode(input: string): Uint8Array {
  const s = input.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let val = 0;
  const out: number[] = [];
  for (const ch of s) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("tx.err.qr");
    val = (val << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((val >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, "");
  if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) throw new Error("tx.err.qr");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToBase64(data: Uint8Array): string {
  let bin = "";
  for (const b of data) bin += String.fromCharCode(b);
  return btoa(bin);
}
