import { Output } from "@bitcoinerlab/descriptors";
import { stripChecksum } from "../miniscript/checksum.ts";

/** Receive and change addresses from the descriptor. No Bitcoin Core. */
export function deriveAddressesLocal(descriptor: string, begin: number, end: number): string[] {
  const body = stripChecksum(descriptor);
  const from = Math.max(0, Math.floor(begin));
  const to = Math.max(from, Math.floor(end));
  const out: string[] = [];
  for (let i = from; i <= to; i++) {
    try {
      out.push(new Output({ descriptor: body, index: i, checksumRequired: false }).getAddress());
    } catch {
      throw new Error("hw.utxo.derive");
    }
  }
  return out;
}
