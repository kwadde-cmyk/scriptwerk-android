import { visit, type MsNode } from "./ast.ts";
import { confirmationsAt } from "./spend-check.ts";
import { describeStageSlots, type Stage } from "./stages.ts";

export type CoinSpendState = "unconfirmed" | "now" | "later" | "unknown";

export interface CoinPath {
  index: number;
  delay: number;
  quorum: string;
  kind: "older" | "after";
  open: boolean;
  blocksLeft: number;
  opensAt: number;
}

export interface CoinStatus {
  confirmations: number;
  state: CoinSpendState;
  spendable: boolean;
  unknown: boolean;
  paths: CoinPath[];
  next?: CoinPath;
}

export function collectLockHints(root: MsNode | null): {
  olders: number[];
  afters: number[];
  unknown: boolean;
} {
  const olders: number[] = [];
  const afters: number[] = [];
  let unknown = false;
  if (!root) return { olders, afters, unknown };
  visit(root, (n) => {
    if (n.kind === "older") olders.push(Math.max(0, Math.floor(Number(n.n) || 0)));
    else if (n.kind === "after") afters.push(Math.max(0, Math.floor(Number(n.n) || 0)));
    else if (n.kind === "unknown") unknown = true;
  });
  return { olders, afters, unknown };
}

function olderPath(index: number, delay: number, quorum: string, tip: number, height: number, conf: number): CoinPath {
  const d = Math.max(0, Math.floor(Number(delay) || 0));
  const open = height > 0 && conf >= d;
  const blocksLeft = open || height <= 0 ? 0 : Math.max(0, d - conf);
  const opensAt = d <= 0 ? (height > 0 ? height : tip) : height > 0 ? height + d - 1 : tip + d;
  return { index, delay: d, quorum, kind: "older", open, blocksLeft, opensAt };
}

function afterPath(index: number, lock: number, quorum: string, tip: number): CoinPath {
  const n = Math.max(0, Math.floor(Number(lock) || 0));
  const open = tip >= n && n > 0 ? true : n <= 0 && tip > 0;
  const blocksLeft = open ? 0 : Math.max(0, n - tip);
  return { index, delay: n, quorum, kind: "after", open, blocksLeft, opensAt: n };
}

export function evaluateCoinStatus(opts: {
  height: number;
  tip: number;
  stages?: Stage[];
  reuse?: boolean;
  root?: MsNode | null;
}): CoinStatus {
  const tip = Math.max(0, Math.floor(Number(opts.tip) || 0));
  const height = Math.max(0, Math.floor(Number(opts.height) || 0));
  const conf = confirmationsAt(tip, height);
  const hints = collectLockHints(opts.root ?? null);
  const stages = (opts.stages ?? []).filter((s) => s.keys.some((k) => k.trim()));
  const paths: CoinPath[] = [];

  if (stages.length) {
    const slots = describeStageSlots(stages, opts.reuse ?? false);
    for (const slot of slots) {
      if (slot.lock === "after") paths.push(afterPath(slot.index, slot.delay, slot.quorum, tip));
      else paths.push(olderPath(slot.index, slot.delay, slot.quorum, tip, height, conf));
    }
  } else if (hints.afters.length || hints.olders.length) {
    let i = 1;
    const older = hints.olders.length ? Math.max(...hints.olders) : 0;
    const after = hints.afters.length ? Math.max(...hints.afters) : 0;
    if (older > 0) paths.push(olderPath(i++, older, "older", tip, height, conf));
    if (after > 0) paths.push(afterPath(i++, after, "after", tip));
  }

  const locked = paths.filter((p) => !p.open);
  const open = paths.filter((p) => p.open);
  const next = locked.slice().sort((a, b) => a.blocksLeft - b.blocksLeft || a.opensAt - b.opensAt)[0];

  if (height <= 0) {
    return { confirmations: 0, state: "unconfirmed", spendable: false, unknown: hints.unknown, paths, next };
  }

  if (hints.unknown) {
    const pending = paths.some((p) => !p.open);
    return {
      confirmations: conf,
      state: pending ? "later" : "unknown",
      spendable: false,
      unknown: true,
      paths,
      next: pending ? next : undefined,
    };
  }

  if (paths.length === 0) {
    return {
      confirmations: conf,
      state: "now",
      spendable: true,
      unknown: false,
      paths,
    };
  }

  // after() AND older() in a raw tree both apply (conservative).
  const allOpen = paths.every((p) => p.open);
  const anyOpen = open.length > 0;
  const spendable = stages.length ? anyOpen : allOpen;
  const state: CoinSpendState = spendable ? "now" : "later";
  return { confirmations: conf, state, spendable, unknown: hints.unknown, paths, next: spendable ? undefined : next };
}
