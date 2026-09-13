import type { MsNode } from "./ast.ts";
import { blocksToHuman, blocksWhen, displayKeyToken, type KeyEntry } from "./keys.ts";
import { numberLocale, t, type Locale } from "../i18n.ts";

export interface SpendPath {
  delay: number;
  label: string;
  detail: string;
}

export interface SpendGroup {
  delay: number;
  paths: SpendPath[];
}

export function explainPolicy(
  root: MsNode,
  locale: Locale = "de",
  keys: KeyEntry[] = [],
): {
  title: string;
  paths: SpendPath[];
  groups: SpendGroup[];
  narrative: string[];
} {
  const label = (token: string) => displayKeyToken(token, keys);
  const paths = mergePaths(
    flatten(root, 0, locale, label).sort((a, b) => a.delay - b.delay || a.label.localeCompare(b.label)),
  );
  const groups = groupByDelay(paths);
  const narrative = groups.map((g) =>
    t(locale, "explain.when", {
      when: blocksWhen(g.delay, locale),
      body: g.paths.map((p) => p.label).join(t(locale, "explain.or")),
    }),
  );
  const immediate = paths.filter((p) => p.delay === 0).length;
  let title = t(locale, "explain.none");
  if (paths.length) {
    if (immediate === paths.length) {
      title =
        paths.length === 1
          ? t(locale, "explain.allNowOne")
          : t(locale, "explain.allNow", { n: paths.length });
    } else if (immediate === 0) {
      title =
        paths.length === 1
          ? t(locale, "explain.allLaterOne")
          : t(locale, "explain.allLater", { n: paths.length });
    } else title = t(locale, "explain.mix", { now: immediate, later: paths.length - immediate });
  }
  return {
    title,
    paths,
    groups,
    narrative: narrative.length ? narrative : [t(locale, "explain.empty")],
  };
}

export function groupByDelay(paths: SpendPath[]): SpendGroup[] {
  const map = new Map<number, SpendPath[]>();
  for (const p of paths) {
    const list = map.get(p.delay) ?? [];
    list.push(p);
    map.set(p.delay, list);
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([delay, items]) => ({ delay, paths: items }));
}

function flatten(
  node: MsNode,
  delay: number,
  locale: Locale,
  label: (token: string) => string,
): SpendPath[] {
  switch (node.kind) {
    case "hole":
      return [{ delay, label: t(locale, "explain.incomplete"), detail: t(locale, "explain.hole") }];
    case "pk":
      return [{ delay, label: label(node.key), detail: `pk(${node.key})` }];
    case "pkh":
      return [{ delay, label: t(locale, "explain.hash", { key: label(node.key) }), detail: `pkh(${node.key})` }];
    case "multi":
      return [
        {
          delay,
          label: t(locale, "explain.kofn", {
            k: node.k,
            n: node.keys.length,
            keys: node.keys.map(label).join(" · "),
          }),
          detail: `multi(${node.k},${node.keys.join(",")})`,
        },
      ];
    case "older":
      return [{ delay: delay + node.n, label: t(locale, "explain.timelock"), detail: `older(${node.n})` }];
    case "after":
      return [
        {
          delay,
          label: t(locale, "explain.afterBlock", { n: node.n.toLocaleString(numberLocale(locale)) }),
          detail: `after(${node.n})`,
        },
      ];
    case "wrap":
      return flatten(node.child, delay, locale, label);
    case "and_v":
    case "and_b":
      return andCombine(
        flatten(node.left, delay, locale, label),
        flatten(node.right, delay, locale, label),
        locale,
      );
    case "or_i":
    case "or_d":
    case "or_c":
    case "or_b":
      return [...flatten(node.left, delay, locale, label), ...flatten(node.right, delay, locale, label)];
    case "andor": {
      const xy = andCombine(
        flatten(node.x, delay, locale, label),
        flatten(node.y, delay, locale, label),
        locale,
      );
      return [...xy, ...flatten(node.z, delay, locale, label)];
    }
    case "thresh": {
      const childPaths = node.children.map((c) => flatten(c, delay, locale, label));
      return [
        {
          delay,
          label: t(locale, "explain.thresh", { k: node.k, n: node.children.length }),
          detail: childPaths.map((p, i) => `(${i + 1}) ${p.map((x) => x.label).join(" + ")}`).join(" · "),
        },
      ];
    }
  }
}

function andCombine(a: SpendPath[], b: SpendPath[], locale: Locale): SpendPath[] {
  const lock = t(locale, "explain.timelock");
  const out: SpendPath[] = [];
  for (const x of a) {
    for (const y of b) {
      out.push({
        delay: Math.max(x.delay, y.delay),
        label: joinAnd(x.label, y.label, lock),
        detail: `${x.detail} ∧ ${y.detail}`,
      });
    }
  }
  return out;
}

function joinAnd(a: string, b: string, lock: string): string {
  if (a === lock) return b;
  if (b === lock) return a;
  return `${a} + ${b}`;
}

function mergePaths(paths: SpendPath[]): SpendPath[] {
  const map = new Map<string, SpendPath>();
  for (const p of paths) {
    const key = `${p.delay}|${p.label}`;
    if (!map.has(key)) map.set(key, p);
  }
  return [...map.values()];
}

function holeTitle(hint: string | undefined, locale: Locale): string {
  if (!hint) return t(locale, "sub.slot");
  if (hint.startsWith("sub.branchN:")) return t(locale, "sub.branchN", { n: hint.slice("sub.branchN:".length) });
  if (hint.includes(".")) return t(locale, hint);
  return hint;
}

export function nodeTitle(node: MsNode, locale: Locale = "de"): string {
  switch (node.kind) {
    case "hole":
      return holeTitle(node.hint, locale);
    case "pk":
      return `pk ${node.key}`;
    case "pkh":
      return `pkh ${node.key}`;
    case "multi":
      return `${node.sorted ? "sortedmulti" : "multi"} ${node.k}/${node.keys.length}`;
    case "thresh":
      return `thresh ${node.k}/${node.children.length}`;
    case "older":
      return `older ${node.n}`;
    case "after":
      return `after ${node.n}`;
    case "wrap":
      return `${node.wrap}:`;
    default:
      return node.kind;
  }
}

export function nodeSubtitle(node: MsNode, locale: Locale = "de"): string {
  switch (node.kind) {
    case "hole":
      return t(locale, "sub.pick");
    case "pk":
    case "pkh":
      return t(locale, "sub.key");
    case "multi":
      return node.keys.join(" · ");
    case "older":
      return blocksToHuman(node.n, locale);
    case "after":
      return t(locale, "sub.block", { n: node.n.toLocaleString(numberLocale(locale)) });
    case "and_v":
    case "and_b":
      return t(locale, "sub.both");
    case "or_i":
    case "or_d":
    case "or_c":
    case "or_b":
      return t(locale, "sub.either");
    case "andor":
      return "(X ∧ Y) ∨ Z";
    case "thresh":
      return t(locale, "sub.any");
    case "wrap":
      return "";
  }
}
