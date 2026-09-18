import type { MsNode } from "./miniscript/ast.ts";
import type { KeyEntry } from "./miniscript/keys.ts";
import type { MaxOlder, Nesting, Stage } from "./miniscript/stages.ts";
import type { PolicyMode } from "./miniscript/policy-mode.ts";
import { uid } from "./utils.ts";

export const POLICY_LIBRARY_KEY = "scriptwerk-policies-v1";
const MAX = 40;

export type PolicySnapshot = {
  keys: KeyEntry[];
  root: MsNode | null;
  stages: Stage[];
  network: "mainnet";
  reuseKeys: boolean;
  nesting: Nesting;
  mode: "easy" | "expert";
  maxOlder: MaxOlder;
  policyName: string;
  policyMode?: PolicyMode;
  originalDescriptor?: string;
  liftWarning?: string;
};

export type SavedPolicy = {
  id: string;
  name: string;
  savedAt: number;
  checksum: string;
  network: "mainnet";
  snapshot: PolicySnapshot;
};

export function peekChecksum(descriptor: string): string {
  const m = descriptor.trim().match(/#([a-z0-9]{8})\s*$/i);
  return m ? m[1]!.toLowerCase() : "";
}

export function decodeLibrary(raw: string): SavedPolicy[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: SavedPolicy[] = [];
    for (const row of parsed) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const snap = r.snapshot;
      if (!snap || typeof snap !== "object") continue;
      const name = String(r.name ?? "").trim();
      const id = String(r.id ?? "").trim();
      if (!name || !id) continue;
      out.push({
        id,
        name,
        savedAt: Number(r.savedAt) || 0,
        checksum: String(r.checksum ?? ""),
        network: "mainnet",
        snapshot: snap as PolicySnapshot,
      });
    }
    return out.sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}

export function encodeLibrary(items: SavedPolicy[]): string {
  return JSON.stringify(items.slice(0, MAX));
}

function readRaw(): SavedPolicy[] {
  try {
    if (typeof localStorage === "undefined") return [];
    return decodeLibrary(localStorage.getItem(POLICY_LIBRARY_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function writeRaw(items: SavedPolicy[]) {
  try {
    localStorage.setItem(POLICY_LIBRARY_KEY, encodeLibrary(items));
  } catch {
    /* quota */
  }
}

export function listPolicies(): SavedPolicy[] {
  return readRaw();
}

export function savePolicy(input: {
  name: string;
  checksum: string;
  network: "mainnet";
  snapshot: PolicySnapshot;
  id?: string;
}): SavedPolicy {
  const name = input.name.trim() || "Scriptwerk";
  const items = readRaw();
  const existing = input.id
    ? items.find((p) => p.id === input.id)
    : items.find((p) => p.name.toLowerCase() === name.toLowerCase());
  const saved: SavedPolicy = {
    id: existing?.id ?? uid("pol"),
    name,
    savedAt: Date.now(),
    checksum: input.checksum,
    network: input.network,
    snapshot: { ...input.snapshot, policyName: name },
  };
  const next = [saved, ...items.filter((p) => p.id !== saved.id)].slice(0, MAX);
  writeRaw(next);
  return saved;
}

export function deletePolicy(id: string): void {
  writeRaw(readRaw().filter((p) => p.id !== id));
}
