import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeDescriptor } from "./analyze.ts";
import { corsBlocked, bookmarkletHref, bridgeScript } from "./bridge.ts";
import {
  addressSpace,
  defaultRpcPort,
  isLanIpUrl,
  looksLikeStartos,
  hostProxyIsStartosSource,
  normalizeRpcUrl,
  splitCookie,
} from "./rpc.ts";
import { descsumCreate } from "../miniscript/checksum.ts";

const XPUB =
  "xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5hqK5Gb4u1Q2ZbQW2kfykAPzh9RQQJwYvNUbaMhEaKfLUWuBvYJMTx5N";

describe("bitcoind rpc helpers", () => {
  it("turns a LAN host into an http RPC url", () => {
    assert.equal(normalizeRpcUrl("192.168.1.20", "mainnet"), "http://192.168.1.20:8332");
    assert.equal(normalizeRpcUrl("192.168.1.20:18332"), "http://192.168.1.20:18332");
    assert.equal(normalizeRpcUrl("127.0.0.1"), "http://127.0.0.1:8332");
    assert.equal(normalizeRpcUrl("https://umbrel.local/"), "https://umbrel.local");
    assert.equal(
      normalizeRpcUrl("LAN: https://capable-dosage.local:57521"),
      "https://capable-dosage.local:57521",
    );
    assert.equal(normalizeRpcUrl("<https://node.local:57521>"), "https://node.local:57521");
    assert.doesNotThrow(() => normalizeRpcUrl("ftp://example.local"));
    assert.doesNotThrow(() => normalizeRpcUrl("not a url :// oops"));
    assert.match(normalizeRpcUrl("ftp://example.local:57521"), /example\.local:57521/);
    assert.equal(defaultRpcPort(), 8332);
    assert.equal(addressSpace("https://192.168.1.80:57521"), "local");
    assert.equal(addressSpace("http://127.0.0.1:8332"), "loopback");
    assert.equal(looksLikeStartos("https://192.168.1.80:57521"), true);
    assert.equal(looksLikeStartos("https://abc.local:57521"), true);
    assert.equal(isLanIpUrl("https://192.168.1.80:57521"), true);
    assert.equal(isLanIpUrl("https://abc.local:57521"), false);
    assert.equal(hostProxyIsStartosSource("startos"), true);
    assert.equal(hostProxyIsStartosSource("env"), false);
    assert.equal(hostProxyIsStartosSource(""), false);
  });

  it("detects CORS-blocked StartOS traces", () => {
    assert.equal(
      corsBlocked({
        url: "https://node.local:57521",
        origin: "https://example.com",
        space: "local",
        ok: false,
        probe: null,
        steps: [
          { id: "reach", status: "ok", detail: "opaque" },
          { id: "corsGet", status: "skip", detail: "only POST" },
          { id: "preflight", status: "fail", detail: "Failed to fetch" },
          { id: "rpc", status: "fail", detail: "blocked" },
        ],
      }),
      true,
    );
  });

  it("builds a POST-only bookmarklet", () => {
    const src = bridgeScript("https://scriptwerk.example");
    assert.match(src, /method:"POST"/);
    assert.match(src, /scriptwerk-bridge-ready/);
    assert.match(src, /text\/plain/);
    assert.match(src, /scriptwerk-hello/);
    assert.match(src, /Passwort/);
    assert.match(src, /postMessage\(d,"\*"\)/);
  });

  it("builds a javascript bookmark that Chrome can store", () => {
    const href = bookmarkletHref("https://hds-old.example");
    assert.equal(href.startsWith("javascript:void "), true);
    assert.match(href, /postMessage\(d,"\*"\)/);
    assert.doesNotMatch(href, /%22/);
    assert.equal(href.length < 8192, true);
  });

  it("splits a cookie user:pass pair", () => {
    assert.deepEqual(splitCookie("__cookie__:abc123", ""), { username: "__cookie__", password: "abc123" });
    assert.deepEqual(splitCookie("satoshi", "secret"), { username: "satoshi", password: "secret" });
    assert.deepEqual(splitCookie(" scriptwerk ", "  hunter2\n"), { username: "scriptwerk", password: "hunter2" });
  });
});

describe("bitcoind analyze", () => {
  it("accepts a checksummed wsh multi descriptor", () => {
    const desc = descsumCreate(`wsh(multi(2,[deadbeef/48h/0h/0h/2h]${XPUB}/<0;1>/*,[cafebabe/48h/0h/0h/2h]${XPUB}/<0;1>/*))`);
    const out = analyzeDescriptor(desc);
    assert.equal(out.ok, true);
    assert.equal(out.info?.issolvable, true);
    assert.equal(out.info?.isrange, true);
    assert.equal(out.info?.checksum.length, 8);
  });

  it("rejects a bad checksum", () => {
    const out = analyzeDescriptor(`wsh(pk(${XPUB}))#zzzzzzzz`);
    assert.equal(out.ok, false);
    assert.equal(out.error, "node.err.checksum");
  });

  it("flags leftover aliases as unsolvable", () => {
    const desc = descsumCreate("wsh(multi(2,A,B,C))");
    const out = analyzeDescriptor(desc);
    assert.equal(out.ok, true);
    assert.equal(out.info?.issolvable, false);
  });
});
