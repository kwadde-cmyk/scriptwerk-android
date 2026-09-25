import type { Bip388Policy } from "@/lib/miniscript/bip388";
import { ledgerPolicyReady } from "@/lib/miniscript/bip388";
import { bitboxAddressPath } from "./address-check.ts";
import { formatOrigin, hwErrorMessage, normalizeHwPath, pathToDerivation, defaultAccountPath, type HwSession } from "./types.ts";
import { installNativeUsbPolyfill } from "./native-usb.ts";

type BitboxMod = typeof import("bitbox-api");
type Paired = InstanceType<BitboxMod["PairedBitBox"]>;

function sanitizeName(name: string): string {
  return name
    .trim()
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 30);
}

function coinOf(_explicit?: "btc", _policy?: Bip388Policy): "btc" {
  return "btc";
}

function scriptConfig(policy: Bip388Policy) {
  const ready = ledgerPolicyReady(policy);
  if (!ready.ok) throw new Error(ready.error);
  const keys = ready.policy.keys.map((k) => ({
    rootFingerprint: k.fingerprint,
    keypath: k.derivation ? `m/${k.derivation.replace(/^m\//, "")}` : undefined,
    xpub: k.xpub,
  }));
  if (!keys.length) throw new Error("hw.err.needKeys");
  return {
    policy: {
      policy: ready.policy.template,
      keys,
    },
  };
}

export async function openBitBoxSession(
  onPairing: (code: string | null) => void,
  onClose: () => void,
): Promise<HwSession> {
  await installNativeUsbPolyfill();
  const bitbox: BitboxMod = await import("bitbox-api");
  const unpaired = await bitbox.bitbox02ConnectWebHID(onClose);
  const pairing = await unpaired.unlockAndPair();
  const code = pairing.getPairingCode();
  onPairing(code ?? null);
  const device: Paired = await pairing.waitConfirm();
  onPairing(null);

  const fp = (await device.rootFingerprint()).toLowerCase();
  const product = device.product();
  const version = device.version();
  const label = `BitBox02 · ${version}`;

  return {
    kind: "bitbox",
    demo: false,
    label,
    fingerprint: fp,
    product,
    async getXpub(path: string, display = false) {
      try {
        const p = normalizeHwPath(path);
        const xpub = await device.btcXpub("btc", p, "xpub", display);
        return {
          xpub,
          fingerprint: fp,
          derivation: pathToDerivation(p),
          origin: formatOrigin(fp, p, xpub),
        };
      } catch (err) {
        throw new Error(hwErrorMessage(err));
      }
    },
    async registerPolicy(policy: Bip388Policy) {
      try {
        const script = scriptConfig(policy);
        const coin = coinOf(undefined, policy);
        const name = sanitizeName(policy.name) || "Scriptwerk";
        let registered = false;
        try {
          registered = await device.btcIsScriptConfigRegistered(coin, script, undefined);
        } catch {
          registered = false;
        }
        if (!registered) {
          await device.btcRegisterScriptConfig(coin, script, undefined, "autoXpubTpub", name);
        }
        return { hmac: "ok" };
      } catch (err) {
        throw new Error(hwErrorMessage(err));
      }
    },
    async getWalletAddress({ policy, change, index, display, coin }) {
      try {
        const script = scriptConfig(policy);
        const c = coinOf(coin, policy);
        let registered = false;
        try {
          registered = await device.btcIsScriptConfigRegistered(c, script, undefined);
        } catch {
          registered = false;
        }
        if (!registered) {
          await device.btcRegisterScriptConfig(
            c,
            script,
            undefined,
            "autoXpubTpub",
            sanitizeName(policy.name) || "Scriptwerk",
          );
        }
        const path = bitboxAddressPath(policy, fp, change, index);
        return await device.btcAddress(c, path, script, display);
      } catch (err) {
        throw new Error(hwErrorMessage(err));
      }
    },
    async close() {
      try {
        device.close();
      } catch {
        /* already gone */
      }
    },
    async signPsbt({ psbt, policy }) {
      try {
        const script = scriptConfig(policy);
        const keypath = script.policy.keys.find((k) => k.keypath)?.keypath || defaultAccountPath();
        return await device.btcSignPSBT("btc", psbt, { scriptConfig: script, keypath }, "sat");
      } catch (err) {
        throw new Error(hwErrorMessage(err));
      }
    },
  };
}
