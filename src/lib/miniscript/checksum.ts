/** BIP-380 descriptor checksum (BigInt — values exceed 32-bit). */

const INPUT_CHARSET =
  "0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#\"\\ ";
const CHECKSUM_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [
  0xf5dee51989n,
  0xa9fdca3312n,
  0x1bab10e32dn,
  0x3706b1677an,
  0x644d626ffdn,
];

function polymod(symbols: number[]): bigint {
  let chk = 1n;
  for (const value of symbols) {
    const top = chk >> 35n;
    chk = ((chk & 0x7ffffffffn) << 5n) ^ BigInt(value);
    for (let i = 0; i < 5; i++) {
      if ((top >> BigInt(i)) & 1n) chk ^= GEN[i]!;
    }
  }
  return chk;
}

function expand(s: string): number[] | null {
  const groups: number[] = [];
  const symbols: number[] = [];
  for (const ch of s) {
    const v = INPUT_CHARSET.indexOf(ch);
    if (v < 0) return null;
    symbols.push(v & 31);
    groups.push(v >> 5);
    if (groups.length === 3) {
      symbols.push(groups[0]! * 9 + groups[1]! * 3 + groups[2]!);
      groups.length = 0;
    }
  }
  if (groups.length === 1) symbols.push(groups[0]!);
  else if (groups.length === 2) symbols.push(groups[0]! * 3 + groups[1]!);
  return symbols;
}

export function descsumCreate(s: string): string {
  const expanded = expand(s);
  if (!expanded) return s;
  const checksum = polymod(expanded.concat([0, 0, 0, 0, 0, 0, 0, 0])) ^ 1n;
  let out = s + "#";
  for (let i = 0; i < 8; i++) {
    const idx = Number((checksum >> BigInt(5 * (7 - i))) & 31n);
    out += CHECKSUM_CHARSET[idx]!;
  }
  return out;
}

export function stripChecksum(s: string): string {
  const hash = s.lastIndexOf("#");
  if (hash >= 0 && /^[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{8}$/.test(s.slice(hash + 1))) {
    return s.slice(0, hash);
  }
  return s;
}

export function checksumOf(s: string): string {
  const raw = stripChecksum(s);
  const withCs = descsumCreate(raw);
  const hash = withCs.lastIndexOf("#");
  return hash >= 0 ? withCs.slice(hash + 1) : "";
}

/** Bitcoin Core getdescriptorinfo ToString() keeps the first multipath branch. */
export function coreCanonicalBody(s: string): string {
  return stripChecksum(s)
    .replace(/\/<(\d+);\d+>\//g, "/$1/")
    .replace(/\[([^\]]*)\]/g, (_m, inner: string) => `[${inner.replace(/h/g, "'")}]`);
}

export const CHILD_PATH_FORMS = ["<0;1>/*", "0/*"] as const;

export function rewriteDescriptorChildPath(desc: string, tail: string): string {
  const wantMulti = tail.replace(/^\//, "").includes("<");
  const body = stripChecksum(desc).replace(/\/(?:<(\d+);(\d+)>|(\d+))\/\*/g, (_m, a, _b, s) => {
    const lo = a != null ? Number(a) : Number(s);
    return wantMulti ? `/<${lo};${lo + 1}>/*` : `/${lo}/*`;
  });
  return descsumCreate(body);
}

export function descsumCheck(s: string): boolean {
  const hash = s.lastIndexOf("#");
  if (hash < 0 || s.length - hash - 1 !== 8) return false;
  const expanded = expand(s.slice(0, hash));
  if (!expanded) return false;
  const extra: number[] = [];
  for (const ch of s.slice(hash + 1)) {
    const v = CHECKSUM_CHARSET.indexOf(ch);
    if (v < 0) return false;
    extra.push(v);
  }
  return polymod(expanded.concat(extra)) === 1n;
}
