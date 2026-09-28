import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hidKind } from "./usb-kind.ts";

describe("usb kind", () => {
  it("tells a Ledger from a BitBox", () => {
    assert.equal(hidKind({ vendorId: 0x2c97, productId: 0x0001, productName: "Nano S Plus" }), "ledger");
    assert.equal(hidKind({ vendorId: 0x03eb, productId: 0x2403, productName: "BitBox02" }), "bitbox");
    assert.equal(hidKind({ vendorId: 0x03eb, productId: 0x2402 }), "bitbox");
    assert.equal(hidKind({ vendorId: 0x1234, productId: 1, productName: "Keyboard" }), null);
  });
});
