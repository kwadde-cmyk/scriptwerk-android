import type { MsNode } from "./ast.ts";
import { collectKeys, hasHoles } from "./ast.ts";
import { compileMiniscript, expandAliasKeys, rewriteSortedMultiForCore } from "./compile.ts";
import {
  emptyKey,
  extractKeysFromTree,
  flattenKeysForLookup,
  formatFingerprint,
  nextKeyName,
  normalizeKeyEntry,
  parseKeyExpr,
  sanitizeKeyNote,
  type KeyChild,
  type KeyEntry,
} from "./keys.ts";
import { parseAny } from "./parser.ts";
import { uid } from "../utils.ts";

export interface Bip388Key {
  index: number;
  name: string;
  label: string;
  fingerprint: string;
  derivation: string;
  xpub: string;
  origin: string;
}

export interface Bip388Policy {
  name: string;
  template: string;
  keys: Bip388Key[];
}

export interface Bip388CompileResult {
  ok: boolean;
  policy: Bip388Policy;
  error?: string;
  warnings: string[];
}

const PLACEHOLDER_RE = /@(\d+)(?:\/\*\*|\/<[^>]+>\/\*\*?|\/\d+\/\*\*?|\/\*)?/g;
const XPUB_RE = /(?:xpub|tpub|ypub|zpub|vpub|Ypub|Zpub|Vpub)[1-9A-HJ-NP-Za-km-z]+/;

export function formatKeyOrigin(k: KeyEntry): string {
  const xpub = k.xpub.trim();
  if (!xpub) return "";
  if (xpub.startsWith("[")) {
    const parsed = parseKeyExpr(xpub);
    if (parsed.xpub) {
      const fp = formatFingerprint(parsed.fingerprint || k.fingerprint);
      const path = (parsed.derivation || k.derivation || "").replace(/^m\//, "");
      if (fp && path) return `[${fp}/${path}]${parsed.xpub}`;
      return parsed.xpub;
    }
  }
  const path = (k.derivation || "").replace(/^m\//, "").trim();
  const fp = formatFingerprint(k.fingerprint);
  if (fp && path) return `[${fp}/${path}]${xpub}`;
  if (fp) return `[${fp}]${xpub}`;
  return xpub;
}

function xpubId(k: KeyEntry | undefined): string {
  return k?.xpub.match(XPUB_RE)?.[0] ?? k?.xpub.trim() ?? "";
}

function distinctChildPath(
  entry: KeyEntry | undefined,
  parent: KeyEntry | undefined,
  token: string,
  reuse: boolean,
): string {
  if (
    entry &&
    parent &&
    token !== parent.name &&
    (xpubId(entry) !== xpubId(parent) || (entry.derivation || "") !== (parent.derivation || ""))
  ) {
    return "/**";
  }
  return bip388KeyTail(entry, token, reuse);
}

function bip388KeyTail(k: KeyEntry | undefined, _token: string, reuse: boolean): string {
  const tail = (k?.childPath || "<0;1>/*").replace(/^\//, "");
  if (!reuse || !tail || tail === "<0;1>/*" || tail === "*" || tail === "**") return "/**";
  const body = tail.replace(/\/\*$/, "").replace(/\*$/, "");
  return `/${body}/**`;
}

function baseName(token: string): string {
  const m = token.match(/^([A-Za-z_][A-Za-z_]*)(\d+)$/);
  return m ? m[1]! : token;
}

function canonicalKey(
  token: string,
  keys: KeyEntry[],
  byName: Map<string, KeyEntry>,
  reuse: boolean,
): KeyEntry {
  if (!reuse) {
    return byName.get(token) || emptyKey(token);
  }
  const direct = byName.get(token);
  if (direct?.xpub) {
    const same = keys.find((k) => k.xpub && k.xpub === direct.xpub);
    if (same) return same;
  }
  const parent = byName.get(baseName(token));
  if (parent) return parent;
  if (direct) return direct;
  return emptyKey(baseName(token));
}

export function compileBip388(
  node: MsNode,
  keys: KeyEntry[],
  name = "Scriptwerk",
  reuse = true,
): Bip388CompileResult {
  const policyName = name.trim().slice(0, 64) || "Scriptwerk";
  if (hasHoles(node)) {
    return {
      ok: false,
      policy: { name: policyName, template: "", keys: [] },
      error: "Es fehlen noch Bausteine (leere Slots).",
      warnings: [],
    };
  }

  const normalized = keys.map(normalizeKeyEntry);
  const expanded = expandAliasKeys(node, normalized, reuse);
  const byName = new Map(expanded.map((k) => [k.name, k]));
  const tokens = collectKeys(node);
  const unique: KeyEntry[] = [];
  const tokenIndex = new Map<string, number>();
  const seen = new Map<string, number>();

  for (const token of tokens) {
    const canon = canonicalKey(token, normalized, byName, reuse);
    const id = canon.xpub.trim() || `name:${canon.name}`;
    if (!seen.has(id)) {
      seen.set(id, unique.length);
      unique.push(canon);
    }
    tokenIndex.set(token, seen.get(id)!);
  }

  let inner = compileMiniscript(node);
  const sortedTokens = [...tokenIndex.keys()].sort((a, b) => b.length - a.length);
  for (const token of sortedTokens) {
    const i = tokenIndex.get(token)!;
    const entry = byName.get(token);
    const path = distinctChildPath(entry, byName.get(baseName(token)), token, reuse);
    const re = new RegExp(`(?<![A-Za-z0-9_@])${escapeRe(token)}(?![A-Za-z0-9_])`, "g");
    inner = inner.replace(re, `@${i}${path}`);
  }

  const policyKeys: Bip388Key[] = unique.map((k, index) => ({
    index,
    name: k.name,
    label: k.note.trim() || k.name,
    fingerprint: formatFingerprint(k.fingerprint),
    derivation: (k.derivation || "").replace(/^m\//, ""),
    xpub: k.xpub.trim(),
    origin: formatKeyOrigin(k),
  }));

  const warnings: string[] = [];
  const missingXpub = policyKeys.filter((k) => !k.xpub).map((k) => k.name);
  if (missingXpub.length) {
    warnings.push(`missingXpub:${missingXpub.join(",")}`);
  }
  const missingFp = policyKeys.filter((k) => k.xpub && !k.fingerprint).map((k) => k.name);
  if (missingFp.length) {
    warnings.push(`missingFp:${missingFp.join(",")}`);
  }

  return {
    ok: true,
    policy: {
      name: policyName,
      template: `wsh(${inner})`,
      keys: policyKeys,
    },
    warnings,
  };
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function walletPolicyToDescriptor(policy: Bip388Policy): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  return policy.template.replace(PLACEHOLDER_RE, (_whole, idx: string) => {
    const i = Number(idx);
    const k = policy.keys[i];
    if (k?.origin) return `${k.origin}/<0;1>/*`;
    if (k?.xpub) {
      const origin = formatKeyOrigin({
        ...emptyKey(k.name || alphabet[i] || `K${i + 1}`),
        fingerprint: k.fingerprint,
        derivation: k.derivation,
        xpub: k.xpub,
      });
      return origin ? `${origin}/<0;1>/*` : k.xpub;
    }
    return k?.name || alphabet[i] || `K${i + 1}`;
  });
}

export function formatLedgerJson(policy: Bip388Policy): string {
  const prepared = toLedgerPolicy(policy);
  const keyOrigins = prepared.keys.map((k) => k.origin).filter(Boolean);
  return `${JSON.stringify(
    {
      name: prepared.name,
      format: "bip388",
      device: "ledger",
      template: prepared.template,
      descriptor_template: prepared.template,
      keys: keyOrigins,
      keyOrigins,
      keyNames: prepared.keys.map((k) => k.label || k.name),
      keyAliases: prepared.keys.map((k) => k.name),
    },
    null,
    2,
  )}\n`;
}

export function toLedgerTemplate(template: string): string {
  const raw = template.replace(/#[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{8}$/i, "").trim();
  const rewritten = rewriteSortedMultiForCore(raw);
  const wrap = rewritten.match(/^wsh\((.*)\)\s*$/is);
  let inner = wrap ? wrap[1]! : rewritten;
  inner = inner.replace(/\/<(?:0;1|1;0)>\/*/g, "/**");
  const nMulti = (inner.match(/\b(?:sorted)?multi\(/gi) ?? []).length;
  const bare = /^(?:sorted)?multi\(/i.test(inner) && nMulti === 1;
  inner = inner.replace(/\bsortedmulti\(/gi, "multi(");
  if (bare) inner = inner.replace(/^multi\(/, "sortedmulti(");
  return `wsh(${inner})`;
}

export function toLedgerPolicy(policy: Bip388Policy): Bip388Policy {
  const name =
    policy.name
      .trim()
      .replace(/[^\x20-\x7e]/g, "")
      .replace(/\s+/g, " ")
      .slice(0, 64) || "Scriptwerk";
  const keys = policy.keys.map((k, index) => {
    const fingerprint = formatFingerprint(k.fingerprint);
    const derivation = (k.derivation || "").replace(/h/gi, "'").replace(/^m\//, "");
    let xpub = k.xpub.trim();
    if (!xpub && k.origin) {
      const parsed = parseKeyExpr(k.origin);
      xpub = parsed.xpub;
    }
    xpub = xpub.replace(/\/<[^>]+>\/\*$/, "").replace(/\/\*\*?$/, "").replace(/\/\*$/, "");
    const origin =
      fingerprint && derivation && xpub
        ? `[${fingerprint}/${derivation}]${xpub}`
        : formatKeyOrigin({
            ...emptyKey(k.name || `K${index}`),
            fingerprint,
            derivation,
            xpub,
          });
    return { ...k, fingerprint, derivation, xpub, origin };
  });
  return {
    name,
    template: toLedgerTemplate(policy.template),
    keys,
  };
}

export function ledgerPolicyReady(policy: Bip388Policy): { ok: true; policy: Bip388Policy } | { ok: false; error: string } {
  const prepared = toLedgerPolicy(policy);
  const missing = prepared.keys.filter((k) => !k.origin || !k.xpub);
  if (missing.length) {
    return { ok: false, error: "hw.err.needKeys" };
  }
  if (!prepared.template.startsWith("wsh(")) {
    return { ok: false, error: "hw.err.template" };
  }
  return { ok: true, policy: prepared };
}

export function formatBitboxJson(policy: Bip388Policy): string {
  const keys = policy.keys
    .filter((k) => k.xpub)
    .map((k) => ({
      rootFingerprint: k.fingerprint,
      keypath: k.derivation ? `m/${k.derivation.replace(/^m\//, "")}` : "",
      xpub: k.xpub,
      name: k.label || k.name,
      alias: k.name,
    }));
  return `${JSON.stringify(
    {
      name: policy.name,
      format: "bip388",
      device: "bitbox02",
      policy: policy.template,
      keys,
      scriptConfig: {
        policy: {
          policy: policy.template,
          keys,
        },
      },
    },
    null,
    2,
  )}\n`;
}

export function formatPolicyText(policy: Bip388Policy): string {
  const lines = [
    `BIP388 ${policy.name}`,
    policy.template,
    ...policy.keys.map((k) => {
      const tag = k.label && k.label !== k.name ? `${k.label} ` : "";
      return k.origin ? `@${k.index} ${tag}${k.origin}` : `@${k.index} ${tag}${k.name}`.trimEnd();
    }),
  ];
  return lines.join("\n");
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function firstString(rec: Record<string, unknown>, names: string[]): string {
  for (const name of names) {
    const v = rec[name];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function decodeFingerprint(raw: unknown): string {
  if (typeof raw === "string") {
    const s = raw.replace(/^0x/i, "").replace(/^#/, "").trim();
    if (/^[0-9a-fA-F]{8}$/.test(s)) return s.toLowerCase();
    if (/^[A-Za-z0-9+/]+=*$/.test(s) && s.length >= 8) {
      try {
        const bytes = Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
        if (bytes.length >= 4) {
          return [...bytes.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
        }
      } catch {
        /* ignore */
      }
    }
    return s.slice(0, 8).toLowerCase();
  }
  if (Array.isArray(raw) && raw.length >= 4) {
    return raw
      .slice(0, 4)
      .map((n) => Number(n).toString(16).padStart(2, "0"))
      .join("");
  }
  return "";
}

function decodeKeypath(raw: unknown): string {
  if (typeof raw === "string") {
    return raw.replace(/^m\//, "").replace(/h/g, "'");
  }
  if (!Array.isArray(raw)) return "";
  return raw
    .map((n) => {
      const num = Number(n);
      if (!Number.isFinite(num)) return "0";
      return num >= 0x80000000 ? `${num - 0x80000000}'` : String(num);
    })
    .join("/");
}

function keyFromUnknown(v: unknown, index: number): Bip388Key | null {
  if (typeof v === "string") {
    const parsed = parseKeyExpr(v.trim());
    if (parsed.kind === "alias" && !parsed.xpub) {
      const extracted = v.match(XPUB_RE);
      if (!extracted) return null;
      return keyFromUnknown(extracted[0], index);
    }
    const name = `ABCDEFGHJKLMNPQRSTUVWXYZ`[index] ?? `K${index + 1}`;
    return {
      index,
      name,
      label: name,
      fingerprint: formatFingerprint(parsed.fingerprint),
      derivation: parsed.derivation.replace(/^m\//, ""),
      xpub: parsed.xpub,
      origin: formatKeyOrigin({
        ...emptyKey(name),
        fingerprint: parsed.fingerprint,
        derivation: parsed.derivation,
        xpub: parsed.xpub,
      }),
    };
  }
  const rec = asRecord(v);
  if (!rec) return null;
  const xpub = firstString(rec, ["xpub", "tpub", "extPubKey", "ExtPubKey", "pubkey"]);
  const xpubMatch = xpub.match(XPUB_RE)?.[0] ?? "";
  if (!xpubMatch) return null;
  const fp = decodeFingerprint(
    rec.rootFingerprint ?? rec.root_fingerprint ?? rec.fingerprint ?? rec.xfp ?? rec.fp,
  );
  const derivation = decodeKeypath(
    rec.keypath ?? rec.path ?? rec.derivation ?? rec.deriv ?? rec.bip32_path,
  );
  const label =
    firstString(rec, ["label", "note"]) ||
    (firstString(rec, ["name"]) && !/^[A-Z]$|^K\d+$/.test(firstString(rec, ["name"]))
      ? firstString(rec, ["name"])
      : "");
  const name =
    firstString(rec, ["alias", "slot"]) ||
    (/^[A-Z]$|^K\d+$/.test(firstString(rec, ["name"])) ? firstString(rec, ["name"]) : "") ||
    `ABCDEFGHJKLMNPQRSTUVWXYZ`[index] ||
    `K${index + 1}`;
  return {
    index,
    name,
    label: label || name,
    fingerprint: formatFingerprint(fp),
    derivation,
    xpub: xpubMatch,
    origin: formatKeyOrigin({
      ...emptyKey(name),
      fingerprint: fp,
      derivation,
      xpub: xpubMatch,
    }),
  };
}

function pickTemplate(rec: Record<string, unknown>): string {
  const nested = asRecord(rec.policy);
  const script = asRecord(rec.scriptConfig) ?? asRecord(rec.script_config);
  const scriptPolicy = script ? asRecord(script.policy) : null;
  const wallet = asRecord(rec.wallet);
  const candidates = [
    firstString(rec, ["template", "descriptor_template", "descriptorTemplate"]),
    nested ? firstString(nested, ["policy", "template"]) : "",
    scriptPolicy ? firstString(scriptPolicy, ["policy", "template"]) : "",
    wallet ? firstString(wallet, ["template", "policy"]) : "",
    typeof rec.policy === "string" ? rec.policy : "",
  ];
  return candidates.find((s) => s.includes("(")) ?? "";
}

function pickKeyList(rec: Record<string, unknown>): unknown[] {
  if (Array.isArray(rec.keyOrigins)) return rec.keyOrigins;
  if (Array.isArray(rec.keys)) return rec.keys;
  const nested = asRecord(rec.policy);
  if (nested && Array.isArray(nested.keys)) return nested.keys;
  const script = asRecord(rec.scriptConfig) ?? asRecord(rec.script_config);
  const scriptPolicy = script ? asRecord(script.policy) : null;
  if (scriptPolicy && Array.isArray(scriptPolicy.keys)) return scriptPolicy.keys;
  return [];
}

function parseJsonPolicy(text: string): Bip388Policy | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const rec = asRecord(parsed);
  if (!rec) return null;
  const template = pickTemplate(rec).replace(/\s+/g, "");
  if (!template || !/@\d+/.test(template)) return null;
  const rawKeys = pickKeyList(rec);
  const keys = rawKeys
    .map((k, i) => keyFromUnknown(k, i))
    .filter((k): k is Bip388Key => Boolean(k));
  const labels = Array.isArray(rec.keyNames) ? rec.keyNames : Array.isArray(rec.keyLabels) ? rec.keyLabels : null;
  if (labels) {
    keys.forEach((k, i) => {
      const lab = labels[i];
      if (typeof lab === "string" && lab.trim()) k.label = lab.trim();
    });
  }
  const aliases = Array.isArray(rec.keyAliases) ? rec.keyAliases : null;
  if (aliases) {
    keys.forEach((k, i) => {
      const a = aliases[i];
      if (typeof a === "string" && a.trim()) k.name = a.trim();
    });
  }
  const name = firstString(rec, ["name", "label", "walletName"]) || "Scriptwerk";
  return { name: name.slice(0, 64), template, keys };
}

function parseTextPolicy(text: string): Bip388Policy | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (!lines.length) return null;
  const joined = lines.join("\n");
  if (!/@\d+/.test(joined)) return null;
  const templateLine = lines.find((l) => /^(wsh|sh)\(/i.test(l.replace(/\s+/g, "")));
  if (!templateLine) return null;
  const template = templateLine.replace(/\s+/g, "");
  const nameLine = lines.find(
    (l) =>
      /^(name|wallet)\s*[:=]/i.test(l) ||
      /^BIP388\s+\S/.test(l) ||
      (!XPUB_RE.test(l) && !/^(wsh|sh)\(/i.test(l) && !/^@\d+/.test(l) && l.length < 65),
  );
  let name = "Scriptwerk";
  if (nameLine) {
    const labeled = nameLine.match(/^(?:name|wallet)\s*[:=]\s*(.+)$/i);
    const bip = nameLine.match(/^BIP388\s+(.+)$/i);
    name = (labeled?.[1] || bip?.[1] || (!templateLine.includes(nameLine) ? nameLine : "")).trim() ||
      "Scriptwerk";
  }
  const keys: Bip388Key[] = [];
  for (const line of lines) {
    if (line === templateLine) continue;
    const labeled = line.match(/^@(\d+)\s+(.+)$/);
    let raw = labeled ? labeled[2]! : line;
    if (!XPUB_RE.test(raw) && !raw.startsWith("[")) continue;
    let label = "";
    const named = raw.match(/^(?:"([^"]+)"|([A-Za-z][A-Za-z0-9 _-]{0,40}?))\s+(\[.+|(?:xpub|tpub|ypub|zpub|vpub|Ypub|Zpub|Vpub).+)$/);
    if (named) {
      label = (named[1] || named[2] || "").trim();
      raw = named[3]!;
    }
    const index = labeled ? Number(labeled[1]) : keys.length;
    const key = keyFromUnknown(raw, index);
    if (key) keys[index] = { ...key, index, label: label || key.label };
  }
  return { name: name.slice(0, 64), template, keys: keys.filter(Boolean) };
}

export function parseWalletPolicy(text: string): Bip388Policy | null {
  const raw = text.trim();
  if (!raw) return null;
  return parseJsonPolicy(raw) ?? parseTextPolicy(raw);
}

export function looksLikeWalletPolicy(text: string): boolean {
  return parseWalletPolicy(text) !== null;
}

export function materializeWalletPolicy(
  policy: Bip388Policy,
  existing: KeyEntry[],
): { node: MsNode; keys: KeyEntry[] } {
  const desc = walletPolicyToDescriptor(policy);
  const parsed = parseAny(desc);
  const extracted = extractKeysFromTree(parsed.node, flattenKeysForLookup(existing));
  const byXpub = new Map(
    policy.keys
      .filter((k) => k.xpub)
      .map((k) => {
        const id = k.xpub.match(/(?:xpub|tpub|ypub|zpub|vpub|Ypub|Zpub|Vpub)[1-9A-HJ-NP-Za-km-z]+/)?.[0] ?? k.xpub;
        return [id, k] as const;
      }),
  );
  const keys = extracted.keys.map((k) => {
    const xid = k.xpub.match(/(?:xpub|tpub|ypub|zpub|vpub|Ypub|Zpub|Vpub)[1-9A-HJ-NP-Za-km-z]+/)?.[0] ?? k.xpub;
    const hit = xid ? byXpub.get(xid) : undefined;
    if (!hit) return k;
    const named = hit.label || hit.name;
    const note =
      k.note ||
      (named && !/^[A-Z]$/.test(named) && !/^K\d+$/.test(named) ? named : "");
    return {
      ...k,
      fingerprint: k.fingerprint || hit.fingerprint,
      derivation: k.derivation || hit.derivation,
      note,
    };
  });
  return { node: extracted.node, keys };
}

export function formatScriptwerkJson(opts: {
  name?: string;
  miniscript: string;
  descriptor: string;
  keys: KeyEntry[];
  reuseKeys: boolean;
  network: "mainnet";
  policyMode?: string;
  originalDescriptor?: string;
  liftWarning?: string;
}): string {
  return `${JSON.stringify(
    {
      format: "scriptwerk",
      version: 1,
      name: opts.name || "Scriptwerk",
      miniscript: opts.miniscript,
      descriptor: opts.descriptor,
      reuseKeys: opts.reuseKeys,
      network: opts.network,
      policyMode: opts.policyMode || "stages",
      originalDescriptor: opts.originalDescriptor || "",
      liftWarning: opts.liftWarning || "",
      keys: opts.keys.map((k) => ({
        name: k.name,
        label: k.note,
        note: k.note,
        fingerprint: k.fingerprint,
        derivation: k.derivation,
        xpub: k.xpub,
        childPath: k.childPath,
        children: k.children.map((c) => ({
          path: c.path,
          xpub: c.xpub,
          fingerprint: c.fingerprint,
          note: c.note,
          label: c.note,
        })),
      })),
    },
    null,
    2,
  )}\n`;
}

export function parseScriptwerkBundle(text: string): {
  name: string;
  miniscript: string;
  descriptor: string;
  keys: KeyEntry[];
  reuseKeys?: boolean;
  network?: "mainnet";
  policyMode?: string;
  originalDescriptor?: string;
  liftWarning?: string;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const rec = asRecord(parsed);
  if (!rec) return null;
  if (firstString(rec, ["format"]) !== "scriptwerk") return null;
  const miniscript = firstString(rec, ["miniscript", "policy"]);
  const descriptor = firstString(rec, ["descriptor"]);
  if (!miniscript && !descriptor) return null;
  if (!Array.isArray(rec.keys)) return null;
  const keys: KeyEntry[] = [];
  const used: string[] = [];
  for (const raw of rec.keys) {
    const k = asRecord(raw);
    if (!k) continue;
    const name = firstString(k, ["name", "alias"]) || nextKeyName(used);
    used.push(name);
    const kids: KeyChild[] = Array.isArray(k.children)
      ? k.children.flatMap((c) => {
          const ch = asRecord(c);
          if (!ch) return [];
          return [
            {
              id: uid("ck"),
              path: firstString(ch, ["path", "derivation"]),
              xpub: firstString(ch, ["xpub"]),
              fingerprint: firstString(ch, ["fingerprint", "fp"]),
              note: sanitizeKeyNote(firstString(ch, ["note", "label"])),
            },
          ];
        })
      : [];
    keys.push({
      ...emptyKey(name),
      note: sanitizeKeyNote(firstString(k, ["note", "label"])),
      fingerprint: firstString(k, ["fingerprint", "fp"]),
      derivation: firstString(k, ["derivation", "path"]) || emptyKey(name).derivation,
      xpub: firstString(k, ["xpub"]),
      childPath: firstString(k, ["childPath"]) || "<0;1>/*",
      children: kids,
    });
  }
  const network = firstString(rec, ["network"]);
  return {
    name: firstString(rec, ["name"]) || "Scriptwerk",
    miniscript,
    descriptor,
    keys,
    reuseKeys: typeof rec.reuseKeys === "boolean" ? rec.reuseKeys : undefined,
    network: "mainnet",
    policyMode: firstString(rec, ["policyMode"]) || undefined,
    originalDescriptor: firstString(rec, ["originalDescriptor"]) || undefined,
    liftWarning: firstString(rec, ["liftWarning"]) || undefined,
  };
}
