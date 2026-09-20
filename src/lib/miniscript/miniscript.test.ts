import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checksumOf, coreCanonicalBody, descsumCheck, descsumCreate, rewriteDescriptorChildPath, stripChecksum } from "./checksum.ts";
import { descriptorChecksums, highlightScript, peekScript } from "./highlight.ts";
import {
  compileDescriptor,
  compileMiniscript,
  descriptorOrderVariants,
  expandAliasKeys,
} from "./compile.ts";
import { explainPolicy } from "./explain.ts";
import { decodeLibrary, encodeLibrary, peekChecksum, policyIsDirty, policySig, type SavedPolicy } from "../policy-library.ts";
import { electrumHostAllowed, parseElectrumUrl, scriptPubKeyFromAddress, scripthashForAddress } from "../electrum.ts";
import {
  applyKeyMaterial,
  attachChildOrReplace,
  applyKeyNames,
  buildKeyTree,
  collapseAliasKeys,
  groupKeysByFingerprint,
  emptyKey,
  extractKeysFromTree,
  flattenKeysForLookup,
  formatBip32Path,
  formatExportWithKeys,
  formatKeyList,
  peelKeysFromText,
  displayKeyToken,
  keyHeadline,
  keyNeedsAction,
  keyRoleLabel,
  reuseBranchPath,
  childRoleLabel,
  keyTileLabel,
  sanitizeKeyNote,
  shortXpub,
  tokenNeedsAction,
  nextUnusedAccount,
  normalizeKeyEntry,
  orderMasterNames,
  parseChildKey,
  parseKeyExpr,
  parseKeyList,
  relabelKeysFromA,
  sequentialKeyNames,
  sortKeyEntries,
} from "./keys.ts";
import { visit } from "./ast.ts";
import { parseAny } from "./parser.ts";
import { compileStages, delayPresets, describeStageSlots, inferNesting, inferStages, liftIncompleteReason, nextStageDelay, permutations, slotsForAccount, sortedMultiAllowed, stageFormula, stageHighlightIds, stageIndicesForAccount, stageKeyOrderVariants } from "./stages.ts";
import { confirmationsAt, coinHeightFromConfirms, evaluateSpendPaths, oldestCoinHeight, youngestCoinHeight } from "./spend-check.ts";
import { evaluateCoinStatus } from "./coin-status.ts";
import {
  compileBip388,
  formatBitboxJson,
  formatLedgerJson,
  formatPolicyText,
  formatScriptwerkJson,
  materializeWalletPolicy,
  parseScriptwerkBundle,
  parseWalletPolicy,
  toLedgerPolicy,
  walletPolicyToDescriptor,
} from "./bip388.ts";
import {
  assertImportableText,
  classifyImportedPolicy,
  compiledForStudio,
  descriptorsEquivalent,
} from "./policy-mode.ts";
import { defaultAccountPath, formatOrigin, normalizeHwPath, pathToDerivation } from "../hw/types.ts";
import {
  allRequestedMatch,
  alignLedgerOrigin,
  bitboxAddressPath,
  chainMatches,
  clampIndexRange,
  clampUtxoCount,
  descriptorForBranch,
  formatBtc,
  formatAmount,
  formatBtcDisplay,
  resolveAmountUnit,
  toSats,
  isHmacHex,
  mergeUtxoResults,
  mergeWatchSnapshots,
  buildWatchSnapshot,
  parseScantxoutset,
  policyCacheKey,
  utxoScanObjects,
  watchOnlyKeys,
} from "../hw/address-check.ts";
import { validatePolicy } from "./validate.ts";
import { openDemoSession } from "../hw/demo.ts";

const XPUB =
  "xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5hqK5Gb4u1Q2ZbQW2kfykAPzh9RQQJwYvNUbaMhEaKfLUWuBvYJMTx5N";

describe("parser", () => {
  it("parses nested miniscript and wrappers", () => {
    const { node } = parseAny("and_v(v:pk(A),or_d(pk(B),pk(C)))");
    assert.equal(node.kind, "and_v");
    if (node.kind !== "and_v") return;
    assert.equal(node.left.kind, "wrap");
    assert.equal(compileMiniscript(node), "and_v(v:pk(A),or_d(pk(B),pk(C)))");
  });

  it("strips wsh and checksum", () => {
    const inner = "multi(2,A,B,C)";
    const desc = descsumCreate(`wsh(${inner})`);
    const parsed = parseAny(desc);
    assert.equal(parsed.wrapper, "wsh");
    assert.equal(compileMiniscript(parsed.node), inner);
    assert.equal(descsumCheck(desc), true);
  });

  it("reads BSMS with newlines", () => {
    const desc = descsumCreate("wsh(pk(A))");
    const bsms = `BSMS 1.0\n${desc}\n/0/*,/1/*`;
    const parsed = parseAny(bsms);
    assert.equal(parsed.node.kind, "pk");
  });
});

describe("checksum", () => {
  it("matches BIP-380 and Bitcoin Core vectors", () => {
    assert.equal(descsumCreate("raw(deadbeef)").slice(-8), "89f8spxm");
    assert.equal(descsumCheck("raw(deadbeef)#89f8spxm"), true);
    assert.equal(
      descsumCreate("pkh(0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798)").slice(-8),
      "e48zzw02",
    );
  });

  it("gives Core a different checksum for the receive-only path", () => {
    const body = "wsh(pk([deadbeef/48'/0'/0'/2']xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5hqK5Gb4u1Q2ZbQW2kfykAPzh9RQQJwYvNUbaMhEaKfLUWuBvYJMTx5N/<0;1>/*))";
    const recv = coreCanonicalBody(body);
    assert.equal(recv.includes("/<0;1>/"), false);
    assert.equal(recv.includes("/0/"), true);
    assert.notEqual(checksumOf(body), checksumOf(recv));
    assert.equal(stripChecksum(descsumCreate(body)), body);
  });

  it("counts reuse branches and keeps offsets when switching 0/*", () => {
    assert.equal(reuseBranchPath("<0;1>/*", 1), "<0;1>/*");
    assert.equal(reuseBranchPath("<0;1>/*", 2), "<2;3>/*");
    assert.equal(reuseBranchPath("<0;1>/*", 3), "<4;5>/*");
    assert.equal(reuseBranchPath("0/*", 2), "2/*");
    const d = descsumCreate("wsh(or_i(pk(xpubA/<2;3>/*),pk(xpubA/<0;1>/*)))");
    const recv = rewriteDescriptorChildPath(d, "0/*");
    assert.match(recv, /\/2\/\*/);
    assert.match(recv, /\/0\/\*/);
    assert.equal(recv.includes("/<"), false);
    const back = rewriteDescriptorChildPath(recv, "<0;1>/*");
    assert.match(back, /\/<2;3>\/\*/);
    assert.match(back, /\/<0;1>\/\*/);
  });
});

describe("highlight", () => {
  it("colors matching parens and distinct keys", () => {
    const keys = [emptyKey("A"), emptyKey("B")];
    const spans = highlightScript("wsh(multi(2,A,B))", keys);
    const a = spans.find((s) => s.text === "A");
    const b = spans.find((s) => s.text === "B");
    assert.ok(a && b);
    assert.notEqual(a.color, b.color);
    const opens = spans.filter((s) => s.kind === "paren" && s.text === "(");
    const closes = spans.filter((s) => s.kind === "paren" && s.text === ")");
    assert.equal(opens.length, closes.length);
    assert.equal(opens[0]?.color, closes[closes.length - 1]?.color);
  });

  it("peeks long scripts and lists both checksums", () => {
    const long = "wsh(or_i(and_v(v:multi(2,A,B),older(144)),pk(C)))#qqqqqqqq";
    assert.match(peekScript(long, 20), /…#qqqqqqqq$/);
    const body =
      "wsh(pk([deadbeef/48'/0'/0'/2']xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5hqK5Gb4u1Q2ZbQW2kfykAPzh9RQQJwYvNUbaMhEaKfLUWuBvYJMTx5N/<0;1>/*))";
    const list = descriptorChecksums(descsumCreate(body));
    assert.equal(list.length, 2);
    assert.notEqual(list[0]?.checksum, list[1]?.checksum);
  });
});

describe("keys", () => {
  it("parses origin key expressions", () => {
    const p = parseKeyExpr(`[deadbeef/48h/0h/0h/2h]${XPUB}/<0;1>/*`);
    assert.equal(p.kind, "origin");
    assert.equal(p.fingerprint, "deadbeef");
    assert.equal(p.derivation, "48'/0'/0'/2'");
    assert.equal(p.xpub, XPUB);
    assert.equal(p.multipath, "<0;1>");
  });

  it("extracts origin keys into aliases", () => {
    const parsed = parseAny(`wsh(and_v(v:pk([deadbeef/48h/0h/0h/2h]${XPUB}/<0;1>/*),pk(B)))`);
    const { node, keys } = extractKeysFromTree(parsed.node, []);
    assert.equal(compileMiniscript(node), "and_v(v:pk(A),pk(B))");
    assert.equal(keys[0]?.name, "A");
    assert.equal(keys[0]?.xpub, XPUB);
    assert.equal(keys[1]?.name, "B");
  });

  it("parses a pubkey list", () => {
    const list = parseKeyList(`A ${XPUB}\nB [aabbccdd/48h/0h/0h/2h]${XPUB}/*`);
    assert.ok(list);
    assert.equal(list![0]?.name, "A");
    assert.equal(list![0]?.xpub, XPUB);
    assert.equal(list![1]?.name, "B");
    assert.equal(list![1]?.fingerprint, "aabbccdd");
  });

  it("roundtrips key display names in a list", () => {
    const line = formatKeyList([
      { ...emptyKey("A"), note: "Alice", fingerprint: "deadbeef", derivation: "48'/0'/0'/2'", xpub: XPUB },
    ]);
    assert.match(line, /Alice/);
    const list = parseKeyList(line);
    assert.equal(list?.[0]?.name, "A");
    assert.equal(list?.[0]?.note, "Alice");
    const quoted = parseKeyList(`B "Coldcard" [aabbccdd/48'/0'/0'/2']${XPUB}/<0;1>/*`);
    assert.equal(quoted?.[0]?.name, "B");
    assert.equal(quoted?.[0]?.note, "Coldcard");
  });

  it("roundtrips names through descriptor file comments", () => {
    const keys = [
      { ...emptyKey("A"), note: "NANO-S", fingerprint: "deadbeef", derivation: "48'/0'/0'/2'", xpub: XPUB },
    ];
    const file = formatExportWithKeys(`wsh(pk(${XPUB}))`, keys);
    assert.match(file, /NANO-S/);
    const peeled = peelKeysFromText(file);
    assert.equal(peeled.keys[0]?.note, "NANO-S");
    const parsed = parseAny(file);
    const extracted = extractKeysFromTree(parsed.node, peeled.keys);
    const named = applyKeyNames(extracted.keys, peeled.keys);
    assert.equal(named.find((k) => k.xpub === XPUB)?.note, "NANO-S");
  });

  it("keeps the master display name when a child xpub is listed first", () => {
    const childXpub =
      "xpub68Gmy5EdvgibQVfPdqkBBCHxA5htiqg55crXYuXoQRKfDBFA1WEjWgP6LHhwBZeNK1VTsfTFUHCdrfp1bgwQ9xv5ski8PX9rL2dZXvgGDnw";
    const folded = collapseAliasKeys(
      [
        {
          ...emptyKey("A1"),
          fingerprint: "deadbeef",
          derivation: "48'/0'/1'/2'",
          xpub: childXpub,
        },
        {
          ...emptyKey("A"),
          note: "Alice",
          fingerprint: "deadbeef",
          derivation: "48'/0'/0'/2'",
          xpub: XPUB,
        },
      ],
      ["A", "A1"],
    );
    const master = folded.find((k) => k.name === "A");
    assert.equal(master?.note, "Alice");
    assert.equal(master?.xpub, XPUB);
    assert.equal(master?.children[0]?.xpub, childXpub);
  });

  it("reads a display name from a single-key json file", () => {
    const result = applyKeyMaterial(
      emptyKey("A"),
      JSON.stringify({ name: "NANO-S", fingerprint: "aabbccdd", derivation: "48'/0'/0'/2'", xpub: XPUB }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.key.note, "NANO-S");
    assert.equal(result.key.xpub, XPUB);
    assert.equal(result.key.name, "A");
  });

  it("applies origin material onto an existing alias", () => {
    const slot = emptyKey("B");
    const result = applyKeyMaterial(slot, `[aabbccdd/48h/0h/0h/2h]${XPUB}/<0;1>/*`);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.key.name, "B");
    assert.equal(result.key.fingerprint, "aabbccdd");
    assert.equal(result.key.derivation, "48'/0'/0'/2'");
    assert.equal(result.key.xpub, XPUB);
    assert.equal(formatBip32Path(result.key), "m/48'/0'/0'/2'");
    assert.equal(keyHeadline({ ...result.key, note: "Coldcard" }), "Coldcard");
    assert.equal(keyHeadline(result.key), "aabbccdd");
  });

  it("reads coldcard-style json onto a slot", () => {
    const result = applyKeyMaterial(
      emptyKey("A"),
      JSON.stringify({ xfp: "E60EDD9C", p2wsh: XPUB, p2wsh_deriv: "m/48'/0'/0'/2'" }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.key.fingerprint.toLowerCase(), "e60edd9c");
    assert.equal(result.key.xpub, XPUB);
    assert.equal(result.key.derivation, "48'/0'/0'/2'");
  });

  it("rejects a full policy on a single key slot", () => {
    const result = applyKeyMaterial(emptyKey("A"), "wsh(multi(2,A,B,C))");
    assert.equal(result.ok, false);
  });

  it("parses a child path after the xpub", () => {
    const p = parseKeyExpr(`[deadbeef/48h/0h/0h/2h]${XPUB}/0/5`);
    assert.equal(p.xpub, XPUB);
    assert.equal(p.childPath, "0/5");
    assert.equal(p.derivation, "48'/0'/0'/2'");
  });

  it("attaches a path-only child onto a filled parent", () => {
    const parent = {
      ...emptyKey("A"),
      xpub: XPUB,
      fingerprint: "deadbeef",
      derivation: "48'/0'/0'/2'",
    };
    const child = parseChildKey(parent, "0/0");
    assert.equal(child.ok, true);
    if (!child.ok) return;
    assert.equal(child.child.path, "0/0");
    const tree = buildKeyTree({ ...parent, children: [child.child] });
    assert.equal(tree.label, "m/48'/0'/0'/2'");
    assert.ok(tree.children.some((c) => c.label === "0/0"));
  });

  it("attaches a sibling account of the same fingerprint as child", () => {
    const parent = {
      ...emptyKey("A"),
      xpub: XPUB,
      fingerprint: "deadbeef",
      derivation: "48'/0'/0'/2'",
    };
    const a = parseChildKey(parent, "[deadbeef]m/48'/0'/1'/2'");
    assert.equal(a.ok, true);
    if (!a.ok) return;
    assert.equal(a.child.path, "48'/0'/1'/2'");
    assert.equal(a.child.fingerprint, "deadbeef");
    const b = parseChildKey(parent, "[deadbeef/48'/0'/1'/2']");
    assert.equal(b.ok, true);
    if (!b.ok) return;
    assert.equal(b.child.path, "48'/0'/1'/2'");
    const tree = buildKeyTree({ ...parent, children: [a.child] });
    assert.equal(tree.label, "m");
    assert.ok(tree.children.some((c) => c.label === "48'/0'/1'/2'"));
  });

  it("picks the next unused BIP48 account", () => {
    const parent = {
      ...emptyKey("A"),
      xpub: XPUB,
      fingerprint: "deadbeef",
      derivation: "48'/0'/0'/2'",
    };
    assert.equal(nextUnusedAccount(parent).path, "48'/0'/1'/2'");
    const withChild = parseChildKey(parent, "[deadbeef]m/48'/0'/1'/2'");
    assert.equal(withChild.ok, true);
    if (!withChild.ok) return;
    assert.equal(nextUnusedAccount({ ...parent, children: [withChild.child] }).path, "48'/0'/2'/2'");
  });

  it("accepts a bare xpub as child on the next account", () => {
    const parent = {
      ...emptyKey("A"),
      xpub: XPUB,
      fingerprint: "deadbeef",
      derivation: "48'/0'/0'/2'",
    };
    const child = parseChildKey(
      parent,
      "xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8",
      {
        fallbackPath: "48'/0'/1'/2'",
        alias: "A1",
      },
    );
    assert.equal(child.ok, true);
    if (!child.ok) return;
    assert.equal(child.child.path, "48'/0'/1'/2'");
    assert.equal(child.child.note, "");
    assert.equal(childRoleLabel("A", child.child.path), "A1 Child");
  });

  it("attaches a deeper origin as child instead of replacing", () => {
    const parent = {
      ...emptyKey("A"),
      xpub: XPUB,
      fingerprint: "deadbeef",
      derivation: "48'/0'/0'/2'",
    };
    const result = attachChildOrReplace(parent, `[deadbeef/48h/0h/0h/2h/0]${XPUB}`);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.key.xpub, XPUB);
    assert.equal(result.key.children[0]?.path, "0");
  });

  it("does not treat alias letters as device names", () => {
    assert.equal(sanitizeKeyNote("A"), "");
    assert.equal(sanitizeKeyNote("A1"), "");
    assert.equal(sanitizeKeyNote("NANO-S"), "NANO-S");
    const childXpub =
      "xpub68Gmy5EdvgibQVfPdqkBBCHxA5htiqg55crXYuXoQRKfDBFA1WEjWgP6LHhwBZeNK1VTsfTFUHCdrfp1bgwQ9xv5ski8PX9rL2dZXvgGDnw";
    const grouped = groupKeysByFingerprint([
      { ...emptyKey("B"), fingerprint: "deadbeef", derivation: "48'/0'/0'/2'", xpub: XPUB },
      { ...emptyKey("A"), fingerprint: "DEADBEEF", derivation: "48'/0'/1'/2'", xpub: childXpub },
    ]);
    const master = grouped.keys.find((k) => k.fingerprint === "deadbeef") ?? grouped.keys[0];
    assert.equal(master?.children[0]?.note, "");
    assert.equal(sanitizeKeyNote("Ledger"), "Ledger");
    assert.equal(normalizeKeyEntry({ ...emptyKey("B"), note: "Ledger" }).note, "Ledger");
  });

  it("keeps name, fingerprint and role as separate labels", () => {
    const a = emptyKey("A");
    assert.equal(keyRoleLabel("A"), "A Master");
    assert.equal(keyRoleLabel("A1"), "A1 Child");
    assert.equal(childRoleLabel("A", "48'/0'/1'/2'"), "A1 Child");
    assert.equal(keyTileLabel(a), "—, —, A Master");
    assert.equal(keyTileLabel({ ...a, fingerprint: "DEADBEEF" }), "—, deadbeef, A Master");
    assert.equal(
      keyTileLabel({ ...a, fingerprint: "deadbeef", note: "NANO-S" }),
      "NANO-S, deadbeef, A Master",
    );
    assert.equal(shortXpub(XPUB), `${XPUB.slice(0, 12)}…${XPUB.slice(-8)}`);
  });

  it("uses the device name instead of A/A1 when a note is set", () => {
    const nano = { ...emptyKey("A"), note: "NANO-S", fingerprint: "deadbeef", xpub: XPUB };
    const cold = { ...emptyKey("B"), note: "COLDCARD", fingerprint: "cafebabe", xpub: XPUB };
    assert.equal(displayKeyToken("A", [nano, cold]), "NANO-S (A)");
    assert.equal(displayKeyToken("B", [nano, cold]), "COLDCARD (B)");
    assert.equal(displayKeyToken("A1", [nano, cold]), "NANO-S (A1)");
    assert.equal(displayKeyToken("C", [nano, cold]), "C");
    const withChild = {
      ...nano,
      children: [{ id: "c1", path: "48'/0'/1'/2'", xpub: XPUB, fingerprint: "deadbeef", note: "NANO-S-2" }],
    };
    assert.equal(displayKeyToken("A1", [withChild]), "NANO-S-2 (A1)");
    const root = compileStages([{ id: "s1", delay: 0, k: 2, keys: ["A", "B"] }]).root;
    const exp = explainPolicy(root, "de", [nano, cold]);
    assert.match(exp.groups[0]?.paths[0]?.label ?? "", /NANO-S \(A\)/);
    assert.match(exp.groups[0]?.paths[0]?.label ?? "", /COLDCARD \(B\)/);
  });

  it("flags empty keys and missing child accounts", () => {
    const empty = emptyKey("A");
    assert.equal(keyNeedsAction(empty, [], false), "empty");
    const filled = {
      ...empty,
      xpub: XPUB,
      fingerprint: "deadbeef",
      derivation: "48'/0'/0'/2'",
    };
    assert.equal(keyNeedsAction(filled, [{ account: 1 }], false), "child");
    assert.equal(tokenNeedsAction("A", [filled], false), false);
    assert.equal(tokenNeedsAction("A1", [filled], false), true);
    assert.equal(tokenNeedsAction("A", [empty], true), true);
  });

  it("orders masters by stage then A–Z and relabels from A", () => {
    assert.deepEqual(sequentialKeyNames(3), ["A", "B", "C"]);
    const stages = [
      { keys: ["H", "F", "G"] },
      { keys: ["C", "A"] },
    ];
    assert.deepEqual(orderMasterNames(stages), ["F", "G", "H", "A", "C"]);
    const keys = ["H", "F", "G", "C", "A"].map((n) => emptyKey(n));
    const { node } = parseAny("or_i(and_v(v:pk(A),pk(C)),multi(2,F,G,H))");
    const labeled = relabelKeysFromA(keys, stages, node);
    assert.deepEqual(labeled.keys.map((k) => k.name), ["A", "B", "C", "D", "E"]);
    assert.deepEqual(labeled.stages[0]?.keys, ["A", "B", "C"]);
    assert.deepEqual(labeled.stages[1]?.keys, ["D", "E"]);
    assert.equal(compileMiniscript(labeled.root!), "or_i(and_v(v:pk(D),pk(E)),multi(2,A,B,C))");
    assert.deepEqual(
      sortKeyEntries(keys, stages).map((k) => k.name),
      ["F", "G", "H", "A", "C"],
    );
  });
});

describe("stages", () => {
  it("caps relative lock presets at 65534 by default", () => {
    assert.deepEqual(delayPresets(65534).slice(-1), [65534]);
    assert.deepEqual(delayPresets(65535).slice(-1), [65535]);
    assert.equal(nextStageDelay([{ id: "s", delay: 60000, k: 1, keys: ["A"] }], 65534), 65534);
    assert.equal(nextStageDelay([{ id: "s", delay: 60000, k: 1, keys: ["A"] }], 65535), 65535);
  });

  it("compiles 2-of-3 without timelock", () => {
    const { root } = compileStages([{ id: "s1", delay: 0, k: 2, keys: ["A", "B", "C"] }]);
    assert.equal(compileMiniscript(root), "multi(2,A,B,C)");
  });

  it("compiles pkh as thresh with a: wrappers", () => {
    const { root } = compileStages([{ id: "s1", delay: 0, k: 2, keys: ["A", "B", "C"], hash: true }]);
    assert.equal(compileMiniscript(root), "thresh(2,pkh(A),a:pkh(B),a:pkh(C))");
    const recovered = inferStages(root);
    assert.equal(recovered[0]?.hash, true);
    assert.deepEqual(recovered[0]?.keys, ["A", "B", "C"]);
    assert.equal(recovered[0]?.k, 2);
  });

  it("compiles a hashed key as pkh", () => {
    const { root } = compileStages([{ id: "s1", delay: 144, k: 1, keys: ["A"], hash: true }]);
    assert.equal(compileMiniscript(root), "and_v(v:pkh(A),older(144))");
  });

  it("compiles after() as an absolute lock", () => {
    const { root } = compileStages([{ id: "s1", delay: 800000, lock: "after", k: 1, keys: ["A"] }]);
    assert.equal(compileMiniscript(root), "and_v(v:pk(A),after(800000))");
    const recovered = inferStages(root);
    assert.equal(recovered[0]?.lock, "after");
    assert.equal(recovered[0]?.delay, 800000);
  });

  it("compiles 2-of-2 as and_v when requested", () => {
    const multi = compileStages([{ id: "s1", delay: 0, k: 2, keys: ["A", "B"] }]).root;
    assert.equal(compileMiniscript(multi), "multi(2,A,B)");
    const { root } = compileStages([{ id: "s1", delay: 0, k: 2, keys: ["A", "B"], andv: true }]);
    assert.equal(compileMiniscript(root), "and_v(v:pk(A),pk(B))");
    assert.equal(inferStages(root)[0]?.andv, true);
  });

  it("nests later timelocks outside, aliases reused keys", () => {
    const { root } = compileStages([
      { id: "s1", delay: 0, k: 2, keys: ["A", "B", "C"] },
      { id: "s2", delay: 60000, k: 2, keys: ["A", "D"] },
      { id: "s3", delay: 65534, k: 2, keys: ["B", "C", "D"] },
    ]);
    const ms = compileMiniscript(root);
    assert.equal(
      ms,
      "or_i(and_v(v:multi(2,B2,C2,D2),older(65534)),or_i(and_v(v:multi(2,A2,D1),older(60000)),multi(2,A1,B1,C1)))",
    );
    const exp = explainPolicy(root);
    assert.equal(exp.groups.length, 3);
    assert.equal(exp.groups[0]?.delay, 0);
    assert.ok(exp.groups.some((g) => g.delay === 60000));
    assert.ok(exp.groups.some((g) => g.delay === 65534));
    const en = explainPolicy(root, "en");
    assert.match(en.title, /time-locked|now|later|immediate/i);
    const recovered = inferStages(root);
    assert.equal(recovered.length, 3);
    assert.equal(recovered[0]?.delay, 0);
    assert.equal(recovered[0]?.k, 2);
    assert.deepEqual(recovered[0]?.keys, ["A", "B", "C"]);
    assert.equal(recovered[1]?.delay, 60000);
    assert.deepEqual(recovered[1]?.keys, ["A", "D"]);
    assert.equal(recovered[2]?.delay, 65534);
    assert.deepEqual(recovered[2]?.keys, ["B", "C", "D"]);
    assert.equal(inferNesting(root), "late");
    const early = compileStages(
      [
        { id: "s1", delay: 0, k: 2, keys: ["A", "B", "C"] },
        { id: "s2", delay: 60000, k: 2, keys: ["A", "D"] },
        { id: "s3", delay: 65534, k: 2, keys: ["B", "C", "D"] },
      ],
      true,
      "early",
    ).root;
    const earlyMs = compileMiniscript(early);
    assert.equal(
      earlyMs,
      "or_i(multi(2,A1,B1,C1),or_i(and_v(v:multi(2,A2,D1),older(60000)),and_v(v:multi(2,B2,C2,D2),older(65534))))",
    );
    assert.equal(inferNesting(early), "early");
    assert.notEqual(ms, earlyMs);
  });

  it("compiles a complete policy to a checksummed descriptor with alias xpubs", () => {
    const { root } = compileStages([
      { id: "s1", delay: 0, k: 2, keys: ["A", "B", "C"] },
      { id: "s2", delay: 144, k: 1, keys: ["A"] },
    ]);
    const compiled = compileDescriptor(root, [
      { ...emptyKey("A"), xpub: XPUB, fingerprint: "deadbeef" },
      emptyKey("B"),
      emptyKey("C"),
    ]);
    assert.equal(compiled.ok, true);
    assert.match(compiled.descriptor, /#[a-z0-9]{8}$/);
    assert.equal(descsumCheck(compiled.descriptor), true);
    assert.match(compiled.descriptor, /deadbeef/);
    assert.equal(compiled.descriptor.includes("A1") || compiled.descriptor.includes(XPUB), true);
    assert.match(compiled.descriptor, /\/<0;1>\/\*/);
    assert.match(compiled.descriptor, /\/<2;3>\/\*/);
  });

  it("strips an existing range tail before counting reuse branches", () => {
    const { root } = compileStages([
      { id: "s1", delay: 0, k: 1, keys: ["A"] },
      { id: "s2", delay: 144, k: 1, keys: ["A"] },
    ]);
    const compiled = compileDescriptor(root, [
      { ...emptyKey("A"), xpub: `${XPUB}/<0;1>/*`, fingerprint: "deadbeef" },
    ]);
    assert.equal(compiled.ok, true);
    assert.match(compiled.descriptor, /\/<0;1>\/\*/);
    assert.match(compiled.descriptor, /\/<2;3>\/\*/);
    assert.equal((compiled.descriptor.match(/\/<0;1>\/\*/g) ?? []).length, 1);
  });

  it("counts reuse tails from 0 even if the stored childPath is already shifted", () => {
    const { root } = compileStages(
      [
        { id: "s1", delay: 0, k: 1, keys: ["A"] },
        { id: "s2", delay: 1, k: 1, keys: ["A"] },
        { id: "s3", delay: 144, k: 1, keys: ["A"] },
        { id: "s4", delay: 65535, k: 1, keys: ["A"] },
      ],
      true,
    );
    const compiled = compileDescriptor(root, [
      { ...emptyKey("A"), xpub: XPUB, fingerprint: "d060eff8", derivation: "84'/0'/0'", childPath: "<6;7>/*", multipath: "<6;7>" },
    ]);
    assert.equal(compiled.ok, true);
    assert.match(compiled.descriptor, /\/<0;1>\/\*/);
    assert.match(compiled.descriptor, /\/<2;3>\/\*/);
    assert.match(compiled.descriptor, /\/<4;5>\/\*/);
    assert.match(compiled.descriptor, /\/<6;7>\/\*/);
    assert.equal((compiled.descriptor.match(/\/<6;7>\/\*/g) ?? []).length, 1);
  });

  it("stamps unaliased duplicate keys in delay order", () => {
    const root = {
      id: "r",
      kind: "or_i" as const,
      left: {
        id: "late",
        kind: "and_v" as const,
        left: { id: "vw", kind: "wrap" as const, wrap: "v" as const, child: { id: "pk2", kind: "pk" as const, key: "A" } },
        right: { id: "old", kind: "older" as const, n: 144 },
      },
      right: { id: "pk1", kind: "pk" as const, key: "A" },
    };
    const compiled = compileDescriptor(root, [
      { ...emptyKey("A"), xpub: XPUB, fingerprint: "d060eff8", derivation: "84'/0'/0'", childPath: "<2;3>/*" },
    ]);
    assert.equal(compiled.ok, true);
    assert.match(compiled.descriptor, /\/<0;1>\/\*/);
    assert.match(compiled.descriptor, /\/<2;3>\/\*/);
    assert.equal((compiled.descriptor.match(/\/<0;1>\/\*/g) ?? []).length, 1);
    assert.equal((compiled.descriptor.match(/\/<2;3>\/\*/g) ?? []).length, 1);
  });

  it("uses child account origin from keys instead of a counted tail", () => {
    const childXpub = XPUB.replace("Bosf", "Bosg");
    const { root } = compileStages(
      [
        { id: "s1", delay: 0, k: 1, keys: ["A"] },
        { id: "s2", delay: 144, k: 1, keys: ["A"] },
      ],
      true,
    );
    const compiled = compileDescriptor(
      root,
      [
        {
          ...emptyKey("A"),
          xpub: XPUB,
          fingerprint: "deadbeef",
          derivation: "48'/0'/0'/2'",
          children: [{ id: "c1", path: "48'/0'/1'/2'", xpub: childXpub, fingerprint: "deadbeef", note: "" }],
        },
      ],
      true,
    );
    assert.equal(compiled.ok, true);
    assert.match(compiled.descriptor, /48'\/0'\/0'\/2'/);
    assert.match(compiled.descriptor, /48'\/0'\/1'\/2'/);
    assert.match(compiled.descriptor, new RegExp(childXpub));
    assert.equal(compiled.descriptor.includes("/<2;3>/"), false);
  });

  it("changes the checksum when multi keys are reordered, not when sorted", () => {
    assert.equal(permutations(["A", "B"]).length, 2);
    const stages = [{ id: "s1", delay: 0, k: 2, keys: ["A", "B", "C"] }];
    const keys = [
      { ...emptyKey("A"), xpub: XPUB, fingerprint: "aaaaaaa1", derivation: "48'/0'/0'/2'" },
      { ...emptyKey("B"), xpub: XPUB.replace("Bosf", "Bosg"), fingerprint: "bbbbbbb2", derivation: "48'/0'/0'/2'" },
      { ...emptyKey("C"), xpub: XPUB.replace("Bosf", "Bosh"), fingerprint: "ccccccc3", derivation: "48'/0'/0'/2'" },
    ];
    const variants = descriptorOrderVariants(stages, keys, true, 12);
    assert.ok(variants.length >= 2);
    assert.equal(new Set(variants.map((v) => v.checksum)).size, variants.length);
    assert.ok(variants.some((v) => v.childPath === "<0;1>/*"));
    assert.ok(variants.some((v) => v.childPath === "0/*"));
    const sameOrder = variants.filter((v) => v.orders[0] === "A · B · C");
    assert.equal(sameOrder.length, 2);
    assert.notEqual(sameOrder[0]?.checksum, sameOrder[1]?.checksum);
    const sorted = descriptorOrderVariants([{ ...stages[0]!, sorted: true }], keys, true, 12);
    assert.equal(new Set(sorted.map((v) => v.orders[0])).size, 1);
    assert.equal(sorted.length, 2);
  });

  it("maps signing slots to master vs child accounts", () => {
    const stages = [
      { id: "s1", delay: 0, k: 2, keys: ["A", "B"] },
      { id: "s2", delay: 144, k: 1, keys: ["A"] },
    ];
    assert.deepEqual(stageIndicesForAccount(stages, "A", 0, true), [1, 2]);
    assert.deepEqual(stageIndicesForAccount(stages, "A", 0, false), [1]);
    assert.deepEqual(stageIndicesForAccount(stages, "A", 1, false), [2]);
    assert.deepEqual(stageIndicesForAccount(stages, "B", 0, false), [1]);
    const delayed = [
      { id: "s1", delay: 0, k: 2, keys: ["A", "B", "C"] },
      { id: "s2", delay: 60000, k: 2, keys: ["A", "B", "C"] },
    ];
    const a1 = slotsForAccount(delayed, "A", 1, false)[0];
    assert.equal(a1?.quorum, "2of3");
    assert.equal(a1?.delay, 60000);
    assert.deepEqual(
      a1?.signers.map((s) => s.role),
      ["A1 Child", "B1 Child", "C1 Child"],
    );
    const now = describeStageSlots(delayed, false)[0];
    assert.deepEqual(
      now?.signers.map((s) => s.role),
      ["A Master", "B Master", "C Master"],
    );
  });

  it("uses distinct child accounts when reuse is off", () => {
    const { root } = compileStages(
      [
        { id: "s1", delay: 0, k: 2, keys: ["A", "B"] },
        { id: "s2", delay: 144, k: 1, keys: ["A"] },
      ],
      false,
    );
    assert.equal(compileMiniscript(root), "or_i(and_v(v:pk(A1),older(144)),multi(2,A,B))");
    const recovered = inferStages(root);
    assert.equal(recovered.length, 2);
    assert.equal(recovered[0]?.delay, 0);
    assert.deepEqual(recovered[0]?.keys, ["A", "B"]);
    assert.equal(recovered[0]?.k, 2);
    assert.equal(recovered[1]?.delay, 144);
    assert.deepEqual(recovered[1]?.keys, ["A"]);
    assert.equal(recovered[1]?.k, 1);
    const parent = {
      ...emptyKey("A"),
      xpub: XPUB,
      fingerprint: "deadbeef",
      derivation: "48'/0'/0'/2'",
      children: [
        {
          id: "ck1",
          path: "48'/0'/1'/2'",
          xpub: "xpub68Gmy5EdvgibQVfPdqkBBCHxA5htiqg55crXYuXoQRKfDBFA1WEjWgP6LHhwBZeNK1VTsfTFUHCdrfp1bgwQ9xv5ski8PX9rL2dZXvgGDnw",
          fingerprint: "deadbeef",
          note: "A1",
        },
      ],
    };
    const expanded = expandAliasKeys(root, [parent, emptyKey("B")], false);
    const a1 = expanded.find((k) => k.name === "A1");
    assert.equal(a1?.derivation, "48'/0'/1'/2'");
    assert.ok(a1?.xpub.startsWith("xpub68Gmy"));
  });

  it("infers required key plus OR and delayed branches", () => {
    const { node } = parseAny(
      "or_i(and_v(v:multi(2,F,G,H),older(65534)),or_i(and_v(v:pk(D),and_v(v:pk(E),older(60000))),and_v(v:pk(A),or_d(pk(B),pk(C)))))",
    );
    const stages = inferStages(node);
    assert.equal(stages.length, 3);
    assert.equal(stages[0]?.delay, 0);
    assert.deepEqual(stages[0]?.keys, ["A", "B", "C"]);
    assert.deepEqual(stages[0]?.required, ["A"]);
    assert.equal(stages[0]?.k, 2);
    assert.equal(stageFormula(stages[0]!), "A + (B | C)");
    assert.equal(stages[1]?.delay, 60000);
    assert.deepEqual(stages[1]?.keys, ["D", "E"]);
    assert.deepEqual(stages[1]?.required, ["D", "E"]);
    assert.equal(stages[2]?.delay, 65534);
    assert.deepEqual(stages[2]?.keys, ["F", "G", "H"]);
    assert.equal(stages[2]?.k, 2);
    const maxed = inferStages(parseAny("and_v(v:pk(A),older(65535))").node);
    assert.equal(maxed[0]?.delay, 65535);
    const hit = stageHighlightIds(node, stages, stages[0]!.id);
    assert.ok(hit.size >= 3);
    const miss = stageHighlightIds(node, stages, stages[2]!.id);
    assert.ok(miss.size >= 2);
    assert.notEqual(hit.size, miss.size);
  });

  it("highlights a must-sign stage without lighting sibling stages", () => {
    const stages = [
      { id: "s0", delay: 0, k: 2, keys: ["A", "B", "C"], required: ["A"] },
      { id: "s1", delay: 52596, k: 2, keys: ["A", "B", "C", "D"] },
    ];
    const { root } = compileStages(stages, false);
    const a = stageHighlightIds(root, stages, "s0");
    const b = stageHighlightIds(root, stages, "s1");
    assert.ok(a.size >= 1);
    assert.ok(b.size >= 1);
    for (const id of a) assert.equal(b.has(id), false);
    const names = new Set<string>();
    visit(root, (n) => {
      if (!a.has(n.id)) return;
      if (n.kind === "pk" || n.kind === "pkh") names.add(n.key);
      if (n.kind === "multi") for (const k of n.keys) names.add(k);
    });
    assert.equal([...names].some((k) => k === "D" || k.startsWith("D")), false);
  });

  it("highlights distinct compiled stage branches", () => {
    const stages = [
      { id: "s0", delay: 0, k: 2, keys: ["A", "B", "C"] },
      { id: "s1", delay: 52596, k: 2, keys: ["A", "B", "C", "D"] },
    ];
    const { root } = compileStages(stages, false);
    const a = stageHighlightIds(root, stages, "s0");
    const b = stageHighlightIds(root, stages, "s1");
    assert.ok(a.size >= 1);
    assert.ok(b.size >= 2);
    for (const id of a) assert.equal(b.has(id), false);
  });

  it("highlights a 1-key stage even without required[]", () => {
    const stages = [{ id: "solo", delay: 0, k: 1, keys: ["A"] }];
    const { root } = compileStages(stages, false);
    const hit = stageHighlightIds(root, stages, "solo");
    assert.ok(hit.has(root.id));
  });

  it("groups same-fingerprint keys as master and child", () => {
    const childXpub =
      "xpub68Gmy5EdvgibQVfPdqkBBCHxA5htiqg55crXYuXoQRKfDBFA1WEjWgP6LHhwBZeNK1VTsfTFUHCdrfp1bgwQ9xv5ski8PX9rL2dZXvgGDnw";
    const grouped = groupKeysByFingerprint([
      { ...emptyKey("A"), fingerprint: "deadbeef", derivation: "48'/0'/0'/2'", xpub: XPUB },
      { ...emptyKey("B"), fingerprint: "DEADBEEF", derivation: "48'/0'/1'/2'", xpub: childXpub },
      { ...emptyKey("C"), fingerprint: "aaaaaaaa", derivation: "48'/0'/0'/2'", xpub: XPUB.replace("Bosf", "Bosz") },
    ]);
    assert.equal(grouped.keys.length, 2);
    const master = grouped.keys.find((k) => k.name === "A");
    assert.ok(master);
    assert.equal(master!.children.length, 1);
    assert.equal(master!.children[0]?.path, "48'/0'/1'/2'");
    assert.equal(grouped.rename.get("B"), "A1");
    assert.equal(grouped.keys.some((k) => k.name === "B"), false);
  });
});

describe("bip388", () => {
  const keyA = { ...emptyKey("A"), xpub: XPUB, fingerprint: "deadbeef", derivation: "48'/0'/0'/2'" };
  const keyB = {
    ...emptyKey("B"),
    xpub: XPUB.replace("Bosf", "Bosg"),
    fingerprint: "cafebabe",
    derivation: "48'/0'/0'/2'",
  };

  it("compiles a 2-of-3 to @ placeholders", () => {
    const { root } = compileStages([{ id: "s1", delay: 0, k: 2, keys: ["A", "B", "C"] }]);
    const out = compileBip388(root, [keyA, keyB, emptyKey("C")], "Vault");
    assert.equal(out.ok, true);
    assert.equal(out.policy.template, "wsh(multi(2,@0/**,@1/**,@2/**))");
    assert.equal(out.policy.name, "Vault");
    assert.equal(out.policy.keys[0]?.origin, `[deadbeef/48'/0'/0'/2']${XPUB}`);
    assert.ok(out.warnings.some((w) => w.startsWith("missingXpub:C")));
  });

  it("reuses the same @ index for A1/A2 aliases", () => {
    const { root } = compileStages([
      { id: "s1", delay: 0, k: 2, keys: ["A", "B"] },
      { id: "s2", delay: 144, k: 1, keys: ["A"] },
    ]);
    const out = compileBip388(root, [keyA, keyB]);
    assert.equal(out.ok, true);
    assert.equal(out.policy.template, "wsh(or_i(and_v(v:pk(@0/<2;3>/**),older(144)),multi(2,@0/**,@1/**)))");
    assert.equal(out.policy.keys.length, 2);
  });

  it("roundtrips ledger json", () => {
    const { root } = compileStages([{ id: "s1", delay: 0, k: 2, keys: ["A", "B"] }]);
    const compiled = compileBip388(root, [keyA, keyB]);
    const json = formatLedgerJson(compiled.policy);
    const parsed = parseWalletPolicy(json);
    assert.ok(parsed);
    assert.match(parsed!.template, /@0\/\*\*/);
    assert.match(parsed!.template, /sortedmulti\(2,@0\/\*\*,@1\/\*\*\)/);
    const { node, keys } = materializeWalletPolicy(parsed!, []);
    assert.equal(compileMiniscript(node), "multi(2,A,B)");
    assert.equal(keys[0]?.xpub, XPUB);
    assert.equal(keys[0]?.fingerprint.toLowerCase(), "deadbeef");
  });

  it("keeps nested ledger policies as multi(), not sortedmulti()", () => {
    const { root } = compileStages([
      { id: "s1", delay: 0, k: 2, keys: ["A", "B"] },
      { id: "s2", delay: 144, k: 1, keys: ["A"] },
    ]);
    const compiled = compileBip388(root, [keyA, keyB]);
    const ledger = toLedgerPolicy(compiled.policy);
    assert.equal(ledger.template.includes("sortedmulti"), false);
    assert.match(ledger.template, /wsh\(or_i\(and_v\(v:pk\(@0\/<2;3>\/\*\*\),older\(144\)\),multi\(2,@0\/\*\*,@1\/\*\*\)\)\)/);
    assert.match(ledger.keys[0]!.origin, /^\[deadbeef\/48'\/0'\/0'\/2'\]xpub/);
  });

  it("transports key labels through policy text and scriptwerk json", () => {
    const { root } = compileStages([{ id: "s1", delay: 0, k: 2, keys: ["A", "B"] }]);
    const keys = [
      { ...keyA, note: "Alice" },
      { ...keyB, note: "Bob" },
    ];
    const compiled = compileBip388(root, keys);
    assert.equal(compiled.policy.keys[0]?.label, "Alice");
    const text = formatPolicyText(compiled.policy);
    assert.match(text, /Alice/);
    const parsed = parseWalletPolicy(text);
    assert.equal(parsed?.keys[0]?.label, "Alice");
    const { keys: restored } = materializeWalletPolicy(parsed!, []);
    assert.equal(restored.find((k) => k.xpub === XPUB)?.note, "Alice");
    const json = formatScriptwerkJson({
      miniscript: compileMiniscript(root),
      descriptor: "wsh(multi(2,A,B))",
      keys,
      reuseKeys: false,
      network: "mainnet",
    });
    const bundle = parseScriptwerkBundle(json);
    assert.equal(bundle?.keys[0]?.note, "Alice");
    assert.equal(bundle?.keys[1]?.note, "Bob");
  });

  it("keeps child accounts on the same fingerprint instead of new letters", () => {
    const childXpub =
      "xpub68Gmy5EdvgibQVfPdqkBBCHxA5htiqg55crXYuXoQRKfDBFA1WEjWgP6LHhwBZeNK1VTsfTFUHCdrfp1bgwQ9xv5ski8PX9rL2dZXvgGDnw";
    const other =
      "xpub6CohzjsqMhyQdTzBsHR41w1SFdGxPAjxCBJYPcvwx8Am2xFevsXJt1GcKS5epVSvAYhpSNiNqo86nLNBhYkY4SXL1MQeDkZgtR4xL1V4uRn";
    const { root } = compileStages(
      [
        { id: "s0", delay: 0, k: 2, keys: ["A", "B"] },
        { id: "s1", delay: 144, k: 1, keys: ["A1"] },
      ],
      false,
    );
    const keys = [
      {
        ...keyA,
        note: "Alice",
        children: [
          { id: "ck1", path: "48'/0'/1'/2'", xpub: childXpub, fingerprint: "deadbeef", note: "A1" },
        ],
      },
      { ...keyB, note: "Bob", fingerprint: "cafebabe", xpub: other, derivation: "48'/0'/0'/2'" },
    ];
    const compiled = compileDescriptor(root, keys, false);
    assert.equal(compiled.ok, true);
    const parsed = parseAny(compiled.descriptor);
    const extracted = extractKeysFromTree(parsed.node, flattenKeysForLookup(keys));
    assert.equal(compileMiniscript(extracted.node), compileMiniscript(root));
    const a = extracted.keys.find((k) => k.name === "A");
    const a1 = extracted.keys.find((k) => k.name === "A1");
    const b = extracted.keys.find((k) => k.name === "B");
    assert.equal(a?.note, "Alice");
    assert.equal(a?.xpub, XPUB);
    assert.equal(a1?.xpub, childXpub);
    assert.equal(b?.note, "Bob");
  });

  it("maps policy-text labels by xpub even if @ order differs from tree order", () => {
    const { root } = compileStages(
      [
        { id: "late", delay: 0, k: 1, keys: ["B"] },
        { id: "early", delay: 144, k: 1, keys: ["A"] },
      ],
      false,
    );
    const keys = [
      { ...keyA, note: "Alice" },
      { ...keyB, note: "Bob" },
    ];
    const compiled = compileBip388(root, keys, "Scriptwerk", false);
    const text = formatPolicyText(compiled.policy);
    const parsed = parseWalletPolicy(text);
    const { node, keys: restored } = materializeWalletPolicy(parsed!, []);
    const alice = restored.find((k) => k.note === "Alice");
    const bob = restored.find((k) => k.note === "Bob");
    assert.ok(alice);
    assert.ok(bob);
    assert.equal(alice!.xpub, XPUB);
    assert.equal(bob!.xpub, keyB.xpub);
    assert.match(compileMiniscript(node), /A/);
  });

  it("reads bitbox scriptConfig json", () => {
    const json = formatBitboxJson(
      compileBip388(compileStages([{ id: "s1", delay: 0, k: 1, keys: ["A"] }]).root, [keyA]).policy,
    );
    const parsed = parseWalletPolicy(json);
    assert.ok(parsed);
    assert.equal(parsed!.keys[0]?.fingerprint, "deadbeef");
    assert.equal(parsed!.keys[0]?.derivation, "48'/0'/0'/2'");
    const desc = walletPolicyToDescriptor(parsed!);
    assert.match(desc, /deadbeef/);
    assert.match(desc, /<0;1>\/\*/);
  });

  it("parses sortedmulti as multi with sorted flag", () => {
    const { node } = parseAny("wsh(sortedmulti(2,A,B,C))");
    assert.equal(node.kind, "multi");
    if (node.kind !== "multi") return;
    assert.equal(node.sorted, true);
    assert.equal(compileMiniscript(node), "multi(2,A,B,C)");
    const compiled = compileDescriptor(node, [], true);
    assert.equal(compiled.ok, true);
    assert.match(compiled.descriptor, /^wsh\(sortedmulti\(2,A,B,C\)\)#/);
  });

  it("does not emit nested sortedmulti — Core miniscript only allows multi()", () => {
    const { root } = compileStages(
      [
        { id: "s1", delay: 0, k: 2, keys: ["A", "B"], sorted: true },
        { id: "s2", delay: 144, k: 1, keys: ["C"], sorted: true },
      ],
      true,
    );
    const ms = compileMiniscript(root);
    assert.equal(ms.includes("sortedmulti"), false);
    assert.match(ms, /multi\(2,/);
    const compiled = compileDescriptor(root, [], true);
    assert.equal(compiled.descriptor.includes("sortedmulti"), false);
    assert.equal(
      sortedMultiAllowed([{ id: "s1", delay: 0, k: 2, keys: ["A", "B", "C"] }]),
      true,
    );
    assert.equal(
      sortedMultiAllowed([
        { id: "s1", delay: 0, k: 2, keys: ["A", "B"] },
        { id: "s2", delay: 144, k: 1, keys: ["C"] },
      ]),
      false,
    );
    assert.equal(sortedMultiAllowed([{ id: "s1", delay: 144, k: 2, keys: ["A", "B"] }]), false);
  });

  it("reads a bitbox xpub json onto a key slot", () => {
    const result = applyKeyMaterial(
      emptyKey("A"),
      JSON.stringify({ xpub: XPUB, keypath: "m/48'/0'/0'/2'", rootFingerprint: "aabbccdd" }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.key.xpub, XPUB);
    assert.equal(result.key.fingerprint, "aabbccdd");
    assert.equal(result.key.derivation, "48'/0'/0'/2'");
  });
});

describe("hardware paths", () => {
  it("normalizes account paths", () => {
    assert.equal(defaultAccountPath(), "m/48'/0'/0'/2'");
    assert.equal(defaultAccountPath(1), "m/48'/0'/1'/2'");
    assert.equal(normalizeHwPath("48h/0h/0h/2h"), "m/48'/0'/0'/2'");
    assert.equal(pathToDerivation("m/48'/0'/0'/2'"), "48'/0'/0'/2'");
    assert.equal(
      formatOrigin("DEADBEEF", "m/48'/0'/0'/2'", XPUB),
      `[deadbeef/48'/0'/0'/2']${XPUB}`,
    );
  });

  it("demo session fills an origin xpub", async () => {
    const session = openDemoSession("ledger");
    const xpub = await session.getXpub("m/48'/0'/0'/2'");
    assert.equal(session.demo, true);
    assert.equal(xpub.fingerprint, "c0ffee01");
    assert.match(xpub.origin, /^\[c0ffee01\/48'\/0'\/0'\/2'\]xpub/);
    const applied = applyKeyMaterial(emptyKey("A"), xpub.origin);
    assert.equal(applied.ok, true);
    if (!applied.ok) return;
    assert.equal(applied.key.fingerprint, "c0ffee01");
    const hmac = await session.registerPolicy({
      name: "Scriptwerk",
      template: "wsh(pk(@0/**))",
      keys: [],
    });
    assert.equal(hmac.hmac, "00".repeat(32));
    const addr = await session.getWalletAddress({
      policy: { name: "Scriptwerk", template: "wsh(pk(@0/**))", keys: [] },
      hmac: hmac.hmac!,
      change: 0,
      index: 0,
      display: false,
    });
    assert.match(addr, /^bc1qswdemo/);
  });
});

describe("ledger address check helpers", () => {
  it("splits multipath descriptors into receive and change for Core", () => {
    const raw = descsumCreate(`wsh(pk([deadbeef/48'/0'/0'/2']${XPUB}/<0;1>/*))`);
    const recv = descriptorForBranch(raw, 0);
    const chg = descriptorForBranch(raw, 1);
    assert.match(stripChecksum(recv), /\/0\/\*/);
    assert.match(stripChecksum(chg), /\/1\/\*/);
    assert.doesNotMatch(stripChecksum(recv), /<0;1>/);
    assert.equal(descsumCheck(recv), true);
    assert.equal(descsumCheck(chg), true);
  });

  it("builds scantxoutset objects for receive and change", () => {
    const raw = descsumCreate(`wsh(pk([deadbeef/48'/0'/0'/2']${XPUB}/<0;1>/*))`);
    const objs = utxoScanObjects(raw, 20, true, true);
    assert.equal(objs.length, 2);
    assert.deepEqual(objs[0]!.range, [0, 19]);
    assert.match(stripChecksum(objs[0]!.desc), /\/0\/\*/);
    assert.match(stripChecksum(objs[1]!.desc), /\/1\/\*/);
    assert.equal(utxoScanObjects(raw, 20, false, false).length, 0);
    const later = utxoScanObjects(raw, 20, true, false, 20);
    assert.deepEqual(later[0]!.range, [20, 39]);
    const merged = mergeUtxoResults(
      { height: 10, total: 0.1, unspents: [{ txid: "aa", vout: 0, amount: 0.1, height: 9, desc: "" }] },
      { height: 12, total: 0.2, unspents: [{ txid: "aa", vout: 0, amount: 0.1, height: 9, desc: "" }, { txid: "bb", vout: 1, amount: 0.2, height: 11, desc: "" }] },
    );
    assert.equal(merged.unspents.length, 2);
    assert.equal(merged.height, 12);
    assert.ok(Math.abs(merged.total - 0.3) < 1e-9);
  });

  it("parses scantxoutset", () => {
    const parsed = parseScantxoutset({
      success: true,
      height: 900000,
      total_amount: 0.01,
      unspents: [
        { txid: "ab".repeat(32), vout: 1, amount: "0.01", height: 890000, desc: "wsh()" },
        { txid: "", vout: 0, amount: 1 },
      ],
    });
    assert.equal(parsed.unspents.length, 1);
    assert.equal(parsed.unspents[0]!.vout, 1);
    assert.equal(parsed.total, 0.01);
    assert.equal(parsed.height, 900000);
  });

  it("builds a watch-only snapshot from labeled addresses", () => {
    const snap = buildWatchSnapshot({
      height: 800000,
      scanned: 20,
      checksum: "abcd1234",
      addresses: [
        { address: "bc1qaa", kind: "receive", index: 0 },
        { address: "bc1qbb", kind: "change", index: 0 },
        { address: "bc1qaa", kind: "receive", index: 0 },
      ],
      unspents: [
        { txid: "aa", vout: 0, amount: 0.1, height: 799000, desc: "", address: "bc1qaa" },
        { txid: "bb", vout: 1, amount: 0.05, height: 0, desc: "", address: "bc1qaa" },
      ],
    });
    assert.equal(snap.addresses.length, 2);
    assert.ok(Math.abs(snap.confirmed - 0.1) < 1e-9);
    assert.ok(Math.abs(snap.unconfirmed - 0.05) < 1e-9);
    assert.equal(snap.addresses[0]?.coins, 2);
    const merged = mergeWatchSnapshots(snap, {
      ...snap,
      scanned: 40,
      addresses: [{ address: "bc1qcc", kind: "receive", index: 20, amount: 0, coins: 0 }],
      unspents: [{ txid: "cc", vout: 0, amount: 0.2, height: 790000, desc: "", address: "bc1qcc" }],
    });
    assert.equal(merged.addresses.length, 3);
    assert.equal(merged.unspents.length, 3);
    assert.equal(merged.scanned, 40);
  });

  it("keeps policy HMAC keys distinct when the name changes", () => {
    const a = policyCacheKey({ name: "Scriptwerk", template: "wsh(pk(@0/**))", keys: [] });
    const b = policyCacheKey({ name: "Other", template: "wsh(pk(@0/**))", keys: [] });
    assert.notEqual(a, b);
  });

  it("does not treat a mixed table as a match", () => {
    assert.equal(
      allRequestedMatch([
        { index: 0, kind: "receive", path: "0/0", ledger: "a", core: "a", match: true },
        { index: 1, kind: "receive", path: "0/1", ledger: "a", core: "b", match: false },
      ]),
      false,
    );
    assert.equal(allRequestedMatch([]), false);
    assert.deepEqual(clampIndexRange(-3, 99), { from: 0, to: 19 });
    assert.equal(clampUtxoCount(0), 1);
    assert.equal(clampUtxoCount(20), 20);
    assert.equal(clampUtxoCount(9999), 1000);
    assert.equal(formatBtc(0.5), "0.50000000");
    assert.equal(formatBtcDisplay(0.5, "en-US"), "0.50000000");
    assert.equal(formatBtcDisplay(1.5, "en-US"), "1.50000000");
    assert.equal(formatBtcDisplay(1.23456789, "en-US"), "1.23456789");
    assert.equal(formatBtcDisplay(1.5, "de-DE"), "1,50000000");
    assert.equal(formatBtcDisplay(1234.5, "de-DE"), "1.234,50000000");
    assert.equal(formatBtcDisplay(1234.5, "en-US"), "1,234.50000000");
    assert.equal(toSats(0.01), 1_000_000);
    assert.equal(resolveAmountUnit(0.09, "auto"), "sats");
    assert.equal(resolveAmountUnit(0.1, "auto"), "btc");
    assert.equal(resolveAmountUnit(2, "auto"), "btc");
    assert.equal(formatAmount(0.09, "auto", "en-US").kind, "sats");
    assert.equal(formatAmount(1.23456789, "btc", "en-US").text, "1.23456789");
    assert.equal(formatAmount(0.5, "btc", "en-US").text, "0.50000000");
    assert.equal(formatAmount(0.5, "btc", "de-DE").text, "0,50000000");
    assert.equal(formatAmount(0.5, "sats", "en-US").text, "50,000,000");
    assert.equal(chainMatches("mainnet", "main"), true);
    assert.equal(chainMatches("mainnet", "test"), false);
    assert.equal(chainMatches("mainnet", "signet"), false);
    assert.equal(isHmacHex("00".repeat(32)), true);
    assert.equal(isHmacHex("demo"), false);
    assert.equal(
      alignLedgerOrigin(`[deadbeef/48'/0'/0'/2']${XPUB}`, "deadbeef", "1'"),
      `[deadbeef/48'/1'/0'/2']${XPUB}`,
    );
    assert.equal(
      alignLedgerOrigin(`[cafebabe/48'/0'/0'/2']${XPUB}`, "deadbeef", "1'"),
      `[cafebabe/48'/0'/0'/2']${XPUB}`,
    );
    assert.equal(
      bitboxAddressPath(
        {
          name: "Scriptwerk",
          template: "wsh(pk(@0/**))",
          keys: [
            {
              index: 0,
              name: "A",
              label: "A",
              fingerprint: "b17b0b02",
              derivation: "48'/0'/0'/2'",
              xpub: XPUB,
              origin: `[b17b0b02/48'/0'/0'/2']${XPUB}`,
            },
          ],
        },
        "b17b0b02",
        1,
        3,
      ),
      "m/48'/0'/0'/2'/1/3",
    );
    const wo = watchOnlyKeys({
      name: "Scriptwerk",
      template: "wsh(pk(@0/**))",
      keys: [
        {
          index: 0,
          name: "A",
          label: "A-Master",
          fingerprint: "deadbeef",
          derivation: "48'/0'/0'/2'",
          xpub: XPUB,
          origin: `[deadbeef/48'/0'/0'/2']${XPUB}`,
        },
      ],
    });
    assert.equal(wo.length, 1);
    assert.equal(wo[0]!.xpub, XPUB);
    assert.equal(wo[0]!.origin.startsWith("[deadbeef/"), true);
  });

  it("does not warn just because a policy has many keys", () => {
    const { node } = parseAny("multi(2,A,B,C,D,E,F)");
    const issues = validatePolicy(node, "en");
    assert.equal(issues.some((i) => /5 keys|placeholders|manyKeys/i.test(i.message)), false);
  });
});

describe("spend-path check", () => {
  const abc = [{ id: "s1", delay: 0, k: 2, keys: ["A", "B", "C"] }];
  const locked = [
    { id: "s1", delay: 0, k: 2, keys: ["A", "B", "C"] },
    { id: "s2", delay: 144, k: 1, keys: ["A"], required: ["A"] },
  ];

  it("counts confirmations from coin height", () => {
    assert.equal(confirmationsAt(100, 0), 0);
    assert.equal(confirmationsAt(100, 100), 1);
    assert.equal(confirmationsAt(244, 100), 145);
    assert.equal(confirmationsAt(100, coinHeightFromConfirms(100, 20)), 20);
    assert.equal(youngestCoinHeight([10, 50, 0]), 50);
    assert.equal(oldestCoinHeight([10, 50, 0]), 10);
    assert.equal(oldestCoinHeight([0, 0]), 0);
  });

  it("2-of-3 spends with two devices now", () => {
    const r = evaluateSpendPaths({ stages: abc, reuse: true, present: ["A", "B"], tip: 800000, coinHeight: 0 });
    assert.equal(r.stages[0]?.canSpendNow, true);
    assert.equal(r.anyNow, true);
  });

  it("2-of-3 with one device cannot sign", () => {
    const r = evaluateSpendPaths({ stages: abc, reuse: true, present: ["A"], tip: 800000, coinHeight: 0 });
    assert.equal(r.stages[0]?.canSign, false);
    assert.equal(r.stages[0]?.restNeed, 2);
    assert.equal(r.stages[0]?.restHave, 1);
  });

  it("required key A plus one of the rest", () => {
    const stages = [{ id: "s1", delay: 0, k: 2, keys: ["A", "B", "C"], required: ["A"] }];
    const ok = evaluateSpendPaths({ stages, reuse: true, present: ["A", "C"], tip: 1, coinHeight: 0 });
    assert.equal(ok.stages[0]?.canSpendNow, true);
    const no = evaluateSpendPaths({ stages, reuse: true, present: ["B", "C"], tip: 1, coinHeight: 0 });
    assert.equal(no.stages[0]?.canSign, false);
    assert.ok(no.stages[0]?.missingMust.length);
  });

  it("timelock waits even when keys are enough", () => {
    const r = evaluateSpendPaths({
      stages: locked,
      reuse: true,
      present: ["A"],
      tip: 800000,
      coinHeight: 0,
    });
    const later = r.stages.find((s) => s.delay === 144);
    assert.equal(later?.canSign, true);
    assert.equal(later?.canSpendNow, false);
    assert.equal(later?.blocksLeft, 144);
    const aged = evaluateSpendPaths({
      stages: locked,
      reuse: true,
      present: ["A"],
      tip: 800144,
      coinHeight: coinHeightFromConfirms(800144, 144),
    });
    assert.equal(aged.stages.find((s) => s.delay === 144)?.canSpendNow, true);
  });

  it("one physical key covers child slots when reuse is off", () => {
    const stages = [
      { id: "s1", delay: 0, k: 2, keys: ["A", "B"] },
      { id: "s2", delay: 144, k: 1, keys: ["A"] },
    ];
    const r = evaluateSpendPaths({ stages, reuse: false, present: ["A"], tip: 900000, coinHeight: 1 });
    const second = r.stages.find((s) => s.delay === 144);
    assert.equal(second?.canSign, true);
  });

  it("sums spendable UTXOs and times the oldest remaining lock", () => {
    const stages = [{ id: "s1", delay: 144, k: 1, keys: ["A"] }];
    const r = evaluateSpendPaths({
      stages,
      reuse: true,
      present: ["A"],
      tip: 1000,
      coinHeight: 0,
      coins: [
        { height: 800, amount: 0.1 },
        { height: 850, amount: 0.2 },
        { height: 950, amount: 0.05 },
      ],
    });
    const s = r.stages[0]!;
    assert.equal(s.confirmations, 1000 - 800 + 1);
    assert.equal(s.canSpendNow, true);
    assert.ok(Math.abs(s.amountNow - 0.3) < 1e-9);
    assert.ok(Math.abs(s.nextAmount - 0.05) < 1e-9);
    assert.equal(s.nextBlocks, 144 - (1000 - 950 + 1));
  });

  it("shows when the first UTXO unlocks if none are old enough", () => {
    const stages = [{ id: "s1", delay: 144, k: 1, keys: ["A"] }];
    const r = evaluateSpendPaths({
      stages,
      reuse: true,
      present: ["A"],
      tip: 200,
      coinHeight: 0,
      coins: [
        { height: 180, amount: 0.4 },
        { height: 190, amount: 0.1 },
      ],
    });
    const s = r.stages[0]!;
    assert.equal(s.canSpendNow, false);
    assert.equal(s.canSign, true);
    assert.equal(s.blocksLeft, 144 - (200 - 180 + 1));
    assert.ok(Math.abs(s.nextAmount - 0.4) < 1e-9);
  });
});

describe("policy library", () => {
  it("reads checksum from a descriptor", () => {
    assert.equal(peekChecksum("wsh(pk(A))#abcdefgh"), "abcdefgh");
    assert.equal(peekChecksum("wsh(pk(A))"), "");
  });

  it("round-trips saved policies", () => {
    const item: SavedPolicy = {
      id: "pol_1",
      name: "Erbe",
      savedAt: 1,
      checksum: "abcdefgh",
      network: "mainnet",
      snapshot: {
        keys: [],
        root: null,
        stages: [{ id: "st_1", delay: 0, k: 2, keys: ["A", "B", "C"] }],
        network: "mainnet",
        reuseKeys: false,
        nesting: "late",
        mode: "easy",
        maxOlder: 65534,
        policyName: "Erbe",
      },
    };
    const raw = encodeLibrary([item]);
    const back = decodeLibrary(raw);
    assert.equal(back.length, 1);
    assert.equal(back[0]!.name, "Erbe");
    assert.equal(back[0]!.snapshot.stages[0]!.k, 2);
  });

  it("drops junk rows", () => {
    assert.deepEqual(decodeLibrary("[]"), []);
    assert.deepEqual(decodeLibrary("{"), []);
    assert.deepEqual(decodeLibrary('[{"name":"x"}]'), []);
  });

  it("policySig ignores ids and detects edits", () => {
    const base = {
      policyName: "Erbe",
      keys: [],
      stages: [{ id: "st_1", delay: 0, k: 2, keys: ["A", "B", "C"] }],
      reuseKeys: false,
      nesting: "late" as const,
      maxOlder: 65534 as const,
      policyMode: "stages" as const,
      originalDescriptor: "",
    };
    const twin = { ...base, stages: [{ id: "st_other", delay: 0, k: 2, keys: ["A", "B", "C"] }] };
    assert.equal(policySig(base), policySig(twin));
    assert.notEqual(policySig(base), policySig({ ...base, policyName: "Haus" }));
    assert.equal(policyIsDirty({ ...base, savedId: null, cleanSig: policySig(base) }), true);
    assert.equal(policyIsDirty({ ...base, savedId: "pol_1", cleanSig: policySig(base) }), false);
    assert.equal(
      policyIsDirty({ ...base, stages: [{ ...base.stages[0]!, delay: 144 }], savedId: "pol_1", cleanSig: policySig(base) }),
      true,
    );
  });
});

describe("electrum helpers", () => {
  it("decodes BIP-173 P2WPKH", () => {
    assert.equal(
      scriptPubKeyFromAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"),
      "0014751e76e8199196d454941c45d1b3a323f1433bd6",
    );
  });

  it("builds an electrum scripthash", async () => {
    const h = await scripthashForAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
    assert.equal(h.length, 64);
    assert.match(h, /^[0-9a-f]+$/);
  });

  it("parses electrum URLs and LAN hosts", () => {
    assert.deepEqual(parseElectrumUrl("capable-dosage.local:50001"), {
      host: "capable-dosage.local",
      port: 50001,
      tls: false,
    });
    assert.equal(parseElectrumUrl("ssl://node.local:50002")?.tls, true);
    assert.equal(electrumHostAllowed("192.168.178.55"), true);
    assert.equal(electrumHostAllowed("8.8.8.8"), false);
    assert.equal(electrumHostAllowed("electrs.local"), true);
  });
});

describe("imported policy mode", () => {
  const keys = [emptyKey("A"), emptyKey("B"), emptyKey("C")];

  function classify(src: string) {
    const parsed = parseAny(src);
    const stages = inferStages(parsed.node);
    return classifyImportedPolicy({
      root: parsed.node,
      stages,
      keys,
      source: src,
    });
  }

  it("keeps a classic 2-of-3 plus older recovery in stages mode", () => {
    const { root } = compileStages(
      [
        { id: "s0", delay: 0, k: 2, keys: ["A", "B", "C"] },
        { id: "s1", delay: 144, k: 1, keys: ["A"] },
      ],
      false,
    );
    const src = compileMiniscript(root);
    const hit = classify(src);
    assert.equal(hit.mode, "stages");
    assert.equal(hit.stages.length, 2);
    assert.equal(hit.originalDescriptor, "");
  });

  it("freezes or_d as display when Scriptwerk would emit or_i", () => {
    const src = "wsh(or_d(multi(2,A,B,C),and_v(v:pk(A),older(144))))";
    const hit = classify(src);
    assert.equal(hit.mode, "display");
    assert.ok(hit.stages.length >= 1);
    assert.ok(hit.originalDescriptor.includes("or_d"));
    assert.equal(descriptorsEquivalent(hit.originalDescriptor, src), true);
  });

  it("puts sha256 into raw mode", () => {
    const hash = classify("wsh(and_v(v:pk(A),sha256(00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff)))");
    assert.equal(hash.mode, "raw");
    assert.equal(hash.liftWarning, "hashlock");
    assert.equal(liftIncompleteReason(parseAny("wsh(sha256(aa))").node, "wsh(sha256(aa))"), "hashlock");
  });

  it("lifts after() onto a stage instead of freezing", () => {
    const after = classify("wsh(and_v(v:pk(A),after(800000)))");
    assert.equal(after.mode, "stages");
    assert.equal(after.stages[0]?.lock, "after");
    assert.equal(after.stages[0]?.delay, 800000);
    assert.equal(after.originalDescriptor, "");
  });

  it("rejects taproot and private material before raw mode", () => {
    assert.equal(assertImportableText("tr(A)"), "import.err.taproot");
    assert.equal(assertImportableText("wsh(tr(A))"), "import.err.taproot");
    assert.equal(assertImportableText("wsh(musig(A,B))"), "import.err.taproot");
    assert.throws(() => parseAny("tr(A)"), /import.err.taproot/);
    assert.throws(() => parseAny("wsh(pk(A))#zzzzzzzz"), /import.err.checksum/);
    assert.equal(
      assertImportableText("wsh(pk(xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi))"),
      "import.err.private",
    );
  });

  it("serves the frozen original from compiledForStudio", () => {
    const original = descsumCreate("wsh(and_v(v:pk(A),after(800000)))");
    const out = compiledForStudio({
      policyMode: "raw",
      originalDescriptor: original,
      root: parseAny(original).node,
      keys,
      reuseKeys: false,
    });
    assert.ok(out && "ok" in out && out.ok);
    assert.equal(out.descriptor, original);
    assert.match(out.miniscript, /after\(800000\)/);
  });
});

describe("coin spendability", () => {
  const twoOfThree = [
    { id: "s0", delay: 0, k: 2, keys: ["A", "B", "C"] },
    { id: "s1", delay: 144, k: 1, keys: ["A"] },
  ];

  it("marks a confirmed 2-of-3 coin spendable now with recovery still locked", () => {
    const hit = evaluateCoinStatus({ height: 1000, tip: 1000, stages: twoOfThree });
    assert.equal(hit.confirmations, 1);
    assert.equal(hit.state, "now");
    assert.equal(hit.spendable, true);
    assert.equal(hit.paths[0]?.open, true);
    assert.equal(hit.paths[1]?.open, false);
    assert.equal(hit.paths[1]?.blocksLeft, 143);
  });

  it("opens recovery after older() confirmations", () => {
    const hit = evaluateCoinStatus({ height: 857, tip: 1000, stages: twoOfThree });
    assert.equal(hit.confirmations, 144);
    assert.equal(hit.paths[1]?.open, true);
    assert.equal(hit.spendable, true);
  });

  it("keeps a delay-only stage locked until older() elapses", () => {
    const hit = evaluateCoinStatus({
      height: 1000,
      tip: 1000,
      stages: [{ id: "s0", delay: 144, k: 1, keys: ["A"] }],
    });
    assert.equal(hit.state, "later");
    assert.equal(hit.spendable, false);
    assert.equal(hit.next?.blocksLeft, 143);
  });

  it("treats height 0 as unconfirmed", () => {
    const hit = evaluateCoinStatus({ height: 0, tip: 800000, stages: twoOfThree });
    assert.equal(hit.state, "unconfirmed");
    assert.equal(hit.spendable, false);
  });

  it("uses after() from a raw tree", () => {
    const { node } = parseAny("wsh(and_v(v:pk(A),after(800000)))");
    const locked = evaluateCoinStatus({ height: 790000, tip: 790000, root: node, stages: [] });
    assert.equal(locked.state, "later");
    assert.equal(locked.next?.kind, "after");
    assert.equal(locked.next?.blocksLeft, 10000);
    const open = evaluateCoinStatus({ height: 799000, tip: 800000, root: node, stages: [] });
    assert.equal(open.state, "now");
    assert.equal(open.spendable, true);
  });

  it("opens an after() stage at the lock height", () => {
    const stages = [
      { id: "s0", delay: 0, k: 2, keys: ["A", "B", "C"] },
      { id: "s1", delay: 800000, lock: "after" as const, k: 1, keys: ["A"] },
    ];
    const locked = evaluateCoinStatus({ height: 790000, tip: 790000, stages });
    assert.equal(locked.paths[0]?.open, true);
    assert.equal(locked.paths[1]?.kind, "after");
    assert.equal(locked.paths[1]?.open, false);
    assert.equal(locked.paths[1]?.blocksLeft, 10000);
    const open = evaluateCoinStatus({ height: 800000, tip: 800000, stages });
    assert.equal(open.paths[1]?.open, true);
    assert.equal(open.spendable, true);
  });

  it("never claims a hashlock is spendable", () => {
    const { node } = parseAny(
      "wsh(and_v(v:pk(A),sha256(00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff)))",
    );
    const hit = evaluateCoinStatus({ height: 100, tip: 200, root: node, stages: [] });
    assert.equal(hit.unknown, true);
    assert.equal(hit.spendable, false);
    assert.equal(hit.state, "unknown");
  });
});

