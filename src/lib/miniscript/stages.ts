import { mapKeyStrings, mapNode, visit, type MsNode } from "./ast.ts";
import { uid } from "../utils.ts";
import { baseKeyName, keyRoleLabel, reuseBranchPath } from "./keys.ts";

export interface Stage {
  id: string;
  delay: number;
  k: number;
  keys: string[];
  /** Keys that must sign (AND). Remaining keys are an OR / k-of-rest. */
  required?: string[];
  /** If true, compile sortedmulti — pubkey order does not change the script. */
  sorted?: boolean;
  /** If true, use pkh() / thresh(pkh) instead of pk() / multi(). */
  hash?: boolean;
  /** If true, k-of-k (e.g. 2-of-2) compiles as and_v instead of multi. */
  andv?: boolean;
}

export const DELAY_PRESET_CORE = [0, 1, 144, 1008, 4320, 52596, 60000] as const;
/** Bitcoin nSequence / older() ceiling. */
export const MAX_OLDER = 65535;
/** Nunchuk rejects 65535; this is the compatible default. */
export const DEFAULT_MAX_OLDER = 65534;

export type MaxOlder = 65534 | 65535;

export function asMaxOlder(n: number): MaxOlder {
  return n === 65535 ? 65535 : 65534;
}

export function delayPresets(maxOlder: number = DEFAULT_MAX_OLDER): number[] {
  return [...DELAY_PRESET_CORE, asMaxOlder(maxOlder)];
}

export const DELAY_PRESETS = delayPresets(DEFAULT_MAX_OLDER);

export function defaultStages(): Stage[] {
  return [{ id: uid("st"), delay: 0, k: 2, keys: ["A", "B", "C"] }];
}

export function nextStageDelay(stages: Stage[], maxOlder: number = DEFAULT_MAX_OLDER): number {
  const cap = asMaxOlder(maxOlder);
  const max = Math.max(0, ...stages.map((s) => s.delay));
  if (max <= 0) return 52596;
  if (max < 60000) return 60000;
  return cap;
}

/** Core accepts sortedmulti only as the entire wsh() script — one unlocked multi stage. */
export function sortedMultiAllowed(stages: Stage[]): boolean {
  const cleaned = cleanedStages(stages);
  if (cleaned.length !== 1) return false;
  const s = cleaned[0]!;
  if (s.delay > 0) return false;
  if (s.required?.length) return false;
  if (s.hash) return false;
  if (s.andv) return false;
  const k = Math.min(Math.max(s.k, 1), s.keys.length);
  return s.keys.length >= 2 && k >= 2;
}

function cleanedStages(stages: Stage[]) {
  return stages
    .map((s) => {
      const keys = s.keys.map((k) => k.trim()).filter(Boolean);
      const required = (s.required ?? []).map((k) => k.trim()).filter((k) => keys.includes(k));
      const k = Math.max(1, Math.round(Number(s.k) || 1));
      return {
        ...s,
        keys,
        k,
        required: required.length && k < keys.length ? required : undefined,
        delay: Math.max(0, Math.min(MAX_OLDER, Math.round(Number(s.delay) || 0))),
      };
    })
    .filter((s) => s.keys.length > 0)
    .sort((a, b) => a.delay - b.delay || a.id.localeCompare(b.id));
}

export function reuseAliasHints(
  stages: Stage[],
  reuse: boolean,
): Map<string, { alias: string; delay: number; account?: number; branch?: string }[]> {
  const map = new Map<string, { alias: string; delay: number; account?: number; branch?: string }[]>();
  const cleaned = cleanedStages(stages);
  const counts = new Map<string, number>();
  for (const s of cleaned) {
    for (const k of s.keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  for (const s of cleaned) {
    for (const name of s.keys) {
      if ((counts.get(name) ?? 0) <= 1) continue;
      const n = (seen.get(name) ?? 0) + 1;
      seen.set(name, n);
      const list = map.get(name) ?? [];
      if (reuse) {
        list.push({ alias: `${name}${n}`, delay: s.delay, branch: reuseBranchPath("<0;1>/*", n) });
      } else if (n > 1) {
        list.push({ alias: `${name}${n - 1}`, delay: s.delay, account: n - 1 });
      }
      map.set(name, list);
    }
  }
  return map;
}

export function stageIndicesForAccount(
  stages: Stage[],
  masterName: string,
  account: number,
  reuse: boolean,
): number[] {
  return slotsForAccount(stages, masterName, account, reuse).map((s) => s.index);
}

export interface StageSignerSlot {
  index: number;
  delay: number;
  k: number;
  n: number;
  quorum: string;
  signers: { token: string; role: string; account: number }[];
}

export function describeStageSlots(stages: Stage[], reuse: boolean): StageSignerSlot[] {
  const cleaned = cleanedStages(stages);
  const counts = new Map<string, number>();
  for (const s of cleaned) {
    for (const k of s.keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return cleaned.map((s, i) => {
    const signers = s.keys.map((name) => {
      const total = counts.get(name) ?? 1;
      const n = (seen.get(name) ?? 0) + 1;
      seen.set(name, n);
      let account = 0;
      if (!reuse && total > 1) account = n === 1 ? 0 : n - 1;
      const token = account > 0 ? `${name}${account}` : name;
      return { token, role: keyRoleLabel(token), account };
    });
    const nKeys = s.keys.length;
    const k = Math.min(Math.max(s.k, 1), Math.max(nKeys, 1));
    return {
      index: i + 1,
      delay: s.delay,
      k,
      n: nKeys,
      quorum: `${k}of${nKeys}`,
      signers,
    };
  });
}

export function slotsForAccount(
  stages: Stage[],
  masterName: string,
  account: number,
  reuse: boolean,
): StageSignerSlot[] {
  return describeStageSlots(stages, reuse).filter((slot) =>
    slot.signers.some((s) => baseKeyName(s.token) === masterName && s.account === account),
  );
}

export function isDerivedAlias(name: string, masters: Iterable<string>): boolean {
  const set = masters instanceof Set ? masters : new Set(masters);
  if (set.has(name)) return false;
  const m = name.match(/^([A-Za-z_][A-Za-z_]*)(\d+)$/);
  return Boolean(m && set.has(m[1]!));
}

export type Nesting = "late" | "early";

export function compileStages(
  stages: Stage[],
  reuse = true,
  nesting: Nesting = "late",
): { root: MsNode; aliases: string[] } {
  const cleaned = cleanedStages(stages);

  if (!cleaned.length) {
    return { root: { id: uid(), kind: "hole", hint: "Stufe" }, aliases: [] };
  }

  const counts = new Map<string, number>();
  for (const s of cleaned) {
    for (const k of s.keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  function alias(name: string): string {
    if ((counts.get(name) ?? 0) <= 1) return name;
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    if (reuse) return `${name}${n}`;
    return n === 1 ? name : `${name}${n - 1}`;
  }

  const aliases: string[] = [];
  function aliasName(name: string): string {
    const a = alias(name);
    aliases.push(a);
    return a;
  }

  function pk(name: string, hash = false): MsNode {
    return { id: uid(), kind: hash ? "pkh" : "pk", key: name };
  }
  function wrapA(child: MsNode): MsNode {
    return { id: uid(), kind: "wrap", wrap: "a", child };
  }
  function wrapV(child: MsNode): MsNode {
    return { id: uid(), kind: "wrap", wrap: "v", child };
  }
  function andV(left: MsNode, right: MsNode): MsNode {
    return { id: uid(), kind: "and_v", left: wrapV(left), right };
  }
  function orD(left: MsNode, right: MsNode): MsNode {
    return { id: uid(), kind: "or_d", left, right };
  }
  function andAll(nodes: MsNode[]): MsNode {
    return nodes.reduce((acc, n) => andV(acc, n));
  }
  function orAll(nodes: MsNode[]): MsNode {
    return nodes.reduce((acc, n) => orD(acc, n));
  }

  function combo(k: number, names: string[], hash: boolean, sorted: boolean, andv: boolean): MsNode {
    if (names.length === 1) return pk(names[0]!, hash);
    if (hash) {
      if (k >= names.length) return andAll(names.map((n) => pk(n, true)));
      if (k === 1) return orAll(names.map((n) => pk(n, true)));
      return {
        id: uid(),
        kind: "thresh",
        k,
        children: names.map((n, i) => (i === 0 ? pk(n, true) : wrapA(pk(n, true)))),
      };
    }
    if (andv && k >= names.length) return andAll(names.map((n) => pk(n, false)));
    return { id: uid(), kind: "multi", k, keys: names, sorted };
  }

  function body(s: (typeof cleaned)[number]): MsNode {
    const mapped = new Map<string, string>();
    const names = s.keys.map((k) => {
      if (!mapped.has(k)) mapped.set(k, aliasName(k));
      return mapped.get(k)!;
    });
    const hash = Boolean(s.hash);
    const reqNames = (s.required ?? [])
      .map((k) => mapped.get(k))
      .filter((n): n is string => Boolean(n));
    const rest = names.filter((n) => !reqNames.includes(n));
    if (reqNames.length && rest.length) {
      const must = reqNames.length === 1 ? pk(reqNames[0]!, hash) : andAll(reqNames.map((n) => pk(n, hash)));
      const restK = Math.max(1, Math.min((s.k || 1) - reqNames.length, rest.length));
      return andV(must, combo(restK, rest, hash, false, false));
    }
    if (reqNames.length && !rest.length) {
      return reqNames.length === 1 ? pk(reqNames[0]!, hash) : andAll(reqNames.map((n) => pk(n, hash)));
    }
    const k = Math.min(Math.max(s.k, 1), names.length);
    return combo(k, names, hash, Boolean(s.sorted) && sortedMultiAllowed(cleaned), Boolean(s.andv));
  }

  function locked(s: (typeof cleaned)[number]): MsNode {
    const b = body(s);
    if (s.delay <= 0) return b;
    return {
      id: uid(),
      kind: "and_v",
      left: { id: uid(), kind: "wrap", wrap: "v", child: b },
      right: { id: uid(), kind: "older", n: Math.min(s.delay, MAX_OLDER) },
    };
  }

  const bodies = cleaned.map((s) => locked(s));
  if (bodies.length === 1) return { root: bodies[0]!, aliases };
  let acc: MsNode;
  if (nesting === "early") {
    acc = bodies[bodies.length - 1]!;
    for (let i = bodies.length - 2; i >= 0; i--) {
      acc = { id: uid(), kind: "or_i", left: bodies[i]!, right: acc };
    }
  } else {
    acc = bodies[0]!;
    for (let i = 1; i < bodies.length; i++) {
      acc = { id: uid(), kind: "or_i", left: bodies[i]!, right: acc };
    }
  }
  return { root: acc, aliases };
}

/** Number each key use in delay order (A1, A2, …) so reuse tails match the key list. */
export function aliasReuseKeys(root: MsNode): MsNode {
  const parts = splitDisjuncts(root);
  if (parts.length < 2) return root;
  const delays = parts.map((n) => peelLock(n).delay);
  const order = parts.map((_, i) => i).sort((a, b) => delays[a]! - delays[b]! || a - b);
  const seen = new Map<string, number>();
  let next = root;
  for (const i of order) {
    const leaf = parts[i]!;
    const local = new Map<string, string>();
    const stamped = mapKeyStrings(leaf, (key) => {
      const base = baseKeyName(key);
      const prev = local.get(base);
      if (prev) return prev;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const alias = `${base}${n}`;
      local.set(base, alias);
      return alias;
    });
    next = mapNode(next, leaf.id, () => stamped);
  }
  return next;
}

export function inferNesting(root: MsNode): Nesting {
  const n = unwrap(root);
  if (n.kind !== "or_i" && n.kind !== "or_d" && n.kind !== "or_c" && n.kind !== "or_b") return "late";
  const side = (node: MsNode) => {
    const delays = splitDisjuncts(node).map((p) => peelLock(p).delay);
    return delays.length ? Math.min(...delays) : 0;
  };
  return side(n.left) < side(n.right) ? "early" : "late";
}

function unwrap(n: MsNode): MsNode {
  while (n.kind === "wrap") n = n.child;
  return n;
}

function splitDisjuncts(n: MsNode): MsNode[] {
  n = unwrap(n);
  if (n.kind === "or_i" || n.kind === "or_d" || n.kind === "or_c" || n.kind === "or_b") {
    return [...splitDisjuncts(n.left), ...splitDisjuncts(n.right)];
  }
  if (n.kind === "andor") {
    const xy: MsNode = { id: uid(), kind: "and_v", left: n.x, right: n.y };
    return [...splitDisjuncts(xy), ...splitDisjuncts(n.z)];
  }
  return [n];
}

function peelLock(n: MsNode): { delay: number; body: MsNode } {
  n = unwrap(n);
  if (n.kind === "older" || n.kind === "after") {
    return { delay: n.n, body: { id: uid(), kind: "hole" } };
  }
  if (n.kind === "and_v" || n.kind === "and_b") {
    const L = peelLock(n.left);
    const R = peelLock(n.right);
    const delay = L.delay + R.delay;
    const lHole = L.body.kind === "hole";
    const rHole = R.body.kind === "hole";
    if (lHole && rHole) return { delay, body: { id: uid(), kind: "hole" } };
    if (lHole) return { delay, body: R.body };
    if (rHole) return { delay, body: L.body };
    return {
      delay,
      body: { id: uid(), kind: n.kind, left: L.body, right: R.body },
    };
  }
  return { delay: 0, body: n };
}

type KeyShape =
  | { type: "pk"; key: string }
  | { type: "multi"; k: number; keys: string[] }
  | { type: "and"; parts: KeyShape[] }
  | { type: "or"; parts: KeyShape[] };

function shapeOf(n: MsNode): KeyShape | null {
  n = unwrap(n);
  if (n.kind === "pk" || n.kind === "pkh") return { type: "pk", key: baseKeyName(n.key) };
  if (n.kind === "multi") {
    return { type: "multi", k: n.k, keys: [...new Set(n.keys.map(baseKeyName))] };
  }
  if (n.kind === "older" || n.kind === "after" || n.kind === "hole") return null;
  if (n.kind === "and_v" || n.kind === "and_b") {
    const L = shapeOf(n.left);
    const R = shapeOf(n.right);
    if (!L) return R;
    if (!R) return L;
    const parts = [...(L.type === "and" ? L.parts : [L]), ...(R.type === "and" ? R.parts : [R])];
    return { type: "and", parts };
  }
  if (n.kind === "or_i" || n.kind === "or_d" || n.kind === "or_c" || n.kind === "or_b") {
    const L = shapeOf(n.left);
    const R = shapeOf(n.right);
    if (!L) return R;
    if (!R) return L;
    const parts = [...(L.type === "or" ? L.parts : [L]), ...(R.type === "or" ? R.parts : [R])];
    return { type: "or", parts };
  }
  if (n.kind === "thresh") {
    const parts = n.children.map(shapeOf);
    if (parts.some((p) => !p)) return null;
    const keys = [...new Set(parts.flatMap((p) => shapeKeys(p!)))];
    return { type: "multi", k: Math.min(n.k, keys.length), keys };
  }
  return null;
}

function shapeKeys(s: KeyShape): string[] {
  if (s.type === "pk") return [s.key];
  if (s.type === "multi") return s.keys;
  return s.parts.flatMap(shapeKeys);
}

function flattenShape(shape: KeyShape): { keys: string[]; k: number; required?: string[] } {
  if (shape.type === "pk") return { keys: [shape.key], k: 1, required: [shape.key] };
  if (shape.type === "multi") {
    const keys = [...new Set(shape.keys)];
    const required = shape.k >= keys.length ? keys : undefined;
    return { keys, k: Math.min(shape.k, keys.length), required };
  }
  if (shape.type === "and") {
    const parts = shape.parts.map(flattenShape);
    const keys = [...new Set(parts.flatMap((p) => p.keys))];
    const required = [
      ...new Set(parts.flatMap((p) => p.required ?? (p.k >= p.keys.length ? p.keys : []))),
    ].filter((k) => keys.includes(k));
    const k = Math.min(
      keys.length,
      parts.reduce((sum, p) => sum + p.k, 0),
    );
    return { keys, k, required: required.length ? required : undefined };
  }
  const parts = shape.parts.map(flattenShape);
  const keys = [...new Set(parts.flatMap((p) => p.keys))];
  const k = Math.min(...parts.map((p) => p.k));
  return { keys, k };
}

export function stageFormula(stage: Stage): string {
  const req = (stage.required ?? []).filter((k) => stage.keys.includes(k));
  const rest = stage.keys.filter((k) => !req.includes(k));
  const kind = stage.hash ? " pkh" : "";
  if (req.length && rest.length) {
    const must = req.join(" + ");
    const choice = rest.length === 1 ? rest[0]! : `(${rest.join(" | ")})`;
    return `${must} + ${choice}${kind}`;
  }
  if (req.length && !rest.length) return `${req.join(" + ")}${kind}`;
  if (stage.k >= stage.keys.length) return `${stage.keys.join(" + ")}${kind}`;
  return `${stage.k}/${stage.keys.length} ${stage.keys.join(" · ")}${kind}`;
}

function branchHasPkh(n: MsNode): boolean {
  let hit = false;
  visit(n, (x) => {
    if (x.kind === "pkh") hit = true;
  });
  return hit;
}

function branchIsAndV(n: MsNode): boolean {
  const u = unwrap(n);
  return u.kind === "and_v" || u.kind === "and_b";
}

function stageAndV(body: MsNode, flat: { keys: string[]; k: number; required?: string[] }): boolean {
  if (branchHasPkh(body)) return false;
  const req = flat.required ?? [];
  if (req.length > 0 && req.length < flat.keys.length) return false;
  return branchIsAndV(body);
}

function stageSig(delay: number, keys: string[], k: number, required?: string[], hash?: boolean, andv?: boolean): string {
  const sorted = [...keys].sort();
  const req = (required ?? []).filter((x) => keys.includes(x)).sort();
  const reqPart =
    req.length > 0 ? req.join(",") : k >= sorted.length || sorted.length <= 1 ? sorted.join(",") : "";
  return `${delay}|${k}|${sorted.join(",")}|${reqPart}|${hash ? "h" : "p"}|${andv ? "a" : "m"}`;
}

/** Recover the left-hand stage GUI from an imported miniscript / wallet policy. */
export function inferStages(root: MsNode | null): Stage[] {
  if (!root || root.kind === "hole") return [];
  const stages: Stage[] = [];
  for (const branch of splitDisjuncts(root)) {
    const { delay, body } = peelLock(branch);
    const shape = shapeOf(body);
    if (!shape) continue;
    const flat = flattenShape(shape);
    if (!flat.keys.length) continue;
    stages.push({
      id: uid("st"),
      delay: Math.max(0, Math.min(MAX_OLDER, delay)),
      k: Math.max(1, flat.k),
      keys: flat.keys,
      required: flat.required,
      hash: branchHasPkh(body),
      andv: stageAndV(body, flat),
    });
  }
  if (!stages.length) return [];
  const merged = new Map<string, Stage>();
  for (const s of stages) {
    const sig = stageSig(s.delay, s.keys, s.k, s.required, s.hash, s.andv);
    if (!merged.has(sig)) merged.set(sig, s);
  }
  return [...merged.values()].sort((a, b) => a.delay - b.delay);
}

export function stageHighlightIds(
  root: MsNode | null,
  stages: Stage[],
  stageId: string | null,
): Set<string> {
  const ids = new Set<string>();
  if (!root || !stageId) return ids;
  const target = stages.find((s) => s.id === stageId);
  if (!target) return ids;
  const want = stageSig(target.delay, target.keys, target.k, target.required, target.hash, target.andv);
  const wantLoose = stageSig(target.delay, target.keys, target.k, target.required, target.hash, false);
  const branches = splitDisjuncts(root);
  for (const branch of branches) {
    const { delay, body } = peelLock(branch);
    const shape = shapeOf(body);
    if (!shape) continue;
    const flat = flattenShape(shape);
    const hash = branchHasPkh(body);
    const andv = stageAndV(body, flat);
    const got = stageSig(delay, flat.keys, flat.k, flat.required, hash, andv);
    const gotLoose = stageSig(delay, flat.keys, flat.k, flat.required, hash, false);
    if (got !== want && gotLoose !== wantLoose) continue;
    visit(branch, (n) => ids.add(n.id));
    break;
  }
  if (ids.size || branches.length > 1) return ids;
  visit(root, (n) => ids.add(n.id));
  return ids;
}

export function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  if (items.length > 5) return [items.slice()];
  const out: T[][] = [];
  const a = items.slice();
  const c = new Array(a.length).fill(0);
  out.push(a.slice());
  let i = 0;
  while (i < a.length) {
    if (c[i]! < i) {
      const j = i % 2 === 0 ? 0 : c[i]!;
      const tmp = a[j]!;
      a[j] = a[i]!;
      a[i] = tmp;
      out.push(a.slice());
      c[i]! += 1;
      i = 0;
    } else {
      c[i] = 0;
      i += 1;
    }
  }
  return out;
}

export function stageKeyOrderVariants(stages: Stage[], limit = 48): Stage[][] {
  const cleaned = cleanedStages(stages);
  if (!cleaned.length) return [];
  const options = cleaned.map((s) => (s.sorted || s.keys.length <= 1 ? [s.keys] : permutations(s.keys)));
  let product: string[][][] = [[]];
  for (const list of options) {
    product = product.flatMap((row) => list.map((keys) => [...row, keys]));
    if (product.length > limit * 4) break;
  }
  return product.slice(0, limit).map((orders) =>
    cleaned.map((s, i) => ({
      ...s,
      keys: orders[i] ?? s.keys,
    })),
  );
}

export function stageOrderCount(stages: Stage[]): { total: number; capped: boolean } {
  const cleaned = cleanedStages(stages);
  let total = 1;
  let capped = false;
  for (const s of cleaned) {
    if (s.sorted || s.keys.length <= 1) continue;
    if (s.keys.length > 5) capped = true;
    const n = Math.min(s.keys.length, 5);
    let f = 1;
    for (let i = 2; i <= n; i++) f *= i;
    total *= f;
  }
  return { total, capped };
}
