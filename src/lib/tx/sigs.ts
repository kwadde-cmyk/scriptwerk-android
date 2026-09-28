import { baseKeyName, type KeyEntry } from "../miniscript/keys.ts";
import { describeStageSlots, type Stage } from "../miniscript/stages.ts";
import { inspectSignatures } from "./psbt.ts";

export type SigPresent = { label: string; path: string; onPath: boolean };

export type InputSignoff = {
  index: number;
  finalized: boolean;
  present: SigPresent[];
  missing: string[];
  need: number;
  haveOnPath: number;
  pathReady: boolean;
};

export type SignatureReport = {
  inputs: InputSignoff[];
  quorum: string;
};

/** Third BIP32 step is the account (`m/48'/0'/1'/2'/…`). */
export function accountOfPath(path: string): number {
  const parts = path.trim().replace(/^m\/?/, "").split("/").filter(Boolean);
  if (parts.length < 3) return 0;
  const n = Number.parseInt(parts[2]!, 10);
  return Number.isFinite(n) ? n : 0;
}

function fingerprintOf(key: KeyEntry): string {
  return key.fingerprint.replace(/^0x/i, "").toLowerCase();
}

function labelOf(keys: KeyEntry[], fingerprint: string, path: string): string {
  const fp = fingerprint.toLowerCase();
  const account = accountOfPath(path);
  const key = keys.find((k) => fingerprintOf(k) === fp);
  if (!key) return fp ? `${fp} · ${path.replace(/^m\/?/, "")}` : path || "—";
  const name = key.note.trim() || key.name;
  return account > 0 ? `${name} ${key.name}${account}` : name;
}

function signerLabel(keys: KeyEntry[], token: string, account: number): string {
  const key = keys.find((k) => k.name === baseKeyName(token));
  const name = key?.note.trim() || token;
  return account > 0 && key ? `${name} ${token}` : name;
}

function sameSigner(
  signer: { token: string; account: number },
  keys: KeyEntry[],
  fingerprint: string,
  path: string,
): boolean {
  const key = keys.find((k) => k.name === baseKeyName(signer.token));
  if (!key?.fingerprint) return false;
  return fingerprintOf(key) === fingerprint.toLowerCase() && accountOfPath(path) === signer.account;
}

export function signatureReport(
  psbt: string,
  opts: { keys: KeyEntry[]; stages: Stage[]; reuse: boolean; pathIndex: number | null },
): SignatureReport {
  const seen = inspectSignatures(psbt);
  const slots = describeStageSlots(opts.stages, opts.reuse);
  const slot = opts.pathIndex == null ? null : slots[opts.pathIndex] ?? null;
  return {
    quorum: slot?.quorum ?? "",
    inputs: seen.inputs.map((input) => {
      const signed = new Set(input.pubkeys.map((pk) => pk.toLowerCase()));
      const present: SigPresent[] = [];
      const used = new Set<string>();
      for (const deriv of input.derivations) {
        if (!signed.has(deriv.pubkey.toLowerCase()) || used.has(deriv.pubkey.toLowerCase())) continue;
        used.add(deriv.pubkey.toLowerCase());
        present.push({
          label: labelOf(opts.keys, deriv.fingerprint, deriv.path),
          path: deriv.path,
          onPath: slot ? slot.signers.some((s) => sameSigner(s, opts.keys, deriv.fingerprint, deriv.path)) : false,
        });
      }
      for (const pk of input.pubkeys) {
        if (used.has(pk.toLowerCase())) continue;
        present.push({ label: `${pk.slice(0, 12)}…`, path: "", onPath: false });
      }
      const missing = slot
        ? slot.signers
            .filter((s) => !input.derivations.some((d) => signed.has(d.pubkey.toLowerCase()) && sameSigner(s, opts.keys, d.fingerprint, d.path)))
            .map((s) => signerLabel(opts.keys, s.token, s.account))
        : [];
      const haveOnPath = slot ? slot.signers.length - missing.length : present.length;
      const need = slot?.k ?? 0;
      return {
        index: input.index,
        finalized: input.finalized,
        present,
        missing,
        need,
        haveOnPath,
        pathReady: Boolean(slot && (input.finalized || haveOnPath >= need)),
      };
    }),
  };
}
