import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exactBuffer, fromHex, matchUsbFilter, toHex } from "./usb-util.ts";

describe("usb hex", () => {
  it("round-trips bytes", () => {
    const src = new Uint8Array([0, 15, 16, 255]);
    assert.equal(toHex(src), "000f10ff");
    assert.deepEqual(Array.from(fromHex("000f10ff")), [0, 15, 16, 255]);
  });

  it("copies an exact ArrayBuffer for Ledger/BitBox", () => {
    const raw = new Uint8Array([1, 2, 3, 4, 5]);
    const slice = raw.subarray(1, 4);
    const buf = exactBuffer(slice);
    assert.equal(buf.byteLength, 3);
    assert.deepEqual(Array.from(new Uint8Array(buf)), [2, 3, 4]);
  });
});

describe("usb filters", () => {
  it("matches vendor and product", () => {
    const ledger = { vendorId: 0x2c97, productId: 0x0001 };
    const bitbox = { vendorId: 0x03eb, productId: 0x2403 };
    assert.equal(matchUsbFilter(ledger, [{ vendorId: 0x2c97 }]), true);
    assert.equal(matchUsbFilter(bitbox, [{ vendorId: 0x03eb, productId: 0x2403 }]), true);
    assert.equal(matchUsbFilter(bitbox, [{ vendorId: 0x2c97 }]), false);
    assert.equal(matchUsbFilter(ledger), true);
  });
});
