import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatElectrumVersion,
  indexerHostAllowed,
  isPublicIndexerHost,
  nativeIndexerHostAllowed,
  parseElectrumUrl,
} from "../electrum.ts";
import { mapElectrumUnspents } from "./native-electrum.ts";

describe("electrum hosts", () => {
  it("does not treat public explorers as LAN indexers", () => {
    assert.equal(isPublicIndexerHost("mempool.space"), true);
    assert.equal(isPublicIndexerHost("blockstream.info"), true);
    assert.equal(indexerHostAllowed("mempool.space"), false);
    assert.equal(indexerHostAllowed("8.8.8.8"), false);
    assert.equal(indexerHostAllowed("192.168.1.20"), true);
    assert.equal(indexerHostAllowed("fulcrum.local"), true);
  });

  it("allows LAN hostnames on the APK and rejects the phone loopback", () => {
    assert.equal(nativeIndexerHostAllowed("192.168.1.20"), true);
    assert.equal(nativeIndexerHostAllowed("fulcrum.local"), true);
    assert.equal(nativeIndexerHostAllowed("umbrel"), true);
    assert.equal(nativeIndexerHostAllowed("node.home"), true);
    assert.equal(nativeIndexerHostAllowed("127.0.0.1"), false);
    assert.equal(nativeIndexerHostAllowed("localhost"), false);
    assert.equal(nativeIndexerHostAllowed("8.8.8.8"), false);
    assert.equal(nativeIndexerHostAllowed("mempool.space"), false);
  });

  it("parses tcp and ssl electrum URLs", () => {
    assert.deepEqual(parseElectrumUrl("192.168.1.20:50001"), { host: "192.168.1.20", port: 50001, tls: false });
    assert.equal(parseElectrumUrl("ssl://capable-dosage.local:64718")?.tls, true);
    assert.equal(parseElectrumUrl("ssl://capable-dosage.local:64718")?.port, 64718);
    assert.equal(parseElectrumUrl("ssl://capable-dosage.local:64718")?.host, "capable-dosage.local");
    assert.equal(parseElectrumUrl("tcp://192.168.1.20:50001")?.tls, false);
    assert.equal(formatElectrumVersion(["Fulcrum 1.11.1", "1.4"]), "Fulcrum 1.11.1 1.4");
  });
});

describe("electrum utxo mapping", () => {
  it("maps listunspent rows to BTC amounts", () => {
    const out = mapElectrumUnspents(
      [{ address: "bc1qtest", scripthash: "ab" }],
      [{ height: 900000 }, [{ tx_hash: "aa".repeat(32), tx_pos: 1, value: 150000, height: 890000 }]],
    );
    assert.equal(out.height, 900000);
    assert.equal(out.unspents.length, 1);
    assert.equal(out.unspents[0]?.amount, 0.0015);
    assert.equal(out.unspents[0]?.vout, 1);
    assert.equal(out.total, 0.0015);
  });
});
