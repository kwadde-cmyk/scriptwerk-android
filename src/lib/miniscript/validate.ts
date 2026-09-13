import type { MsNode } from "./ast.ts";
import { collectKeys, hasHoles, visit } from "./ast.ts";
import { compileMiniscript } from "./compile.ts";
import { t, type Locale } from "../i18n.ts";

export interface Issue {
  level: "error" | "warn" | "info";
  message: string;
}

export function validatePolicy(root: MsNode | null, locale: Locale = "de"): Issue[] {
  if (!root) return [{ level: "info", message: t(locale, "val.noPolicy") }];
  const issues: Issue[] = [];
  if (hasHoles(root)) {
    issues.push({ level: "error", message: t(locale, "val.holes") });
  }

  visit(root, (n) => {
    if (n.kind === "older") {
      if (n.n < 1 || n.n > 65535) {
        issues.push({ level: "error", message: t(locale, "val.olderRange", { n: n.n }) });
      }
    }
    if (n.kind === "multi") {
      if (n.k < 1 || n.k > n.keys.length) {
        issues.push({
          level: "error",
          message: t(locale, "val.multiK", { k: n.k, n: n.keys.length }),
        });
      }
      if (n.keys.length > 20) {
        issues.push({ level: "error", message: t(locale, "val.multiMax") });
      }
      const dup = n.keys.filter((k, i) => n.keys.indexOf(k) !== i);
      if (dup.length) {
        issues.push({
          level: "warn",
          message: t(locale, "val.multiDup", { names: [...new Set(dup)].join(", ") }),
        });
      }
    }
    if (n.kind === "and_v") {
      if (!isVerifyish(n.left)) {
        issues.push({
          level: "warn",
          message: t(locale, "val.andV"),
        });
      }
    }
  });

  const keys = collectKeys(root);
  const reused = reusedNames(root);
  if (reused.length) {
    issues.push({
      level: "info",
      message: t(locale, "val.reuse", { names: reused.join(", ") }),
    });
  }

  const compiled = compileMiniscript(root);
  if (compiled.length > 360 && !hasHoles(root)) {
    issues.push({
      level: "warn",
      message: t(locale, "val.long"),
    });
  }

  const depth = treeDepth(root);
  if (depth >= 6) {
    issues.push({
      level: "warn",
      message: t(locale, "val.depth", { n: depth }),
    });
  }

  return issues;
}

function isVerifyish(n: MsNode): boolean {
  if (n.kind === "wrap" && n.wrap === "v") return true;
  if (n.kind === "and_v") return true;
  return false;
}

function reusedNames(root: MsNode): string[] {
  const counts = new Map<string, number>();
  visit(root, (n) => {
    const add = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
    if (n.kind === "pk" || n.kind === "pkh") add(n.key);
    if (n.kind === "multi") n.keys.forEach(add);
  });
  return [...counts.entries()].filter(([, c]) => c > 1).map(([k]) => k);
}

function treeDepth(n: MsNode): number {
  switch (n.kind) {
    case "thresh":
      return 1 + Math.max(0, ...n.children.map(treeDepth));
    case "and_v":
    case "and_b":
    case "or_i":
    case "or_d":
    case "or_c":
    case "or_b":
      return 1 + Math.max(treeDepth(n.left), treeDepth(n.right));
    case "andor":
      return 1 + Math.max(treeDepth(n.x), treeDepth(n.y), treeDepth(n.z));
    case "wrap":
      return 1 + treeDepth(n.child);
    default:
      return 1;
  }
}
