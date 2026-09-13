import type { KeyEntry } from "./keys.ts";
import { accountPathFrom, childForAccount, reuseBranchPath } from "./keys.ts";
import type { MsNode } from "./ast.ts";
import { collectKeys, hasHoles } from "./ast.ts";
import { descsumCreate, CHILD_PATH_FORMS, rewriteDescriptorChildPath } from "./checksum.ts";
import { compileStages, aliasReuseKeys, stageKeyOrderVariants, type Nesting, type Stage } from "./stages.ts";

export function compileMiniscript(node: MsNode, compact = true): string {
  const raw = compileNode(node);
  return compact ? raw.replace(/\s+/g, "") : raw;
}

function compileNode(node: MsNode): string {
  switch (node.kind) {
    case "hole":
      return "/*?*/";
    case "pk":
      return `pk(${node.key})`;
    case "pkh":
      return `pkh(${node.key})`;
    case "multi": {
      const keys = node.sorted ? [...node.keys].sort((a, b) => a.localeCompare(b)) : node.keys;
      return `multi(${node.k},${keys.join(",")})`;
    }
    case "thresh":
      return `thresh(${node.k},${node.children.map(compileNode).join(",")})`;
    case "older":
      return `older(${node.n})`;
    case "after":
      return `after(${node.n})`;
    case "and_v":
    case "and_b":
    case "or_i":
    case "or_d":
    case "or_c":
    case "or_b":
      return `${node.kind}(${compileNode(node.left)},${compileNode(node.right)})`;
    case "andor":
      return `andor(${compileNode(node.x)},${compileNode(node.y)},${compileNode(node.z)})`;
    case "wrap":
      return `${node.wrap}:${compileNode(node.child)}`;
  }
}

export function expandAliasKeys(node: MsNode, keys: KeyEntry[], reuse = true): KeyEntry[] {
  const byName = new Map(keys.map((k) => [k.name, k]));
  const out = [...keys];
  for (const n of collectKeys(node)) {
    if (byName.has(n)) continue;
    const m = n.match(/^([A-Za-z_][A-Za-z_]*?)(\d+)$/);
    const src = m ? byName.get(m[1]!) : undefined;
    if (!src) continue;
    const idx = m ? Number(m[2]) : 0;
    const occ = Number.isFinite(idx) && idx > 0 ? idx : 1;
    const account = reuse ? (occ > 1 ? occ - 1 : 0) : idx;
    const child = account > 0 ? childForAccount(src, account) : undefined;
    const expected = accountPathFrom(src.derivation, account > 0 ? account : 0);
    let clone: KeyEntry;
    if (child?.xpub) {
      clone = {
        ...src,
        id: `${src.id}_${n}`,
        name: n,
        xpub: child.xpub,
        derivation: child.path.replace(/^m\//, "") || expected,
        fingerprint: child.fingerprint || src.fingerprint,
        children: [],
      };
    } else if (!reuse) {
      clone = {
        ...src,
        id: `${src.id}_${n}`,
        name: n,
        xpub: "",
        derivation: expected,
        children: [],
      };
    } else {
      const childPath = reuseBranchPath(src.childPath, occ);
      clone = {
        ...src,
        id: `${src.id}_${n}`,
        name: n,
        childPath,
        multipath: childPath.match(/^<[^>]+>/)?.[0] || src.multipath,
        children: [],
      };
    }
    out.push(clone);
    byName.set(n, clone);
  }
  return out;
}

export function substituteKeys(ms: string, keys: KeyEntry[]): string {
  const lookup = [...keys].sort((a, b) => b.name.length - a.name.length);
  const names = lookup.map((k) => k.name).filter(Boolean);
  if (!names.length) return ms;
  const re = new RegExp(`(?<![A-Za-z0-9_])(${names.map(escapeRe).join("|")})(?![A-Za-z0-9_])`, "g");
  return ms.replace(re, (tok) => {
    const k = lookup.find((e) => e.name === tok);
    if (!k?.xpub.trim()) return tok;
    return formatKeyExpr(k);
  });
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripRangeTail(s: string): string {
  return s.replace(/\/(?:<[^>]+>|\d+)\/\*$/, "");
}

export function formatKeyExpr(k: KeyEntry): string {
  const raw = stripRangeTail(k.xpub.trim());
  if (!raw) return k.name;
  const tail = (k.childPath || `${k.multipath || "<0;1>"}/*`).replace(/^\//, "");
  if (raw.startsWith("[")) return `${raw}/${tail}`;
  const path = (k.derivation || "48'/0'/0'/2'").replace(/^m\//, "");
  const fp = (k.fingerprint || "00000000").replace(/^#/, "").slice(0, 8);
  return `[${fp}/${path}]${raw}/${tail}`;
}

export function compileDescriptor(
  node: MsNode,
  keys: KeyEntry[],
  reuse = true,
): { ok: boolean; miniscript: string; descriptor: string; error?: string } {
  if (hasHoles(node)) {
    return {
      ok: false,
      miniscript: compileMiniscript(node),
      descriptor: "",
      error: "Es fehlen noch Bausteine (leere Slots).",
    };
  }
  const tree = reuse ? aliasReuseKeys(node) : node;
  const miniscript = compileMiniscript(tree);
  const inner = rewriteSortedMultiForCore(substituteKeys(miniscript, expandAliasKeys(tree, keys, reuse)), node);
  const descriptor = descsumCreate(`wsh(${inner})`);
  return { ok: true, miniscript, descriptor };
}

let cachedNode: MsNode | null = null;
let cachedKeys: KeyEntry[] | undefined;
let cachedReuse: boolean | undefined;
let cachedOut: ReturnType<typeof compileDescriptor> | null = null;

/** Same root/keys refs (Zustand) skip a second compile in Interpreter / Export / Node. */
export function compileDescriptorCached(
  node: MsNode | null,
  keys: KeyEntry[],
  reuse = true,
): ReturnType<typeof compileDescriptor> | null {
  if (!node) {
    cachedNode = null;
    cachedOut = null;
    return null;
  }
  if (node === cachedNode && keys === cachedKeys && reuse === cachedReuse) return cachedOut;
  cachedNode = node;
  cachedKeys = keys;
  cachedReuse = reuse;
  cachedOut = compileDescriptor(node, keys, reuse);
  return cachedOut;
}

/**
 * Bitcoin Core: `sortedmulti()` is a descriptor function, valid only as the entire
 * `wsh(sortedmulti(...))` / `sh(sortedmulti(...))` script. Nested miniscript must use `multi()`.
 */
export function rewriteSortedMultiForCore(text: string, root?: MsNode): string {
  const raw = text.trim();
  const wrap = raw.match(/^(wsh|sh)\((.*)\)\s*$/is);
  const inner = wrap ? wrap[2]! : raw;
  const onlyTop =
    (root?.kind === "multi" && Boolean(root.sorted)) ||
    (/^sortedmulti\(/i.test(inner) && (inner.match(/sortedmulti\(/gi) ?? []).length === 1);
  let next = inner.replace(/\bsortedmulti\(/gi, "multi(");
  if (onlyTop) next = next.replace(/^multi\(/, "sortedmulti(");
  return wrap ? `${wrap[1]!.toLowerCase()}(${next})` : next;
}

export function compileBsms(descriptor: string, firstAddress?: string): string {
  const lines = ["BSMS 1.0", descriptor, "/0/*,/1/*"];
  if (firstAddress) lines.push(firstAddress);
  return lines.join("\n");
}

export function descriptorOrderVariants(
  stages: Stage[],
  keys: KeyEntry[],
  reuse = true,
  limit = 120,
  nesting: Nesting = "late",
): { stages: Stage[]; descriptor: string; checksum: string; orders: string[]; childPath: string }[] {
  const variants = stageKeyOrderVariants(stages, limit);
  const seen = new Set<string>();
  const out: { stages: Stage[]; descriptor: string; checksum: string; orders: string[]; childPath: string }[] = [];
  for (const next of variants) {
    const { root } = compileStages(next, reuse, nesting);
    const compiled = compileDescriptor(root, keys, reuse);
    if (!compiled.ok) continue;
    for (const tail of CHILD_PATH_FORMS) {
      const descriptor = rewriteDescriptorChildPath(compiled.descriptor, tail);
      const hash = descriptor.lastIndexOf("#");
      const checksum = hash >= 0 ? descriptor.slice(hash + 1) : "";
      if (!checksum || seen.has(checksum)) continue;
      seen.add(checksum);
      out.push({
        stages: next,
        descriptor,
        checksum,
        childPath: tail,
        orders: next.map((s) => s.keys.join(" · ")),
      });
    }
  }
  return out;
}
