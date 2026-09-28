import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { btcToSats, buildPsbt, estimateVbytes, extractSignedTx, feeFromRate, inspectSignatures, planPayments, planSpend, satsToDecimal, sequenceAndLocktime, withPartialSigs, addedSignaturePubkeys } from "./psbt.ts";
import { signatureReport } from "./sigs.ts";
import { createQrVideo } from "./qr-video.ts";
import { emptyKey } from "../miniscript/keys.ts";
import { deflateSync } from "node:zlib";
import { UR, UREncoder } from "@ngraveio/bc-ur";

const ADDR = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const TXID = "11".repeat(32);

describe("unsigned psbt", () => {
  it("converts btc to sats without float drift", () => {
    assert.equal(btcToSats(0.1), 10_000_000);
    assert.equal(btcToSats(1.00000001), 100_000_001);
  });

  it("builds a psbt that starts with the psbt magic", () => {
    const plan = planSpend({
      coins: [{ txid: TXID, vout: 0, amountBtc: 0.01, address: ADDR }],
      payTo: ADDR,
      paySats: 900_000,
      feeSats: 10_000,
      changeAddress: ADDR,
      rbf: true,
    });
    assert.equal(plan.outputs.length, 2);
    assert.equal(plan.outputs[0]!.sats, 900_000);
    assert.equal(plan.feeSats, 10_000);
    const psbt = buildPsbt(plan);
    assert.ok(psbt.startsWith("cHNidP8"));
    assert.ok(psbt.length > 40);
  });

  it("send-all needs no change address", () => {
    const plan = planSpend({
      coins: [{ txid: TXID, vout: 1, amountBtc: 0.002, address: ADDR }],
      payTo: ADDR,
      paySats: 0,
      feeSats: 2_000,
      sendAll: true,
    });
    assert.equal(plan.outputs.length, 1);
    assert.equal(plan.outputs[0]!.sats, 200_000 - 2_000);
  });

  it("rejects a missing change address when coins are left over", () => {
    assert.throws(
      () =>
        planSpend({
          coins: [{ txid: TXID, vout: 0, amountBtc: 0.01, address: ADDR }],
          payTo: ADDR,
          paySats: 100_000,
          feeSats: 1_000,
        }),
      /tx\.err\.change/,
    );
  });

  it("builds when change is dust and flags it", () => {
    const plan = planPayments({
      coins: [{ txid: TXID, vout: 0, amountBtc: 0.001, address: ADDR }],
      payments: [{ address: ADDR, sats: 99_500 }],
      feeSats: 200,
    });
    assert.equal(plan.dustChange, true);
    assert.equal(plan.outputs.length, 1);
    assert.equal(plan.feeSats, 500);
    assert.equal(buildPsbt(plan).startsWith("cHNidP"), true);
  });

  it("prices a fee from sat/vB", () => {
    const vb = estimateVbytes({ inputs: 1, outputs: [ADDR, ADDR], sigs: 2, keys: 3 });
    assert.ok(vb > 100 && vb < 400);
    assert.equal(feeFromRate(2, vb), vb * 2);
    assert.equal(feeFromRate(0, vb), 0);
    assert.equal(satsToDecimal(100_000_001), "1.00000001");
    const report = inspectSignatures(buildPsbt(planSpend({
      coins: [{ txid: TXID, vout: 0, amountBtc: 0.002, address: ADDR }],
      payTo: ADDR,
      paySats: 0,
      feeSats: 2_000,
      sendAll: true,
    })));
    assert.equal(report.inputs.length, 1);
    assert.equal(report.inputs[0]!.pubkeys.length, 0);
    assert.equal(report.inputs[0]!.finalized, false);
  });

  it("keeps a raw signed hex and refuses an unsigned psbt", () => {
    const hex = "0200000001" + "ab".repeat(16);
    assert.equal(extractSignedTx(`  ${hex}  `), hex);
    const plan = planSpend({
      coins: [{ txid: TXID, vout: 0, amountBtc: 0.002, address: ADDR }],
      payTo: ADDR,
      paySats: 0,
      feeSats: 2_000,
      sendAll: true,
    });
    assert.throws(() => extractSignedTx(buildPsbt(plan)), /tx\.err\.unsigned/);
  });

  it("writes older() into nSequence and the tip into nLockTime", () => {
    assert.deepEqual(sequenceAndLocktime({ older: 65534, tip: 968879 }), {
      sequence: 65534,
      locktime: 968879,
    });
    assert.deepEqual(sequenceAndLocktime({ after: 800000, tip: 968879 }), {
      sequence: 0xfffffffd,
      locktime: 968879,
    });
    assert.deepEqual(sequenceAndLocktime({ after: 1_200_000, tip: 968879 }), {
      sequence: 0xfffffffd,
      locktime: 1_200_000,
    });
    const plan = planPayments({
      coins: [{ txid: TXID, vout: 0, amountBtc: 0.002, address: ADDR }],
      payments: [{ address: ADDR, sats: 100_000 }],
      feeSats: 2_000,
      changeAddress: ADDR,
      older: 65534,
      tip: 968879,
    });
    assert.equal(plan.sequence, 65534);
    assert.equal(plan.locktime, 968879);
    const raw = Buffer.from(buildPsbt(plan), "base64");
    const txLen = raw[7]!;
    const tx = raw.subarray(8, 8 + txLen);
    assert.equal(tx.subarray(42, 46).readUInt32LE(0), 65534);
    assert.equal(tx.subarray(tx.length - 4).readUInt32LE(0), 968879);
  });

  it("puts the witness script and the derivation into the psbt", () => {
    const plan = planPayments({
      coins: [{ txid: TXID, vout: 0, amountBtc: 0.002, address: ADDR }],
      payments: [{ address: ADDR, sats: 100_000 }],
      feeSats: 2_000,
      changeAddress: ADDR,
    });
    const pub = "02" + "11".repeat(32);
    const script = "51";
    const psbt = buildPsbt(plan, {
      inputs: [{ address: ADDR, witnessScript: script, derivations: [{ pubkey: pub, fingerprint: "aabbccdd", path: "m/48'/0'/0'/2'/1/0" }] }],
      outputs: [null, { address: ADDR, witnessScript: "", derivations: [{ pubkey: pub, fingerprint: "aabbccdd", path: "m/48'/0'/0'/2'/1/0" }] }],
    });
    const raw = Buffer.from(psbt, "base64");
    assert.ok(raw.includes(Buffer.from("aabbccdd", "hex")));
    assert.ok(raw.includes(Buffer.from(pub, "hex")));
    const hardened = Buffer.alloc(4);
    hardened.writeUInt32LE(0x80000000 + 48);
    assert.ok(raw.includes(hardened));
  });

  it("round-trips through the Ledger signer and keeps partial sigs sorted", async () => {
    const plan = planPayments({
      coins: [{ txid: TXID, vout: 0, amountBtc: 0.002, address: ADDR }],
      payments: [{ address: ADDR, sats: 100_000 }],
      feeSats: 2_000,
      changeAddress: ADDR,
      older: 65534,
      tip: 968879,
    });
    const pubA = "02" + "22".repeat(32);
    const pubB = "02" + "11".repeat(32);
    const script = "51";
    const psbt = buildPsbt(plan, {
      inputs: [{
        address: ADDR,
        witnessScript: script,
        derivations: [
          { pubkey: pubB, fingerprint: "bbbbbbbb", path: "m/48'/0'/0'/2'/0/0" },
          { pubkey: pubA, fingerprint: "aaaaaaaa", path: "m/48'/0'/0'/2'/0/0" },
        ],
      }],
      outputs: [null, {
        address: ADDR,
        witnessScript: "",
        derivations: [{ pubkey: pubA, fingerprint: "aaaaaaaa", path: "m/48'/0'/0'/2'/1/0" }],
      }],
    });
    const { PsbtV2 } = await import("ledger-bitcoin");
    const parsed = new PsbtV2();
    parsed.deserialize(Buffer.from(psbt, "base64"));
    assert.equal(parsed.getGlobalTxVersion(), 2);
    assert.equal(parsed.getGlobalFallbackLocktime(), 968879);
    assert.equal(parsed.getInputSequence(0), 65534);
    assert.equal(parsed.getInputWitnessScript(0)?.toString("hex"), script);
    assert.deepEqual(
      [...(parsed.getInputBip32Derivation(0, Buffer.from(pubA, "hex"))?.path ?? [])],
      [0x80000030, 0x80000000, 0x80000000, 0x80000002, 0, 0],
    );
    assert.deepEqual(
      [...(parsed.getOutputBip32Derivation(1, Buffer.from(pubA, "hex"))?.path ?? [])],
      [0x80000030, 0x80000000, 0x80000000, 0x80000002, 1, 0],
    );

    const signed = withPartialSigs(psbt, [
      { input: 0, pubkey: Buffer.from(pubB, "hex"), signature: Buffer.from("aa", "hex") },
      { input: 0, pubkey: Buffer.from(pubA, "hex"), signature: Buffer.from("bb", "hex") },
    ]);
    const again = new PsbtV2();
    again.deserialize(Buffer.from(signed, "base64"));
    assert.equal(again.getInputPartialSig(0, Buffer.from(pubA, "hex"))?.toString("hex"), "bb");
    assert.equal(again.getInputPartialSig(0, Buffer.from(pubB, "hex"))?.toString("hex"), "aa");
    const report = inspectSignatures(signed);
    assert.deepEqual(report.inputs[0]!.pubkeys, [pubB, pubA]);
    assert.equal(report.inputs[0]!.derivations.find((d) => d.pubkey === pubA)?.fingerprint, "aaaaaaaa");
    assert.equal(report.inputs[0]!.derivations.find((d) => d.pubkey === pubA)?.path, "m/48'/0'/0'/2'/0/0");
    assert.deepEqual(addedSignaturePubkeys(psbt, signed), [pubB, pubA]);
    assert.deepEqual(addedSignaturePubkeys(signed, signed), []);
    const keys = [
      { ...emptyKey("A"), fingerprint: "aaaaaaaa", note: "Ledger" },
      { ...emptyKey("B"), fingerprint: "bbbbbbbb", note: "BitBox" },
      { ...emptyKey("C"), fingerprint: "cccccccc", note: "Coldcard" },
    ];
    const onlyA = withPartialSigs(psbt, [{ input: 0, pubkey: Buffer.from(pubA, "hex"), signature: Buffer.from("bb", "hex") }]);
    const status = signatureReport(onlyA, {
      keys,
      stages: [{ id: "s", delay: 0, k: 2, keys: ["A", "B", "C"] }],
      reuse: false,
      pathIndex: 0,
    });
    assert.deepEqual(status.inputs[0]!.present.map((p) => p.label), ["Ledger"]);
    assert.equal(status.inputs[0]!.haveOnPath, 1);
    assert.equal(status.inputs[0]!.need, 2);
    assert.equal(status.inputs[0]!.pathReady, false);
    assert.deepEqual(status.inputs[0]!.missing, ["BitBox", "Coldcard"]);
  });
});

describe("qr video", () => {
  it("joins a Specter QR video and a BBQr into one PSBT", async () => {
    const specter = createQrVideo();
    assert.equal((await specter.push("p2of2 dP8=")).payload, undefined);
    const joined = await specter.push("p1of2 cHNi");
    assert.equal(joined.payload, "cHNidP8=");
    assert.equal(joined.got, 2);
    assert.equal(joined.total, 2);

    const bb = createQrVideo();
    await bb.push("B$H$P$2/2$74ff");
    const done = await bb.push("B$H$P$1/2$707362");
    assert.equal(done.payload, "cHNidP8=");
  });

  it("inflates a zlib BBQr and reassembles a UR video", async () => {
    const raw = Buffer.from("psbt\xffhi");
    const z = deflateSync(raw);
    let bits = "";
    for (const byte of z) bits += byte.toString(2).padStart(8, "0");
    while (bits.length % 5) bits += "0";
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let b32 = "";
    for (let i = 0; i < bits.length; i += 5) b32 += alphabet[Number.parseInt(bits.slice(i, i + 5), 2)];
    const video = createQrVideo();
    const inflated = await video.push(`B$Z$P$1/1$${b32}`);
    assert.equal(Buffer.from(inflated.payload ?? "", "base64").toString("utf8"), "psbt\xffhi");

    const ur = UR.fromBuffer(raw);
    const enc = new UREncoder(ur, 20);
    const frames: string[] = [];
    const collector = createQrVideo();
    let result = "";
    for (let i = 0; i < 40 && !result; i++) {
      frames.push(enc.nextPart());
      const step = await collector.push(frames[frames.length - 1]!);
      result = step.payload ?? "";
    }
    assert.equal(Buffer.from(result, "base64").toString("utf8"), "psbt\xffhi");
  });
});
