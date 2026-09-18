import type { KeyEntry } from "./keys.ts";
import type { MsNode } from "./ast.ts";
import { descsumCheck, descsumCreate, stripChecksum } from "./checksum.ts";
import { compileDescriptor, compileDescriptorCached } from "./compile.ts";
import { compileStages, inferNesting, liftIncompleteReason, type Nesting, type Stage } from "./stages.ts";
import type { ParseResult } from "./parser.ts";

export type PolicyMode = "stages" | "display" | "raw";

export function isPolicyMode(v: unknown): v is PolicyMode {
  return v === "stages" || v === "display" || v === "raw";
}

export function policyIsFrozen(mode?: PolicyMode | string | null): boolean {
  return mode === "raw" || mode === "display";
}

const PRIVKEY_RE =
  /\b(?:xprv|tprv|yprv|zprv|vprv|Yprv|Zprv|Vprv)[1-9A-HJ-NP-Za-km-z]+/;
const WIF_RE = /\b(?:5[HJK][1-9A-HJ-NP-Za-km-z]{48}|[KL][1-9A-HJ-NP-Za-km-z]{51})\b/;

export function rejectSecrets(text: string): string | null {
  if (PRIVKEY_RE.test(text) || WIF_RE.test(text)) return "import.err.private";
  return null;
}

export function rejectTaproot(text: string): string | null {
  const s = text.replace(/\s+/g, "");
  if (/\btr\(/i.test(s) || /\bmusig\(/i.test(s)) return "import.err.taproot";
  return null;
}

export function sourceFromParse(p: ParseResult): string {
  let body = p.rawInner;
  if (p.wrapper === "wsh") body = `wsh(${p.rawInner})`;
  else if (p.wrapper === "sh_wsh") body = `sh(wsh(${p.rawInner}))`;
  return p.checksum ? `${body}#${p.checksum}` : body;
}

export function ensureDescriptor(src: string): string {
  const compact = src.replace(/\s+/g, "");
  if (!compact) return "";
  let body = stripChecksum(compact);
  if (!/^(wsh|sh)\(/i.test(body)) body = `wsh(${body})`;
  return descsumCreate(body);
}

export function descriptorsEquivalent(a: string, b: string): boolean {
  if (!a.trim() || !b.trim()) return false;
  return ensureDescriptor(a) === ensureDescriptor(b);
}

export function miniscriptInner(desc: string): string {
  const body = stripChecksum(desc.replace(/\s+/g, ""));
  const sh = body.match(/^sh\(wsh\((.*)\)\)\s*$/i);
  if (sh) return sh[1]!;
  const wsh = body.match(/^wsh\((.*)\)\s*$/i);
  if (wsh) return wsh[1]!;
  return body;
}

export function frozenCompile(original: string): ReturnType<typeof compileDescriptor> {
  const descriptor = ensureDescriptor(original);
  return { ok: true, miniscript: miniscriptInner(descriptor), descriptor };
}

let frozenCache: { src: string; out: ReturnType<typeof frozenCompile> } | null = null;

export function compiledForStudio(s: {
  policyMode?: PolicyMode | string | null;
  originalDescriptor?: string;
  root: MsNode | null;
  keys: KeyEntry[];
  reuseKeys: boolean;
}): ReturnType<typeof compileDescriptor> | null {
  if (policyIsFrozen(s.policyMode) && s.originalDescriptor) {
    if (frozenCache?.src === s.originalDescriptor) return frozenCache.out;
    const out = frozenCompile(s.originalDescriptor);
    frozenCache = { src: s.originalDescriptor, out };
    return out;
  }
  return compileDescriptorCached(s.root, s.keys, s.reuseKeys);
}

export function inferReuse(stages: Stage[]): boolean {
  const counts = new Map<string, number>();
  for (const s of stages) {
    for (const k of s.keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.values()].some((n) => n > 1);
}

export function classifyImportedPolicy(opts: {
  root: MsNode;
  stages: Stage[];
  keys: KeyEntry[];
  source: string;
  reuseKeys?: boolean;
}): {
  mode: PolicyMode;
  stages: Stage[];
  originalDescriptor: string;
  liftWarning?: string;
  reuseKeys: boolean;
  nesting: Nesting;
} {
  const originalDescriptor = ensureDescriptor(opts.source);
  const nesting = inferNesting(opts.root);
  const incomplete = liftIncompleteReason(opts.root, opts.source);
  const preferReuse = opts.reuseKeys ?? inferReuse(opts.stages);

  if (incomplete || !opts.stages.length) {
    return {
      mode: "raw",
      stages: [],
      originalDescriptor,
      liftWarning: incomplete ?? "empty",
      reuseKeys: preferReuse,
      nesting,
    };
  }

  for (const reuse of [preferReuse, !preferReuse]) {
    const rebuilt = compileDescriptor(compileStages(opts.stages, reuse, nesting).root, opts.keys, reuse);
    if (rebuilt.ok && descriptorsEquivalent(originalDescriptor, rebuilt.descriptor)) {
      return {
        mode: "stages",
        stages: opts.stages,
        originalDescriptor: "",
        reuseKeys: reuse,
        nesting,
      };
    }
  }

  return {
    mode: "display",
    stages: opts.stages,
    originalDescriptor,
    liftWarning: "recompile",
    reuseKeys: preferReuse,
    nesting,
  };
}

export function assertImportableText(text: string): string | null {
  return rejectSecrets(text) ?? rejectTaproot(text);
}

export function checksumLooksWrong(src: string): boolean {
  const compact = src.replace(/\s+/g, "");
  const hash = compact.lastIndexOf("#");
  if (hash < 0 || !/^[a-z0-9]{8}$/i.test(compact.slice(hash + 1))) return false;
  return !descsumCheck(compact);
}
