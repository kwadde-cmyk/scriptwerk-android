import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cameraErrorKey, parseLaunchIntent, stripLaunchIntent } from "./platform.ts";
import { bitboxUsbAvailable, ledgerUsbAvailable, pickLedgerTransport } from "./hw/types.ts";

describe("launch intent", () => {
  it("reads scan and usb from the query", () => {
    assert.equal(parseLaunchIntent("?scan=1"), "scan");
    assert.equal(parseLaunchIntent("usb=1"), "usb");
    assert.equal(parseLaunchIntent("?foo=1"), null);
  });

  it("reads hash fallbacks", () => {
    assert.equal(parseLaunchIntent("", "#scan"), "scan");
    assert.equal(parseLaunchIntent("", "#usb"), "usb");
  });

  it("strips device params from the URL", () => {
    const url = stripLaunchIntent(new URL("https://app.example/?scan=1&usb=1#cam"));
    assert.equal(url.searchParams.has("scan"), false);
    assert.equal(url.searchParams.has("usb"), false);
    assert.equal(url.hash, "");
  });
});

describe("camera errors", () => {
  it("maps permission and iframe failures", () => {
    assert.equal(cameraErrorKey({ name: "NotAllowedError", message: "denied" }, false), "qr.denied");
    assert.equal(cameraErrorKey({ name: "NotFoundError", message: "" }, false), "qr.noneFound");
    assert.equal(cameraErrorKey(new Error("blocked"), true), "qr.iframe");
    assert.equal(cameraErrorKey({ name: "SecurityError", message: "iframe" }, false), "qr.iframe");
  });
});

describe("ledger transport", () => {
  it("prefers HID, then WebUSB, and blocks iframes", () => {
    assert.equal(pickLedgerTransport("ok"), "hid");
    assert.equal(pickLedgerTransport("usb"), "usb");
    assert.equal(pickLedgerTransport("iframe"), "iframe");
    assert.equal(pickLedgerTransport("missing"), "none");
    assert.equal(ledgerUsbAvailable("usb"), true);
    assert.equal(ledgerUsbAvailable("ok"), true);
    assert.equal(bitboxUsbAvailable("usb"), false);
    assert.equal(bitboxUsbAvailable("ok"), true);
  });

  it("APK native path (ok) enables Ledger and BitBox", () => {
    assert.equal(ledgerUsbAvailable("ok"), true);
    assert.equal(bitboxUsbAvailable("ok"), true);
  });
});
