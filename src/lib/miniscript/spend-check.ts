import { displayKeyToken, baseKeyName, type KeyEntry } from "./keys.ts";
import { describeStageSlots, type Stage } from "./stages.ts";

export interface SpendCoin {
  height: number;
  amount: number;
}

export interface SpendStageView {
  index: number;
  stageId: string;
  delay: number;
  quorum: string;
  confirmations: number;
  lockOpen: boolean;
  blocksLeft: number;
  opensAt: number;
  canSign: boolean;
  canSpendNow: boolean;
  have: string[];
  missingMust: string[];
  restHave: number;
  restNeed: number;
  restPool: string[];
  amountNow: number;
  nextAmount: number;
  nextBlocks: number;
  nextOpensAt: number;
  coinCount: number;
}

export interface SpendReport {
  tip: number;
  confirmations: number;
  coinHeight: number;
  coinCount: number;
  total: number;
  stages: SpendStageView[];
  anyNow: boolean;
  anyLater: boolean;
}

export function confirmationsAt(tip: number, coinHeight: number): number {
  const t = Math.max(0, Math.floor(Number(tip) || 0));
  const h = Math.max(0, Math.floor(Number(coinHeight) || 0));
  if (h <= 0) return 0;
  return Math.max(0, t - h + 1);
}

export function coinHeightFromConfirms(tip: number, confirms: number): number {
  const t = Math.max(0, Math.floor(Number(tip) || 0));
  const c = Math.max(0, Math.floor(Number(confirms) || 0));
  if (c <= 0) return 0;
  return Math.max(1, t - c + 1);
}

/** Oldest mined UTXO (lowest height). Unconfirmed (0) are ignored unless nothing is mined. */
export function oldestCoinHeight(heights: number[]): number {
  const mined = heights.map((n) => Math.floor(Number(n) || 0)).filter((n) => n > 0);
  if (!mined.length) return 0;
  return Math.min(...mined);
}

export function youngestCoinHeight(heights: number[]): number {
  const mined = heights.map((n) => Math.floor(Number(n) || 0)).filter((n) => n > 0);
  if (!mined.length) return 0;
  return Math.max(...mined);
}

function splitCoins(coins: SpendCoin[], tip: number, delay: number) {
  const open: SpendCoin[] = [];
  const locked: { coin: SpendCoin; left: number; opensAt: number }[] = [];
  for (const coin of coins) {
    const h = Math.max(0, Math.floor(Number(coin.height) || 0));
    const conf = confirmationsAt(tip, h);
    if (delay <= 0 || conf >= delay) {
      open.push(coin);
      continue;
    }
    const left = Math.max(0, delay - conf);
    const opensAt = h > 0 ? h + delay - 1 : tip + delay;
    locked.push({ coin, left, opensAt });
  }
  const amountNow = open.reduce((s, c) => s + (Number(c.amount) || 0), 0);
  locked.sort((a, b) => a.left - b.left || a.opensAt - b.opensAt);
  const nextBlocks = locked[0]?.left ?? 0;
  const nextOpensAt = locked[0]?.opensAt ?? 0;
  const nextAmount = locked.filter((x) => x.left === nextBlocks).reduce((s, x) => s + (Number(x.coin.amount) || 0), 0);
  return { amountNow, nextAmount, nextBlocks, nextOpensAt, openCount: open.length };
}

export function evaluateSpendPaths(opts: {
  stages: Stage[];
  reuse: boolean;
  present: string[];
  keys?: KeyEntry[];
  tip: number;
  coinHeight: number;
  coins?: SpendCoin[];
}): SpendReport {
  const present = new Set(opts.present.map((n) => baseKeyName(n)).filter(Boolean));
  const tip = Math.max(0, Math.floor(Number(opts.tip) || 0));
  const coins = (opts.coins ?? []).filter((c) => Number(c.amount) > 0 || Number(c.height) >= 0);
  const coinHeight =
    coins.length > 0 ? oldestCoinHeight(coins.map((c) => c.height)) : Math.max(0, Math.floor(Number(opts.coinHeight) || 0));
  const conf = confirmationsAt(tip, coinHeight);
  const keys = opts.keys ?? [];
  const label = (token: string) => displayKeyToken(token, keys);
  const slots = describeStageSlots(opts.stages, opts.reuse);
  const cleaned = opts.stages
    .map((s) => ({
      ...s,
      keys: s.keys.map((k) => k.trim()).filter(Boolean),
      required: (s.required ?? []).map((k) => k.trim()).filter(Boolean),
    }))
    .filter((s) => s.keys.length > 0)
    .sort((a, b) => a.delay - b.delay || a.id.localeCompare(b.id));
  const total = coins.reduce((s, c) => s + (Number(c.amount) || 0), 0);

  const stages = slots.map((slot, i) => {
    const stage = cleaned[i];
    const requiredNames = new Set((stage?.required ?? []).map((n) => baseKeyName(n)));
    const must = slot.signers.filter((s) => requiredNames.has(baseKeyName(s.token)));
    const rest = slot.signers.filter((s) => !requiredNames.has(baseKeyName(s.token)));
    const k = slot.k;
    const restNeed = must.length ? Math.max(0, k - must.length) : k;
    const haveSigners = slot.signers.filter((s) => present.has(baseKeyName(s.token)));
    const haveSet = new Set(haveSigners.map((s) => s.token));
    const missingMust = must.filter((s) => !haveSet.has(s.token)).map((s) => label(s.token));
    const restHave = rest.filter((s) => haveSet.has(s.token)).length;
    const restPool = rest.filter((s) => !haveSet.has(s.token)).map((s) => label(s.token));
    const canSign = missingMust.length === 0 && restHave >= restNeed;
    const split = coins.length
      ? splitCoins(coins, tip, slot.delay)
      : { amountNow: 0, nextAmount: 0, nextBlocks: 0, nextOpensAt: 0, openCount: 0 };
    const lockOpen = coins.length ? split.amountNow > 0 || slot.delay <= 0 : slot.delay <= 0 || conf >= slot.delay;
    const blocksLeft = coins.length
      ? lockOpen
        ? 0
        : split.nextBlocks
      : lockOpen
        ? 0
        : Math.max(0, slot.delay - conf);
    const opensAt = !lockOpen && coins.length && split.nextOpensAt
      ? split.nextOpensAt
      : slot.delay <= 0
        ? tip
        : coinHeight > 0
          ? coinHeight + slot.delay - 1
          : tip + slot.delay;
    const canSpendNow = coins.length ? canSign && split.amountNow > 0 : canSign && lockOpen;
    return {
      index: slot.index,
      stageId: stage?.id ?? slot.index.toString(),
      delay: slot.delay,
      quorum: slot.quorum,
      confirmations: conf,
      lockOpen,
      blocksLeft: coins.length && lockOpen ? 0 : blocksLeft,
      opensAt,
      canSign,
      canSpendNow,
      have: haveSigners.map((s) => label(s.token)),
      missingMust,
      restHave,
      restNeed,
      restPool,
      amountNow: split.amountNow,
      nextAmount: split.nextAmount,
      nextBlocks: split.nextBlocks,
      nextOpensAt: split.nextOpensAt,
      coinCount: coins.length,
    };
  });

  return {
    tip,
    confirmations: conf,
    coinHeight,
    coinCount: coins.length,
    total,
    stages,
    anyNow: stages.some((s) => s.canSpendNow),
    anyLater: stages.some((s) => s.canSign && !s.canSpendNow),
  };
}
