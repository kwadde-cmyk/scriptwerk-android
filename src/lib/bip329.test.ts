import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  asStoredLabels,
  buildBip329Export,
  coinLabel,
  coinLabelSource,
  labelKey,
  mergeLabels,
  parseBip329,
  serializeBip329,
  storedFromRecords,
} from "./bip329.ts";

describe("BIP-329", () => {
  it("parses JSONL and a JSON array", () => {
    const jsonl = [
      JSON.stringify({ type: "addr", ref: "bc1qabc", label: "Miete" }),
      JSON.stringify({ type: "output", ref: "AA:0", label: "Coin", spendable: false, value: 123 }),
    ].join("\n");
    const lines = parseBip329(jsonl);
    assert.equal(lines.records.length, 2);
    assert.equal(lines.records[0]?.label, "Miete");
    assert.equal(lines.records[1]?.ref, "aa:0");
    assert.equal(lines.records[1]?.spendable, false);

    const arr = parseBip329(JSON.stringify([{ type: "tx", ref: "DEAD", label: "Gift" }]));
    assert.equal(arr.records[0]?.ref, "dead");
    assert.equal(arr.records[0]?.type, "tx");
  });

  it("skips garbage lines and accepts a single object", () => {
    const mixed = 'not json\n{"type":"addr","ref":"bc1qxy"}\n{"type":"nope","ref":"x"}';
    const hit = parseBip329(mixed);
    assert.equal(hit.records.length, 1);
    assert.ok(hit.skipped >= 1);
    const one = parseBip329('{"type":"xpub","ref":"xpubABC","label":"Ledger"}');
    assert.equal(one.records[0]?.type, "xpub");
  });

  it("round-trips serialize → parse", () => {
    const body = serializeBip329([
      { type: "addr", ref: "BC1QTEST", label: "Spare" },
      { type: "output", ref: "ab:1", label: "UTXO", value: 50_000, height: 800000, spendable: true },
    ]);
    assert.match(body, /\n$/);
    const back = parseBip329(body);
    assert.equal(back.records.length, 2);
    assert.equal(back.records[0]?.ref, "bc1qtest");
    assert.equal(back.records[1]?.value, 50_000);
  });

  it("merges labels by type+ref", () => {
    const a = storedFromRecords([{ type: "addr", ref: "bc1qa", label: "old" }]);
    const b = storedFromRecords([
      { type: "addr", ref: "bc1qa", label: "new" },
      { type: "tx", ref: "ff", label: "fee" },
    ]);
    const merged = mergeLabels(a, b);
    assert.equal(merged[labelKey("addr", "bc1qa")]?.label, "new");
    assert.equal(merged[labelKey("tx", "ff")]?.label, "fee");
  });

  it("prefers output labels over address labels", () => {
    const labels = asStoredLabels({
      "addr:bc1qaa": { type: "addr", ref: "bc1qaa", label: "Rent" },
      "output:aa:0": { type: "output", ref: "aa:0", label: "That coin" },
    });
    assert.equal(coinLabel(labels, "aa", 0, "bc1qaa"), "That coin");
    assert.equal(coinLabel(labels, "bb", 1, "bc1qaa"), "Rent");
    const src = coinLabelSource(labels, "aa", 0, "bc1qaa");
    assert.equal(src.type, "output");
    assert.equal(src.ref, "aa:0");
  });

  it("accepts type aliases and tag fields", () => {
    const hit = parseBip329(JSON.stringify({ type: "address", ref: "BC1QZZ", tag: "Shop" }));
    assert.equal(hit.records[0]?.type, "addr");
    assert.equal(hit.records[0]?.ref, "bc1qzz");
    assert.equal(hit.records[0]?.label, "Shop");
    const utxo = parseBip329(JSON.stringify({ type: "utxo", ref: "FF:2", name: "Coin" }));
    assert.equal(utxo.records[0]?.type, "output");
    assert.equal(utxo.records[0]?.ref, "ff:2");
    assert.equal(utxo.records[0]?.label, "Coin");
  });

  it("overwrites an inherited address label with an output label", () => {
    const labels = storedFromRecords([{ type: "addr", ref: "bc1qaa", label: "Rent" }]);
    const next = mergeLabels(
      labels,
      storedFromRecords([{ type: "output", ref: "aa:0", label: "This coin" }]),
    );
    assert.equal(coinLabel(next, "aa", 0, "bc1qaa"), "This coin");
    assert.equal(coinLabel(next, "bb", 1, "bc1qaa"), "Rent");
  });

  it("exports labeled addresses, outputs and xpubs", () => {
    const labels = storedFromRecords([{ type: "addr", ref: "bc1qaa", label: "Shop" }]);
    const recs = buildBip329Export({
      labels,
      origin: "wsh(pk(A))#abcd1234",
      addresses: [{ address: "bc1qaa" }, { address: "bc1qbb" }],
      unspents: [{ txid: "aa", vout: 0, amount: 0.5, height: 10, address: "bc1qaa" }],
      xpubs: [{ xpub: "xpubABC", note: "Alice" }],
    });
    assert.ok(recs.some((r) => r.type === "addr" && r.label === "Shop"));
    const out = recs.find((r) => r.type === "output");
    assert.equal(out?.label, "Shop");
    assert.equal(out?.value, 50_000_000);
    assert.ok(recs.some((r) => r.type === "xpub" && r.label === "Alice"));
    assert.equal(recs.filter((r) => r.type === "addr" && r.ref === "bc1qbb").length, 0);
  });
});
