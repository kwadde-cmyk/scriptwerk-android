import { baseKeyName, displayKeyToken, type KeyEntry } from "./keys.ts";
import type { CoinPath } from "./coin-status.ts";
import { compareStages, describeStageSlots, type Stage, type StageSignerSlot } from "./stages.ts";

export type RecoveryScope = "stage" | "open";

export interface PathNeed {
  pathIndex: number;
  quorum: string;
  must: string[];
  rest: string[];
  restNeed: number;
  mustLabels: string[];
  restLabels: string[];
}

export function pathNeed(stage: Stage | undefined, slot: StageSignerSlot, keys: KeyEntry[]): PathNeed {
  const required = new Set((stage?.required ?? []).map((n) => baseKeyName(n)));
  const must = slot.signers.filter((s) => required.has(baseKeyName(s.token)));
  const rest = slot.signers.filter((s) => !required.has(baseKeyName(s.token)));
  return {
    pathIndex: slot.index - 1,
    quorum: slot.quorum,
    must: must.map((s) => baseKeyName(s.token)),
    rest: rest.map((s) => baseKeyName(s.token)),
    restNeed: must.length ? Math.max(0, slot.k - must.length) : slot.k,
    mustLabels: must.map((s) => displayKeyToken(s.token, keys)),
    restLabels: rest.map((s) => displayKeyToken(s.token, keys)),
  };
}

export function stageNeeds(stages: Stage[], reuse: boolean, keys: KeyEntry[]): PathNeed[] {
  const slots = describeStageSlots(stages, reuse);
  const cleaned = stages
    .map((s) => ({
      ...s,
      keys: s.keys.map((k) => k.trim()).filter(Boolean),
      required: (s.required ?? []).map((k) => k.trim()).filter(Boolean),
    }))
    .filter((s) => s.keys.length > 0)
    .sort(compareStages);
  return slots.map((slot, i) => pathNeed(cleaned[i], slot, keys));
}

export function needMet(need: PathNeed, present: ReadonlySet<string>): boolean {
  if (need.must.some((n) => !present.has(n))) return false;
  return need.rest.filter((n) => present.has(n)).length >= need.restNeed;
}

/** Indexes of paths that can spend this coin right now, including delay 0. */
export function openPathIndexes(paths: CoinPath[]): number[] {
  const out: number[] = [];
  paths.forEach((p, i) => {
    if (p.open) out.push(i);
  });
  return out;
}

export function inScope(open: number[], scope: RecoveryScope, stageIndex: number | null): boolean {
  if (!open.length) return false;
  if (scope === "open") return true;
  return stageIndex != null && open.includes(stageIndex);
}

/** Earliest open path the marked keys can sign. With no keys, the earliest open path. */
export function pickPath(open: number[], needs: PathNeed[], present: ReadonlySet<string>): number | null {
  if (!open.length) return null;
  const signable = open.filter((i) => needs[i] && needMet(needs[i], present));
  const pool = present.size && signable.length ? signable : open;
  return pool[0] ?? null;
}

export function coinsForPresent<T extends { id: string; open: number[] }>(
  coins: T[],
  needs: PathNeed[],
  present: ReadonlySet<string>,
  scope: RecoveryScope,
  stageIndex: number | null,
): string[] {
  if (!present.size) return [];
  return coins
    .filter((c) => inScope(c.open, scope, stageIndex))
    .filter((c) => {
      const paths = scope === "stage" && stageIndex != null ? [stageIndex] : c.open;
      return paths.some((i) => needs[i] && needMet(needs[i], present));
    })
    .map((c) => c.id);
}
