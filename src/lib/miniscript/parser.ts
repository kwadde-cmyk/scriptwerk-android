import { uid } from "../utils.ts";
import type { MsNode, WrapCode } from "./ast.ts";
import { hole } from "./ast.ts";

const WRAP_SET = new Set<WrapCode>(["v", "a", "c", "d", "j", "n", "t", "u", "l", "s"]);
const FRAGMENTS = new Set([
  "pk",
  "pkh",
  "multi",
  "sortedmulti",
  "thresh",
  "older",
  "after",
  "and_v",
  "and_b",
  "andor",
  "or_i",
  "or_d",
  "or_c",
  "or_b",
]);

export interface ParseResult {
  node: MsNode;
  rest?: string;
  wrapper: "none" | "wsh" | "sh_wsh" | "tr";
  checksum?: string;
  rawInner: string;
}

export function parseAny(input: string): ParseResult {
  const trimmed = stripScriptComments(input.trim());
  if (!trimmed) throw new Error("Leere Eingabe.");

  const bsms = extractFromBsms(trimmed);
  const src = (bsms ?? trimmed).replace(/\s+/g, "");

  const hash = src.lastIndexOf("#");
  let body = src;
  let checksum: string | undefined;
  if (hash > 0 && /^[a-z0-9]{8}$/i.test(src.slice(hash + 1))) {
    checksum = src.slice(hash + 1);
    body = src.slice(0, hash);
  }

  let wrapper: ParseResult["wrapper"] = "none";
  let inner = body;
  if (inner.startsWith("wsh(") && inner.endsWith(")")) {
    wrapper = "wsh";
    inner = inner.slice(4, -1);
  } else if (inner.startsWith("sh(wsh(") && inner.endsWith("))")) {
    wrapper = "sh_wsh";
    inner = inner.slice(7, -2);
  } else if (inner.startsWith("tr(")) {
    throw new Error("Taproot-Descriptor (tr) wird in dieser Version noch nicht gelesen.");
  }

  const node = parseExpression(inner, 0).node;
  return { node, wrapper, checksum, rawInner: inner };
}

function stripScriptComments(s: string): string {
  return s
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n")
    .trim();
}

function extractFromBsms(s: string): string | null {
  const t = s.trim();
  if (!t.toUpperCase().startsWith("BSMS")) return null;
  const parts = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const desc = parts.find((l) => l.startsWith("wsh(") || l.startsWith("sh(") || l.startsWith("tr("));
  if (desc) return desc;
  const compact = t.replace(/\s+/g, "");
  const idx = compact.search(/wsh\(|sh\(|tr\(/);
  if (idx >= 0) return compact.slice(idx);
  throw new Error("BSMS ohne Descriptor-Zeile.");
}

interface Cursor {
  s: string;
  i: number;
}

function parseExpression(s: string, start: number): { node: MsNode; i: number } {
  const c: Cursor = { s, i: start };
  skip(c);
  const wrappers: WrapCode[] = [];
  while (true) {
    skip(c);
    const ident = peekIdent(c);
    if (ident && WRAP_SET.has(ident as WrapCode) && c.s[c.i + ident.length] === ":") {
      wrappers.push(ident as WrapCode);
      c.i += ident.length + 1;
      continue;
    }
    break;
  }

  skip(c);
  const name = readIdent(c);
  if (!name) throw new Error(`Unerwartetes Zeichen an Position ${c.i}.`);

  if (c.s[c.i] !== "(") {
    throw new Error(`Erwartet '(' nach ${name}.`);
  }
  if (!FRAGMENTS.has(name)) {
    throw new Error(`Unbekanntes Fragment "${name}".`);
  }
  const args = readArgs(c);
  let node = buildFromArgs(name, args);
  for (let w = wrappers.length - 1; w >= 0; w--) {
    node = { id: uid(), kind: "wrap", wrap: wrappers[w]!, child: node };
  }
  return { node, i: c.i };
}

function buildFromArgs(name: string, args: string[]): MsNode {
  switch (name) {
    case "pk":
    case "pkh":
      if (args.length !== 1) throw new Error(`${name} braucht genau einen Key.`);
      return { id: uid(), kind: name, key: args[0]! };
    case "older":
    case "after": {
      if (args.length !== 1) throw new Error(`${name} braucht eine Zahl.`);
      const n = Number(args[0]);
      if (!Number.isFinite(n) || n < 1) throw new Error(`${name}(${args[0]}) ist ungültig.`);
      return { id: uid(), kind: name, n: Math.floor(n) };
    }
    case "multi":
    case "sortedmulti": {
      if (args.length < 2) throw new Error("multi braucht k und mindestens einen Key.");
      const k = Number(args[0]);
      const keys = args.slice(1);
      if (!Number.isInteger(k) || k < 1 || k > keys.length) {
        throw new Error(`multi: k=${args[0]} passt nicht zu ${keys.length} Keys.`);
      }
      return { id: uid(), kind: "multi", k, keys, sorted: name === "sortedmulti" };
    }
    case "thresh": {
      if (args.length < 2) throw new Error("thresh braucht k und Zweige.");
      const k = Number(args[0]);
      const children = args.slice(1).map((a) => parseExpression(a, 0).node);
      if (!Number.isInteger(k) || k < 1 || k > children.length) {
        throw new Error(`thresh: k=${args[0]} passt nicht.`);
      }
      return { id: uid(), kind: "thresh", k, children };
    }
    case "and_v":
    case "and_b":
    case "or_i":
    case "or_d":
    case "or_c":
    case "or_b": {
      if (args.length !== 2) throw new Error(`${name} braucht genau zwei Argumente.`);
      return {
        id: uid(),
        kind: name,
        left: parseExpression(args[0]!, 0).node,
        right: parseExpression(args[1]!, 0).node,
      };
    }
    case "andor": {
      if (args.length !== 3) throw new Error("andor braucht drei Argumente (X, Y, Z).");
      return {
        id: uid(),
        kind: "andor",
        x: parseExpression(args[0]!, 0).node,
        y: parseExpression(args[1]!, 0).node,
        z: parseExpression(args[2]!, 0).node,
      };
    }
    default:
      return hole();
  }
}

function skip(c: Cursor) {
  while (c.i < c.s.length && /\s/.test(c.s[c.i]!)) c.i++;
}

function peekIdent(c: Cursor): string | null {
  const m = c.s.slice(c.i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
  return m ? m[0] : null;
}

function readIdent(c: Cursor): string {
  const m = peekIdent(c);
  if (!m) return "";
  c.i += m.length;
  return m;
}

function readArgs(c: Cursor): string[] {
  if (c.s[c.i] !== "(") throw new Error("Erwartet '('.");
  c.i++;
  const args: string[] = [];
  let depth = 1;
  let start = c.i;
  let inBrackets = 0;
  while (c.i < c.s.length) {
    const ch = c.s[c.i]!;
    if (ch === "[") inBrackets++;
    if (ch === "]") inBrackets = Math.max(0, inBrackets - 1);
    if (ch === "(" && inBrackets === 0) depth++;
    else if (ch === ")" && inBrackets === 0) {
      depth--;
      if (depth === 0) {
        const piece = c.s.slice(start, c.i).trim();
        if (piece) args.push(piece);
        c.i++;
        return args;
      }
    } else if (ch === "," && depth === 1 && inBrackets === 0) {
      args.push(c.s.slice(start, c.i).trim());
      start = c.i + 1;
    }
    c.i++;
  }
  throw new Error("Klammern nicht geschlossen.");
}
