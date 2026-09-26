import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BIP32 } from "@bitcoinerlab/descriptors";
import { deriveAddressesLocal } from "./derive-local.ts";

describe("local descriptor derive", () => {
  it("derives a sortedmulti address without Core", () => {
    const x1 = BIP32.fromSeed(new Uint8Array(64).fill(1)).derivePath("m/48'/0'/0'/2'").neutered().toBase58();
    const x2 = BIP32.fromSeed(new Uint8Array(64).fill(2)).derivePath("m/48'/0'/0'/2'").neutered().toBase58();
    const desc = `wsh(sortedmulti(2,[aaaaaaaa/48'/0'/0'/2']${x1}/0/*,[bbbbbbbb/48'/0'/0'/2']${x2}/0/*))`;
    const [address] = deriveAddressesLocal(desc, 3, 3);
    assert.equal(address, "bc1q99fhzfwu5ddxk0r7mdvm4r26uhl396xwazcandpn54xp3eqks4wsaqjded");
  });
});
