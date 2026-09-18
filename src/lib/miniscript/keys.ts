import { mapKeyStrings, type MsNode } from "./ast.ts";
import { uid } from "../utils.ts";
import { numberLocale, t, type Locale } from "../i18n.ts";

export interface KeyChild {
  id: string;
  path: string;
  xpub: string;
  fingerprint: string;
  note: string;
}

export interface KeyEntry {
  id: string;
  name: string;
  fingerprint: string;
  derivation: string;
  xpub: string;
  multipath: string;
  childPath: string;
  children: KeyChild[];
  note: string;
}

export function emptyKey(name: string, _network?: string): KeyEntry {
  return {
    id: `k_${name}_${Math.random().toString(36).slice(2, 6)}`,
    name,
    fingerprint: "",
    derivation: "48'/0'/0'/2'",
    xpub: "",
    multipath: "<0;1>",
    childPath: "<0;1>/*",
    children: [],
    note: "",
  };
}

export function normalizeKeyEntry(k: KeyEntry): KeyEntry {
  const multipath = k.multipath || "<0;1>";
  const childPath = k.childPath?.trim() || `${multipath}/*`;
  return {
    ...k,
    multipath,
    childPath,
    children: Array.isArray(k.children) ? k.children : [],
    note: k.note ?? "",
  };
}

export function sanitizeKeyNote(note?: string): string {
  const s = (note ?? "").trim();
  if (!s) return "";
  if (/^[A-Z]$/i.test(s)) return "";
  if (/^K\d+$/i.test(s)) return "";
  if (aliasAccountIndex(s) != null) return "";
  return s;
}

export function nextKeyName(existing: string[]): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (const ch of alphabet) {
    if (!existing.includes(ch)) return ch;
  }
  let i = 1;
  while (existing.includes(`K${i}`)) i++;
  return `K${i}`;
}

export function compareKeyNames(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
}

export function sequentialKeyNames(count: number): string[] {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    if (i < 26) {
      out.push(A[i]!);
      continue;
    }
    let x = i;
    let s = "";
    while (x >= 0) {
      s = A[x % 26]! + s;
      x = Math.floor(x / 26) - 1;
    }
    out.push(s);
  }
  return out;
}

export function orderMasterNames(stages: { keys: string[] }[], extra: { name: string }[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of stages) {
    const chunk = [...new Set(s.keys.map((n) => baseKeyName(n)).filter(Boolean))]
      .filter((n) => !seen.has(n))
      .sort(compareKeyNames);
    for (const n of chunk) {
      seen.add(n);
      out.push(n);
    }
  }
  const leftover = extra
    .map((k) => baseKeyName(k.name))
    .filter((n) => n && !seen.has(n))
    .sort(compareKeyNames);
  for (const n of leftover) {
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

export function sortKeyEntries(keys: KeyEntry[], stages: { keys: string[] }[]): KeyEntry[] {
  const order = orderMasterNames(stages, keys);
  const byName = new Map(keys.map((k) => [k.name, k]));
  const out: KeyEntry[] = [];
  const used = new Set<string>();
  for (const n of order) {
    const k = byName.get(n);
    if (!k || used.has(k.id)) continue;
    out.push(k);
    used.add(k.id);
  }
  for (const k of keys) {
    if (used.has(k.id)) continue;
    out.push(k);
  }
  return out;
}

export function retokenKey(tok: string, rename: Map<string, string>): string {
  if (rename.has(tok)) return rename.get(tok)!;
  const base = baseKeyName(tok);
  const next = rename.get(base);
  if (!next) return tok;
  return `${next}${tok.slice(base.length)}`;
}

export function relabelKeysFromA<S extends { keys: string[]; required?: string[] }>(
  keys: KeyEntry[],
  stages: S[],
  root: MsNode | null,
): { keys: KeyEntry[]; stages: S[]; root: MsNode | null } {
  const order = orderMasterNames(stages, keys);
  const letters = sequentialKeyNames(order.length);
  const rename = new Map<string, string>();
  order.forEach((old, i) => {
    const next = letters[i]!;
    if (old !== next) rename.set(old, next);
  });
  const mapTok = (tok: string) => retokenKey(tok, rename);
  const nextStages = stages.map((s) => ({
    ...s,
    keys: [...s.keys.map(mapTok)].sort(compareKeyNames),
    required: s.required?.map(mapTok),
  }));
  const nextKeys = sortKeyEntries(
    keys.map((k) => ({
      ...k,
      name: mapTok(k.name),
      children: k.children.map((c) => ({
        ...c,
        note: c.note && aliasAccountIndex(c.note) != null ? mapTok(c.note) : c.note,
      })),
    })),
    nextStages,
  );
  return {
    keys: nextKeys,
    stages: nextStages,
    root: root ? mapKeyStrings(root, mapTok) : null,
  };
}

function approx(n: number, locale: Locale = "de"): string {
  if (n <= 1) return t(locale, "approx.min");
  if (n < 144) return t(locale, "approx.hours", { n: Math.round((n * 10) / 60) });
  const days = n / 144;
  if (days < 1.5) return t(locale, "approx.day");
  if (days < 30) return t(locale, "approx.days", { n: Math.round(days) });
  const months = days / 30.44;
  if (months < 18) {
    const value = months < 10 ? months.toFixed(1) : String(Math.round(months));
    return t(locale, "approx.months", { n: value });
  }
  return t(locale, "approx.years", { n: (days / 365.25).toFixed(1) });
}

export function blocksApprox(n: number, locale: Locale = "de"): string {
  return approx(n, locale);
}

export function blocksToHuman(n: number, locale: Locale = "de"): string {
  return t(locale, "time.human", {
    n: n.toLocaleString(numberLocale(locale)),
    approx: approx(n, locale),
  });
}

export function blocksWhen(n: number, locale: Locale = "de"): string {
  if (n <= 0) return t(locale, "time.now");
  if (n === 1) return t(locale, "time.one");
  return t(locale, "time.after", {
    n: n.toLocaleString(numberLocale(locale)),
    approx: approx(n, locale),
  });
}

export interface ParsedKeyExpr {
  kind: "alias" | "origin" | "xpub";
  alias: string | null;
  fingerprint: string;
  derivation: string;
  xpub: string;
  multipath: string;
  childPath: string;
  raw: string;
  note?: string;
}

const XPUB_BODY = /^(xpub|tpub|ypub|zpub|vpub|Ypub|Zpub|Vpub)[1-9A-HJ-NP-Za-km-z]+/;
const ORIGIN_IN_TEXT =
  /\[[0-9a-fA-F]{8}(?:\/[^\]]*)?\](?:(?:xpub|tpub|ypub|zpub|vpub|Ypub|Zpub|Vpub)[1-9A-HJ-NP-Za-km-z]+(?:\/[^\s,)\]"']+)?|(?:m\/)?[0-9hH'/*<>;]+)?/;
const XPUB_IN_TEXT =
  /(?:xpub|tpub|ypub|zpub|vpub|Ypub|Zpub|Vpub)[1-9A-HJ-NP-Za-km-z]+(?:\/[^\s,)\]"']+)?/;

function blankParsed(raw: string, kind: ParsedKeyExpr["kind"] = "alias"): ParsedKeyExpr {
  return {
    kind,
    alias: kind === "alias" ? raw : null,
    fingerprint: "",
    derivation: "",
    xpub: "",
    multipath: "<0;1>",
    childPath: "<0;1>/*",
    raw,
  };
}

export function parseKeyExpr(raw: string): ParsedKeyExpr {
  const s = raw.trim();
  const origin = s.match(/^\[([0-9a-fA-F]{8})(?:\/([^\]]*))?\](.*)$/);
  if (origin) {
    let derivation = normalizePath(origin[2] || "");
    let rest = (origin[3] || "").trim();
    if (rest && !XPUB_BODY.test(rest) && /^(m\/)?[0-9hH']/.test(rest)) {
      const extra = normalizePath(rest);
      derivation = [derivation, extra].filter(Boolean).join("/");
      rest = "";
    }
    const split = rest ? splitXpubPath(rest) : { xpub: "", multipath: "<0;1>", childPath: "<0;1>/*" };
    const xpub = XPUB_BODY.test(split.xpub) ? split.xpub : "";
    return {
      kind: derivation || xpub ? "origin" : "alias",
      alias: null,
      fingerprint: origin[1]!,
      derivation,
      xpub,
      multipath: split.multipath,
      childPath: xpub ? split.childPath : "<0;1>/*",
      raw: s,
    };
  }
  if (XPUB_BODY.test(s)) {
    const rest = splitXpubPath(s);
    return {
      kind: "xpub",
      alias: null,
      fingerprint: "",
      derivation: "",
      xpub: rest.xpub,
      multipath: rest.multipath,
      childPath: rest.childPath,
      raw: s,
    };
  }
  return blankParsed(s);
}

function normalizePath(path: string): string {
  return path.replace(/h/g, "'").replace(/^m\//, "");
}

function splitXpubPath(rest: string): { xpub: string; multipath: string; childPath: string } {
  const s = rest.trim();
  const m = s.match(/^(xpub|tpub|ypub|zpub|vpub|Ypub|Zpub|Vpub)[1-9A-HJ-NP-Za-km-z]+/);
  if (!m) {
    return { xpub: s, multipath: "<0;1>", childPath: "<0;1>/*" };
  }
  const xpub = m[0]!;
  let tail = s.slice(xpub.length).replace(/^\//, "").trim();
  if (!tail) tail = "<0;1>/*";
  return { xpub, childPath: tail, multipath: multipathFromChildPath(tail) };
}

function multipathFromChildPath(childPath: string): string {
  const angle = childPath.match(/^<[^>]+>/);
  if (angle) return angle[0]!;
  return "<0;1>";
}

/** Liana-style: occurrence 1 = /<0;1>/*, 2 = /<2;3>/*, … Form from `base`, always count from 0. */
export function reuseBranchPath(base: string | undefined, occurrence: number): string {
  const n = Math.max(1, occurrence);
  const compact = (base || "<0;1>/*").replace(/^\//, "");
  const single = /^\d+\/\*$/.test(compact);
  const lo = 2 * (n - 1);
  if (single) return `${lo}/*`;
  return `<${lo};${lo + 1}>/*`;
}

export function looksLikePolicy(text: string): boolean {
  const t = text.trim();
  if (/^BSMS/i.test(t)) return true;
  return /\b(wsh|sh|tr|pkh|pk|multi|thresh|older|after|and_v|and_b|andor|or_i|or_d|or_c|or_b)\s*\(/i.test(
    t,
  );
}

export function parseKeyList(text: string): KeyEntry[] | null {
  if (looksLikePolicy(text)) return null;
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (!lines.length) return null;
  const keys: KeyEntry[] = [];
  const used: string[] = [];
  for (const line of lines) {
    const parts = splitNamedKeyLine(line);
    if (!parts) return null;
    const { name, note, expr } = parts;
    const parsed = parseKeyExpr(expr);
    if (parsed.kind === "alias") return null;
    const finalName = name ?? nextKeyName(used);
    used.push(finalName);
    keys.push({
      ...emptyKey(finalName),
      note: note || "",
      fingerprint: parsed.fingerprint,
      derivation: parsed.derivation || emptyKey(finalName).derivation,
      xpub: parsed.xpub,
      multipath: parsed.multipath || "<0;1>",
      childPath: parsed.childPath || "<0;1>/*",
    });
  }
  return keys.length ? keys : null;
}

function splitNamedKeyLine(line: string): { name?: string; note: string; expr: string } | null {
  const named = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/);
  if (!named) {
    const parsed = parseKeyExpr(line);
    if (parsed.kind === "alias") return null;
    return { note: "", expr: line };
  }
  let rest = named[2]!;
  let note = "";
  const quoted = rest.match(/^"([^"]+)"\s+(.+)$/);
  if (quoted) {
    note = quoted[1]!;
    rest = quoted[2]!;
  } else if (parseKeyExpr(rest).kind === "alias") {
    const word = rest.match(/^(\S+)\s+(\[.+|.+)$/);
    if (!word || parseKeyExpr(word[2]!).kind === "alias") return null;
    note = word[1]!;
    rest = word[2]!;
  }
  if (parseKeyExpr(rest).kind === "alias") return null;
  return { name: named[1], note, expr: rest };
}

function originExpr(k: {
  fingerprint?: string;
  derivation?: string;
  xpub: string;
  childPath?: string;
}): string {
  if (k.xpub.includes("[")) return k.xpub;
  const path = (k.derivation || "").replace(/^m\//, "");
  const tail = k.childPath ? `/${k.childPath.replace(/^\//, "")}` : "";
  return `[${k.fingerprint || "00000000"}/${path}]${k.xpub}${tail}`;
}

function formatOneKeyLine(alias: string, note: string, expr: string): string {
  const label = note.trim() && note.trim() !== alias ? note.trim() : "";
  return label ? `${alias} "${label}" ${expr}` : `${alias} ${expr}`;
}

export function formatKeyList(keys: KeyEntry[]): string {
  const lines: string[] = [];
  for (const k of keys) {
    if (!k.xpub.trim() && !k.fingerprint) continue;
    lines.push(formatOneKeyLine(k.name, k.note, originExpr(k)));
    for (const c of k.children) {
      if (!c.xpub.trim()) continue;
      const acc = parseAccountIndex(c.path);
      const alias = acc != null && acc > 0 ? `${k.name}${acc}` : `${k.name}_c`;
      lines.push(
        formatOneKeyLine(
          alias,
          k.note,
          originExpr({
            fingerprint: c.fingerprint || k.fingerprint,
            derivation: c.path,
            xpub: c.xpub,
          }),
        ),
      );
    }
  }
  return lines.join("\n");
}

/** Prefix policy/descriptor with named key lines so a file round-trips display names. */
export function formatExportWithKeys(body: string, keys: KeyEntry[]): string {
  const list = formatKeyList(keys);
  if (!list.trim()) return body;
  const comments = ["# Scriptwerk-keys", ...list.split("\n").map((l) => `# ${l}`)];
  return `${comments.join("\n")}\n${body}`;
}

export function peelKeysFromText(text: string): { body: string; keys: KeyEntry[] } {
  const lines = text.split(/\r?\n/);
  const keyLines: string[] = [];
  const body: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const unhash = trimmed.replace(/^#\s?/, "");
    if (!unhash) {
      body.push(line);
      continue;
    }
    if (/^scriptwerk-keys$/i.test(unhash)) continue;
    if (
      /^BSMS\b/i.test(unhash) ||
      /^(wsh|sh|tr)\(/i.test(unhash) ||
      /^\/\d/.test(unhash) ||
      unhash.startsWith("{") ||
      /^(name|wallet|BIP388)\b/i.test(unhash)
    ) {
      body.push(line);
      continue;
    }
    const named = splitNamedKeyLine(unhash);
    if (named && parseKeyExpr(named.expr).kind !== "alias") {
      keyLines.push(unhash);
      continue;
    }
    body.push(line);
  }
  const keys = keyLines.length ? parseKeyList(keyLines.join("\n")) ?? [] : [];
  return { body: body.join("\n"), keys };
}

export function applyKeyNames(keys: KeyEntry[], named: KeyEntry[]): KeyEntry[] {
  if (!named.length) return keys;
  const byXpub = new Map(
    named.filter((k) => k.xpub).map((k) => [xpubId(k.xpub), k] as const),
  );
  const byFp = new Map<string, KeyEntry>();
  for (const k of named) {
    const fp = formatFingerprint(k.fingerprint);
    if (fp && !byFp.has(fp)) byFp.set(fp, k);
  }
  const byName = new Map(named.map((k) => [k.name, k]));
  return keys.map((k) => {
    const hit =
      (k.xpub ? byXpub.get(xpubId(k.xpub)) : undefined) ??
      (formatFingerprint(k.fingerprint) ? byFp.get(formatFingerprint(k.fingerprint)) : undefined) ??
      byName.get(k.name);
    if (!hit) return k;
    const note = sanitizeKeyNote(hit.note) || k.note;
    const children = k.children.length
      ? k.children.map((c) => {
          const childHit = c.xpub ? byXpub.get(xpubId(c.xpub)) : undefined;
          return {
            ...c,
            note: sanitizeKeyNote(childHit?.note || c.note) || c.note,
          };
        })
      : hit.children;
    return { ...k, note, children };
  });
}

function pickNote(...notes: string[]): string {
  for (const n of notes) {
    const s = sanitizeKeyNote(n);
    if (s) return s;
  }
  return "";
}

function xpubId(s: string): string {
  const m = s.match(/(?:xpub|tpub|ypub|zpub|vpub|Ypub|Zpub|Vpub)[1-9A-HJ-NP-Za-km-z]+/);
  return m ? m[0]! : s.trim();
}

/** Expand master+child entries so A1/A2 can be looked up by alias or xpub. */
export function flattenKeysForLookup(keys: KeyEntry[]): KeyEntry[] {
  const out: KeyEntry[] = keys.map((k) => normalizeKeyEntry(k));
  const names = new Set(out.map((k) => k.name));
  for (const k of keys) {
    for (const c of k.children) {
      const acc = parseAccountIndex(c.path);
      const fromNote =
        c.note && baseKeyName(c.note) === k.name && aliasAccountIndex(c.note) != null ? c.note : "";
      const alias = fromNote || (acc != null && acc > 0 ? `${k.name}${acc}` : "");
      if (!alias || names.has(alias)) continue;
      names.add(alias);
      out.push({
        ...emptyKey(alias),
        note: c.note && c.note !== alias ? c.note : "",
        fingerprint: formatFingerprint(c.fingerprint || k.fingerprint),
        derivation: normalizePath(c.path) || emptyKey(alias).derivation,
        xpub: c.xpub,
        children: [],
      });
    }
  }
  return out;
}

export function extractKeysFromTree(
  root: MsNode,
  existing: KeyEntry[],
): { node: MsNode; keys: KeyEntry[] } {
  const lookup = flattenKeysForLookup(existing);
  const existingByName = new Map(lookup.map((k) => [k.name, k]));
  const existingByXpub = new Map(
    lookup.filter((k) => k.xpub).map((k) => [xpubId(k.xpub), k] as const),
  );
  const existingByFpAcc = new Map<string, KeyEntry>();
  for (const k of lookup) {
    const fp = formatFingerprint(k.fingerprint);
    const acc = parseAccountIndex(k.derivation);
    if (fp && acc != null) existingByFpAcc.set(`${fp}|${acc}`, k);
  }
  const assigned: KeyEntry[] = [];
  const usedNames = new Set<string>();
  const xpubToName = new Map<string, string>();
  const fpMaster = new Map<string, string>();

  const remember = (k: KeyEntry) => {
    const n = normalizeKeyEntry(k);
    assigned.push(n);
    usedNames.add(n.name);
    if (n.xpub) xpubToName.set(xpubId(n.xpub), n.name);
    const fp = formatFingerprint(n.fingerprint);
    const acc = parseAccountIndex(n.derivation) ?? 0;
    if (fp && acc === 0) fpMaster.set(fp, baseKeyName(n.name));
    else if (fp && !fpMaster.has(fp)) fpMaster.set(fp, baseKeyName(n.name));
  };

  const node = mapKeyStrings(root, (raw) => {
    const parsed = parseKeyExpr(raw);
    if (parsed.kind === "alias") {
      const alias = parsed.alias!;
      if (!usedNames.has(alias)) {
        const prev = existingByName.get(alias);
        remember(prev ? { ...prev, name: alias } : emptyKey(alias));
      }
      return alias;
    }
    const xid = parsed.xpub ? xpubId(parsed.xpub) : "";
    if (xid && xpubToName.has(xid)) return xpubToName.get(xid)!;

    const prevX = xid ? existingByXpub.get(xid) : undefined;
    if (prevX) {
      if (!usedNames.has(prevX.name)) {
        remember({
          ...prevX,
          fingerprint: parsed.fingerprint || prevX.fingerprint,
          derivation: parsed.derivation || prevX.derivation,
          xpub: xid || prevX.xpub,
          multipath: parsed.multipath || prevX.multipath,
          childPath: parsed.childPath || prevX.childPath,
        });
      }
      return prevX.name;
    }

    const fp = formatFingerprint(parsed.fingerprint);
    const acc = parseAccountIndex(parsed.derivation);
    const prevFp = fp && acc != null ? existingByFpAcc.get(`${fp}|${acc}`) : undefined;
    if (prevFp) {
      if (!usedNames.has(prevFp.name)) {
        remember({
          ...prevFp,
          fingerprint: fp || prevFp.fingerprint,
          derivation: parsed.derivation || prevFp.derivation,
          xpub: xid || prevFp.xpub,
          multipath: parsed.multipath || prevFp.multipath,
          childPath: parsed.childPath || prevFp.childPath,
        });
      }
      return prevFp.name;
    }

    if (fp && acc != null && acc > 0) {
      const masterName =
        fpMaster.get(fp) ||
        assigned.find((k) => formatFingerprint(k.fingerprint) === fp)?.name ||
        lookup.find((k) => formatFingerprint(k.fingerprint) === fp && (parseAccountIndex(k.derivation) ?? 0) === 0)
          ?.name;
      if (masterName) {
        const alias = `${baseKeyName(masterName)}${acc}`;
        if (!usedNames.has(alias)) {
          const prev = existingByName.get(alias);
          remember({
            ...(prev ?? emptyKey(alias)),
            fingerprint: fp,
            derivation: parsed.derivation,
            xpub: xid,
            multipath: parsed.multipath || "<0;1>",
            childPath: parsed.childPath || "<0;1>/*",
            note: prev?.note || "",
          });
        }
        fpMaster.set(fp, baseKeyName(masterName));
        return alias;
      }
    }

    const name = nextKeyName([...usedNames]);
    remember({
      ...emptyKey(name),
      fingerprint: parsed.fingerprint,
      derivation: parsed.derivation || emptyKey(name).derivation,
      xpub: xid,
      multipath: parsed.multipath || "<0;1>",
      childPath: parsed.childPath || "<0;1>/*",
    });
    return name;
  });

  return { node, keys: assigned };
}

export function keyIsFilled(k: KeyEntry): boolean {
  return Boolean(k.xpub.trim());
}

export function baseKeyName(token: string): string {
  const m = token.match(/^([A-Za-z_][A-Za-z_]*)(\d+)$/);
  return m ? m[1]! : token;
}

export function aliasAccountIndex(token: string): number | null {
  const m = token.match(/^([A-Za-z_][A-Za-z_]*)(\d+)$/);
  if (!m) return null;
  const n = Number(m[2]);
  return Number.isFinite(n) ? n : null;
}

export function keyNeedsAction(
  key: KeyEntry,
  extras: { account?: number }[] = [],
  reuse = true,
): "empty" | "child" | null {
  if (!keyIsFilled(key)) return "empty";
  if (reuse) return null;
  const missing = extras.some((e) => e.account != null && !childForAccount(key, e.account)?.xpub.trim());
  return missing ? "child" : null;
}

export function tokenNeedsAction(token: string, keys: KeyEntry[], reuse = true): boolean {
  const base = baseKeyName(token);
  const key = keys.find((k) => k.name === token) ?? keys.find((k) => k.name === base);
  if (!key) return true;
  if (!keyIsFilled(key)) return true;
  if (reuse) return false;
  const idx = token === base ? null : aliasAccountIndex(token);
  if (idx == null || idx < 1) return false;
  return !childForAccount(key, idx)?.xpub.trim();
}

export function groupKeysByFingerprint(keys: KeyEntry[]): {
  keys: KeyEntry[];
  rename: Map<string, string>;
} {
  const rename = new Map<string, string>();
  const groups = new Map<string, KeyEntry[]>();
  const ungrouped: KeyEntry[] = [];
  for (const raw of keys) {
    const k = normalizeKeyEntry(raw);
    const fp = formatFingerprint(k.fingerprint);
    if (!fp) {
      ungrouped.push(k);
      continue;
    }
    const list = groups.get(fp) ?? [];
    list.push(k);
    groups.set(fp, list);
  }
  const out: KeyEntry[] = [...ungrouped];
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0]!);
      continue;
    }
    const sorted = [...group].sort((a, b) => {
      const ia = parseAccountIndex(a.derivation) ?? 999;
      const ib = parseAccountIndex(b.derivation) ?? 999;
      if (ia !== ib) return ia - ib;
      return a.name.localeCompare(b.name);
    });
    const uniqueXpub: KeyEntry[] = [];
    for (const k of sorted) {
      const hit = uniqueXpub.find((x) => x.xpub && k.xpub && x.xpub === k.xpub);
      if (hit) {
        hit.note = pickNote(hit.note, k.note);
        rename.set(k.name, hit.name);
        continue;
      }
      uniqueXpub.push(k);
    }
    const master =
      uniqueXpub.find((k) => (parseAccountIndex(k.derivation) ?? aliasAccountIndex(k.name) ?? 0) === 0) ??
      uniqueXpub[0]!;
    const rest = uniqueXpub.filter((k) => k !== master);
    const children = [...master.children];
    for (const extra of rest) {
      const acc = parseAccountIndex(extra.derivation);
      const alias = acc != null && acc > 0 ? `${master.name}${acc}` : `${master.name}${rest.indexOf(extra) + 1}`;
      if (!children.some((c) => c.xpub === extra.xpub)) {
        children.push({
          id: uid("ck"),
          path: extra.derivation || extra.childPath || "",
          xpub: extra.xpub,
          fingerprint: extra.fingerprint || master.fingerprint,
          note: sanitizeKeyNote(extra.note),
        });
      }
      rename.set(extra.name, alias);
    }
    out.push({ ...master, note: pickNote(master.note, ...rest.map((k) => k.note)), children });
  }
  return { keys: out, rename };
}

export function collapseAliasKeys(keys: KeyEntry[], masters: string[]): KeyEntry[] {
  const masterSet = new Set(masters);
  if (!masterSet.size) return keys.map(normalizeKeyEntry);
  const byName = new Map<string, KeyEntry>();
  for (const raw of keys) {
    const k = normalizeKeyEntry(raw);
    const dest = masterSet.has(baseKeyName(k.name)) ? baseKeyName(k.name) : k.name;
    const prev = byName.get(dest);
    if (!prev) {
      byName.set(dest, { ...k, name: dest });
      continue;
    }
    const prevAcc = parseAccountIndex(prev.derivation) ?? aliasAccountIndex(prev.name) ?? 0;
    const kAcc = parseAccountIndex(k.derivation) ?? aliasAccountIndex(k.name) ?? 0;
    const kIsMaster = kAcc === 0 && prevAcc !== 0;
    if (k.xpub && k.xpub !== prev.xpub) {
      const masterSrc = kIsMaster ? k : prev;
      const childSrc = kIsMaster ? prev : k;
      const childPath = kIsMaster
        ? prev.derivation || prev.childPath || ""
        : k.derivation || k.childPath || "";
      const children = [...masterSrc.children];
      if (!children.some((c) => c.xpub === childSrc.xpub)) {
        children.push({
          id: uid("ck"),
          path: childPath,
          xpub: childSrc.xpub,
          fingerprint: childSrc.fingerprint,
          note: sanitizeKeyNote(childSrc.note),
        });
      }
      byName.set(dest, {
        ...masterSrc,
        name: dest,
        note: pickNote(masterSrc.note, childSrc.note, prev.note, k.note),
        children,
      });
    } else if (!prev.xpub && k.xpub) {
      byName.set(dest, {
        ...prev,
        xpub: k.xpub,
        fingerprint: k.fingerprint || prev.fingerprint,
        derivation: k.derivation || prev.derivation,
        note: pickNote(prev.note, k.note),
      });
    } else {
      byName.set(dest, { ...prev, note: pickNote(prev.note, k.note) });
    }
  }
  return [...byName.values()];
}

export function formatFingerprint(fp: string): string {
  return fp.replace(/^#/, "").replace(/^0x/i, "").trim().slice(0, 8).toLowerCase();
}

export function parseAccountIndex(path: string): number | null {
  const p = normalizePath(path);
  const m = p.match(/^48'\/(\d+)'\/(\d+)'\/(\d+)'?$/);
  if (!m) return null;
  return Number(m[2]);
}

export function accountPathFrom(path: string, account: number, _network?: string): string {
  const p = normalizePath(path);
  const m = p.match(/^48'\/(\d+)'\/(\d+)'\/(\d+)'?$/);
  const coin = m ? m[1] : "0";
  const script = m ? m[3] : "2";
  return `48'/${coin}'/${account}'/${script}'`;
}

export function usedAccountIndices(key: KeyEntry): number[] {
  const k = normalizeKeyEntry(key);
  const used = new Set<number>();
  const master = parseAccountIndex(k.derivation);
  used.add(master ?? 0);
  for (const c of k.children) {
    const n = parseAccountIndex(c.path);
    if (n != null) used.add(n);
  }
  return [...used].sort((a, b) => a - b);
}

export function nextUnusedAccount(key: KeyEntry, _network?: string): { account: number; path: string } {
  const used = new Set(usedAccountIndices(key));
  let account = 0;
  while (used.has(account)) account++;
  return { account, path: accountPathFrom(key.derivation, account) };
}

export function childForAccount(key: KeyEntry, account: number): KeyChild | undefined {
  return normalizeKeyEntry(key).children.find((c) => parseAccountIndex(c.path) === account);
}

export function displayKeyToken(token: string, keys: KeyEntry[]): string {
  const base = baseKeyName(token);
  const acc = aliasAccountIndex(token);
  const k = keys.find((x) => x.name === base);
  if (!k) return token;
  const masterNote = k.note.trim();
  if (acc != null && acc > 0) {
    const child = childForAccount(k, acc);
    const childNote = child?.note.trim();
    if (childNote) return `${childNote} (${token})`;
    if (masterNote) return `${masterNote} (${token})`;
    return token;
  }
  if (masterNote) return `${masterNote} (${token})`;
  return token;
}

export function keyOriginExpr(k: {
  fingerprint?: string;
  derivation?: string;
  xpub: string;
  childPath?: string;
}): string {
  return originExpr(k);
}

export function keyHeadline(k: KeyEntry): string {
  const note = k.note.trim();
  if (note) return note;
  const fp = formatFingerprint(k.fingerprint);
  if (fp) return fp;
  return keyRoleLabel(k.name);
}

export function keyRoleLabel(token: string): string {
  const acc = aliasAccountIndex(token);
  if (acc != null && acc > 0) return `${token} Child`;
  return `${baseKeyName(token) || token} Master`;
}

export function childRoleLabel(masterName: string, path: string): string {
  const acc = parseAccountIndex(path);
  if (acc != null && acc > 0) return `${masterName}${acc} Child`;
  return `${masterName} Child`;
}

export function keyTileLabel(k: KeyEntry): string {
  const name = k.note.trim() || "—";
  const fp = formatFingerprint(k.fingerprint) || "—";
  return `${name}, ${fp}, ${keyRoleLabel(k.name)}`;
}

export function shortXpub(raw: string, head = 12, tail = 8): string {
  const m = raw.match(/(?:xpub|tpub|ypub|zpub|vpub|Ypub|Zpub|Vpub)[1-9A-HJ-NP-Za-km-z]+/);
  const s = m ? m[0]! : raw.trim();
  if (!s) return "";
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

export function formatBip32Path(k: KeyEntry): string {
  const der = normalizePath(k.derivation || "").trim();
  if (!der) return "";
  return `m/${der}`;
}

export function formatScriptPath(k: KeyEntry): string {
  const child = (k.childPath || "").trim();
  if (child) return child.replace(/^\//, "");
  const multi = (k.multipath || "").trim();
  if (!multi) return "";
  return `${multi}/*`;
}

function humanLabelFromJson(rec: Record<string, unknown>): string {
  if (firstString(rec, ["format"]) === "scriptwerk") return "";
  const label = firstString(rec, ["label", "note"]);
  const name = firstString(rec, ["name"]);
  if (label) return sanitizeKeyNote(label);
  if (name && name.toLowerCase() !== "scriptwerk") return sanitizeKeyNote(name);
  return "";
}

function firstString(rec: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function fromJsonBlob(text: string): ParsedKeyExpr | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const rec = parsed as Record<string, unknown>;
    const xpub = firstString(rec, ["xpub", "tpub", "p2wsh", "extPubKey", "ExtPubKey", "pubkey"]);
    if (!xpub || (!XPUB_IN_TEXT.test(xpub) && !ORIGIN_IN_TEXT.test(xpub))) {
      const nested = extractFirstKeyExpr(JSON.stringify(rec));
      return nested;
    }
    if (ORIGIN_IN_TEXT.test(xpub) || xpub.startsWith("[")) {
      const inner = parseKeyExpr(xpub);
      if (inner.kind !== "alias" && inner.xpub) return inner;
    }
    const fp = firstString(rec, [
      "fingerprint",
      "xfp",
      "master_fingerprint",
      "masterFingerprint",
      "rootFingerprint",
      "root_fingerprint",
      "fp",
    ]);
    const der = firstString(rec, [
      "derivation",
      "deriv",
      "p2wsh_deriv",
      "path",
      "keypath",
      "bip32_path",
      "bip32Path",
    ]);
    const expr =
      fp && der
        ? `[${formatFingerprint(fp)}/${normalizePath(der)}]${xpub}`
        : xpub;
    const out = parseKeyExpr(expr);
    if (out.kind === "alias" || !out.xpub) return null;
    if (der && !out.derivation) out.derivation = normalizePath(der);
    if (fp && !out.fingerprint) out.fingerprint = formatFingerprint(fp);
    const label = humanLabelFromJson(rec);
    if (label) out.note = label;
    return out;
  } catch {
    return null;
  }
}

export function extractFirstKeyExpr(text: string): ParsedKeyExpr | null {
  const origin = text.match(ORIGIN_IN_TEXT);
  if (origin?.[0]) {
    const p = parseKeyExpr(origin[0]);
    if (p.kind !== "alias" && (p.xpub || p.fingerprint)) return p;
  }
  const xpub = text.match(XPUB_IN_TEXT);
  if (xpub?.[0]) {
    const p = parseKeyExpr(xpub[0]);
    if (p.kind !== "alias" && p.xpub) {
      const pathLine = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => /^(m\/)?\d/.test(l) && !XPUB_IN_TEXT.test(l));
      if (pathLine && !p.derivation) p.derivation = normalizePath(pathLine);
      return p;
    }
  }
  return null;
}

export type ApplyKeyResult = { ok: true; key: KeyEntry } | { ok: false; error: string };

export function applyKeyMaterial(entry: KeyEntry, text: string): ApplyKeyResult {
  const raw = text.trim();
  if (!raw) return { ok: false, error: "err.empty" };
  const json = fromJsonBlob(raw);
  const parsed = json ?? (looksLikePolicy(raw) ? null : extractFirstKeyExpr(raw) ?? parseKeyExpr(raw));
  if (parsed && parsed.kind !== "alias" && !parsed.xpub && (parsed.fingerprint || parsed.derivation)) {
    const parent = normalizeKeyEntry(entry);
    return {
      ok: true,
      key: {
        ...parent,
        fingerprint: parsed.fingerprint || parent.fingerprint,
        derivation: parsed.derivation || parent.derivation,
      },
    };
  }
  if (!parsed?.xpub) {
    if (looksLikePolicy(raw)) {
      return { ok: false, error: "err.policy" };
    }
    return { ok: false, error: "err.noXpub" };
  }
  const parent = normalizeKeyEntry(entry);
  return {
    ok: true,
    key: {
      ...parent,
      fingerprint: parsed.fingerprint || parent.fingerprint,
      derivation: parsed.derivation || parent.derivation,
      xpub: parsed.xpub,
      multipath: parsed.multipath || parent.multipath,
      childPath: parsed.childPath || parent.childPath,
      note: parsed.note || parent.note,
    },
  };
}

export interface KeyTreeNode {
  label: string;
  hint?: string;
  last: boolean;
  children: KeyTreeNode[];
}

export function buildKeyTree(
  k: KeyEntry,
  aliases: { alias: string; delay: number }[] = [],
): KeyTreeNode {
  const key = normalizeKeyEntry(k);
  const extra = key.children;
  const aliasNodes: KeyTreeNode[] = aliases.map((a, i) => ({
    label: a.alias,
    hint: a.delay <= 0 ? "Sofort" : `${a.delay.toLocaleString("de-DE")} Bl.`,
    last: i === aliases.length - 1,
    children: [],
  }));
  const script = formatScriptPath(key) || "<0;1>/*";
  const absoluteKids = extra.filter((c) => isAbsoluteChildPath(c.path, key.derivation));
  const relativeKids = extra.filter((c) => !isAbsoluteChildPath(c.path, key.derivation));

  if (absoluteKids.length) {
    const account: KeyTreeNode = {
      label: formatBip32Path(key).replace(/^m\//, "") || key.derivation || "0",
      hint: formatFingerprint(key.fingerprint) || undefined,
      last: false,
      children: [
        {
          label: script,
          last: relativeKids.length === 0,
          children: aliasNodes,
        },
        ...relativeKids.map((c) => ({
          label: c.path,
          hint: [c.note, c.xpub].filter(Boolean).join(" · ") || undefined,
          last: false,
          children: [] as KeyTreeNode[],
        })),
      ],
    };
    const siblings: KeyTreeNode[] = [
      account,
      ...absoluteKids.map((c) => ({
        label: c.path.replace(/^m\//, ""),
        hint: [c.note, c.xpub || formatFingerprint(c.fingerprint)].filter(Boolean).join(" · ") || undefined,
        last: false,
        children: [] as KeyTreeNode[],
      })),
    ];
    siblings.forEach((n, i) => {
      n.last = i === siblings.length - 1;
    });
    account.children.forEach((n, i) => {
      n.last = i === account.children.length - 1;
    });
    return {
      label: "m",
      hint: formatFingerprint(key.fingerprint) || undefined,
      last: true,
      children: siblings,
    };
  }

  const origin = formatBip32Path(key) || "m";
  const kids: KeyTreeNode[] = [
    {
      label: script,
      last: extra.length === 0,
      children: aliasNodes,
    },
    ...extra.map((c) => ({
      label: c.path,
      hint: c.note || (c.xpub ? "Child-xpub" : undefined),
      last: false,
      children: [] as KeyTreeNode[],
    })),
  ];
  kids.forEach((n, i) => {
    n.last = i === kids.length - 1;
  });

  return {
    label: origin,
    hint: formatFingerprint(key.fingerprint) || undefined,
    last: true,
    children: kids,
  };
}

function isAbsoluteChildPath(path: string, parentDerivation: string): boolean {
  const p = normalizePath(path);
  const origin = normalizePath(parentDerivation);
  if (!p) return false;
  if (origin && (p === origin || p.startsWith(`${origin}/`))) return false;
  return /'/.test(p) || /^48['h]/.test(p);
}

function isPathOnly(text: string): boolean {
  const t = text.trim();
  if (!t || t.includes("[") || XPUB_IN_TEXT.test(t) || ORIGIN_IN_TEXT.test(t)) return false;
  return /^(m\/)?[0-9hH'/*<>;]+$/.test(t);
}

function relativizePath(parent: KeyEntry, rawPath: string): string {
  let p = normalizePath(rawPath).replace(/^\//, "");
  const origin = normalizePath(parent.derivation || "");
  if (origin && (p === origin || p.startsWith(`${origin}/`))) {
    p = p.slice(origin.length).replace(/^\//, "");
  }
  return p;
}

function userNote(alias?: string): string {
  return sanitizeKeyNote(alias);
}

export function parseChildKey(
  parent: KeyEntry,
  text: string,
  opts?: { fallbackPath?: string; alias?: string },
): { ok: true; child: KeyChild } | { ok: false; error: string } {
  const raw = text.trim();
  if (!raw) return { ok: false, error: "err.empty" };
  if (looksLikePolicy(raw)) {
    return { ok: false, error: "err.policyChild" };
  }
  const base = normalizeKeyEntry(parent);

  if (isPathOnly(raw)) {
    const path = relativizePath(base, raw);
    if (!path) return { ok: false, error: "err.pathEmpty" };
    if (normalizePath(path) === normalizePath(base.derivation)) {
      return { ok: false, error: "err.samePath" };
    }
    return {
      ok: true,
      child: { id: uid("ck"), path, xpub: "", fingerprint: formatFingerprint(base.fingerprint), note: userNote(opts?.alias) },
    };
  }

  const json = fromJsonBlob(raw);
  const parsed = json ?? extractFirstKeyExpr(raw) ?? (parseKeyExpr(raw).kind !== "alias" ? parseKeyExpr(raw) : null);
  if (!parsed || parsed.kind === "alias") return { ok: false, error: "err.noChildExpr" };

  const sameXpub = Boolean(base.xpub && parsed.xpub && parsed.xpub === base.xpub);
  const childFp = formatFingerprint(parsed.fingerprint);
  const parentFp = formatFingerprint(base.fingerprint);
  const sameFp = Boolean(childFp && parentFp && childFp === parentFp) || (!childFp && Boolean(parentFp));
  if (childFp && parentFp && childFp !== parentFp) {
    return { ok: false, error: "err.mismatch" };
  }

  const origin = normalizePath(base.derivation);
  const childOrigin = normalizePath(parsed.derivation);
  let path = "";

  if (childOrigin && origin && (childOrigin === origin || childOrigin.startsWith(`${origin}/`))) {
    const extra = childOrigin === origin ? "" : childOrigin.slice(origin.length + 1);
    const tail =
      parsed.childPath && parsed.childPath !== "<0;1>/*" && parsed.childPath !== "*"
        ? extra
          ? `/${parsed.childPath}`
          : parsed.childPath
        : "";
    path = `${extra}${tail}`;
    if (!path && parsed.xpub && !sameXpub) {
      path = childOrigin;
    }
  } else if (childOrigin && origin && childOrigin !== origin) {
    path = childOrigin;
  } else if (sameXpub || sameFp) {
    const tail =
      parsed.childPath && parsed.childPath !== "<0;1>/*" && parsed.childPath !== "*"
        ? parsed.childPath
        : "";
    path = tail ? relativizePath(base, tail) : "";
  }

  if (!path && opts?.fallbackPath && (parsed.xpub || sameFp)) {
    path = normalizePath(opts.fallbackPath);
  }

  if (!path) {
    if (!base.xpub && !parentFp) return { ok: false, error: "err.needParent" };
    return { ok: false, error: "err.noChildExpr" };
  }
  if (normalizePath(path) === origin) {
    return { ok: false, error: "err.samePath" };
  }

  return {
    ok: true,
    child: {
      id: uid("ck"),
      path,
      xpub: sameXpub ? "" : parsed.xpub,
      fingerprint: childFp || parentFp,
      note: userNote(opts?.alias),
    },
  };
}

export function attachChildOrReplace(entry: KeyEntry, text: string): ApplyKeyResult {
  const parent = normalizeKeyEntry(entry);
  if (keyIsFilled(parent)) {
    const child = parseChildKey(parent, text);
    if (child.ok) {
      if (parent.children.some((c) => c.path === child.child.path)) {
        return { ok: false, error: "err.dupChild" };
      }
      return { ok: true, key: { ...parent, children: [...parent.children, child.child] } };
    }
  }
  return applyKeyMaterial(parent, text);
}
