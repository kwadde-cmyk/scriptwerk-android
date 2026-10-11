import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CoinPath } from "./coin-status.ts";
import { coinsForPresent, inScope, needMet, openPathIndexes, pickPath, stageNeeds } from "./recovery-select.ts";
import type { Stage } from "./stages.ts";

const stages: Stage[] = [
  { id: "now", delay: 0, k: 2, keys: ["A", "B", "C"] },
  { id: "later", delay: 12960, k: 1, keys: ["C"] },
];

function path(index: number, open: boolean, delay = 0): CoinPath {
  return { index, delay, quorum: "2of3", kind: "older", open, blocksLeft: open ? 0 : 10, opensAt: 100 };
}

describe("recovery select", () => {
  const needs = stageNeeds(stages, true, []);

  it("treats the immediate stage as movable, not only an elapsed timelock", () => {
    const open = openPathIndexes([path(1, true, 0), path(2, false, 12960)]);
    assert.deepEqual(open, [0]);
    assert.equal(inScope(open, "stage", 0), true);
    assert.equal(inScope(open, "stage", 1), false);
    assert.equal(inScope(open, "open", null), true);
  });

  it("selects coins the marked keys can move, and the other way reports the path", () => {
    const coins = [
      { id: "early", open: [0] },
      { id: "both", open: [0, 1] },
      { id: "late-only", open: [1] },
      { id: "locked", open: [] },
    ];
    const two = new Set(["A", "B"]);
    assert.deepEqual(coinsForPresent(coins, needs, two, "open", null), ["early", "both"]);
    assert.deepEqual(coinsForPresent(coins, needs, new Set(["C"]), "open", null), ["both", "late-only"]);
    assert.deepEqual(coinsForPresent(coins, needs, two, "stage", 0), ["early", "both"]);
    assert.deepEqual(coinsForPresent(coins, needs, two, "stage", 1), []);
    assert.equal(needMet(needs[0]!, two), true);
    assert.equal(needMet(needs[0]!, new Set(["A"])), false);
    assert.equal(pickPath([0, 1], needs, new Set(["C"])), 1);
    assert.equal(pickPath([0], needs, new Set()), 0);
  });
});
