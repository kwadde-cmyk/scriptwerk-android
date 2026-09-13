import type { MsNode, WrapCode } from "./ast.ts";
import { hole } from "./ast.ts";
import { uid } from "../utils.ts";

export type ParamKind = "key" | "keylist" | "blocks" | "int";

export type OperatorGroup = "keys" | "time" | "and" | "or" | "thresh" | "wrap";

export interface OperatorDef {
  id: string;
  label: string;
  group: OperatorGroup;
  summary: string;
  hint: string;
  params: { name: string; kind: ParamKind; min?: number; max?: number }[];
}

export const WRAPPERS: { code: WrapCode; summary: string }[] = [
  { code: "v", summary: "VERIFY – bricht bei Fehlschlag ab (für and_v nötig)" },
  { code: "a", summary: "Altstack – für thresh-Zweige" },
  { code: "c", summary: "CHECKSIG auf einem Key-Fragment" },
  { code: "d", summary: "DUP IF … ENDIF (dissatisfiable)" },
  { code: "n", summary: "0NOTEQUAL" },
  { code: "t", summary: "and_v(X,1) – unit-true" },
  { code: "u", summary: "or_i(X,0)" },
  { code: "l", summary: "or_i(0,X)" },
  { code: "s", summary: "SWAP" },
  { code: "j", summary: "SIZE 0NOTEQUAL IF" },
];

export const OPERATORS: OperatorDef[] = [
  {
    id: "pk",
    label: "pk",
    group: "keys",
    summary: "Signatur eines öffentlichen Schlüssels",
    hint: "Sofort ausgebbar mit diesem Key. In Native SegWit die übliche Form.",
    params: [{ name: "key", kind: "key" }],
  },
  {
    id: "pkh",
    label: "pkh",
    group: "keys",
    summary: "Signatur zum Hash eines Schlüssels",
    hint: "Spart Platz im Script, Key kommt erst beim Ausgeben. Oft in Liana-Exporten.",
    params: [{ name: "key", kind: "key" }],
  },
  {
    id: "multi",
    label: "multi",
    group: "keys",
    summary: "k-von-n CHECKMULTISIG",
    hint: "Klassisches Multisig. Maximal 20 Keys. Reihenfolge der Keys ist relevant.",
    params: [
      { name: "k", kind: "int", min: 1, max: 20 },
      { name: "keys", kind: "keylist" },
    ],
  },
  {
    id: "older",
    label: "older",
    group: "time",
    summary: "Relatives Timelock (CSV, Blöcke)",
    hint: "Gültig, wenn die Coin-Age ≥ n Blöcke ist. Max 65535. 144 Blöcke ≈ 1 Tag.",
    params: [{ name: "n", kind: "blocks", min: 1, max: 65535 }],
  },
  {
    id: "after",
    label: "after",
    group: "time",
    summary: "Absolutes Timelock (CLTV)",
    hint: "Gültig ab Blockhöhe n. Für UTXO-Alter eher older verwenden.",
    params: [{ name: "n", kind: "blocks", min: 1, max: 500000000 }],
  },
  {
    id: "and_v",
    label: "and_v",
    group: "and",
    summary: "Beide Zweige müssen gelten",
    hint: "Linkes Kind muss vom Typ V sein (oft v:pk). Standard-UND für Policies.",
    params: [],
  },
  {
    id: "and_b",
    label: "and_b",
    group: "and",
    summary: "BOOLAND der beiden Zweige",
    hint: "Seltener; für boolesche Kombinationen in thresh.",
    params: [],
  },
  {
    id: "andor",
    label: "andor",
    group: "and",
    summary: "(X und Y) oder Z",
    hint: "Kompakte Vererbung: z. B. andor(pk(Backup), older(n), multi(2,A,B,C)).",
    params: [],
  },
  {
    id: "or_i",
    label: "or_i",
    group: "or",
    summary: "IF / ELSE – einer der beiden Zweige",
    hint: "Stabilste ODER-Form in Nunchuk. Witness wählt den Zweig (1 oder 0).",
    params: [],
  },
  {
    id: "or_d",
    label: "or_d",
    group: "or",
    summary: "IFDUP NOTIF – kompakteres ODER",
    hint: "Gut für A+(B oder C): and_v(v:pk(A), or_d(pk(B), pk(C))). Linker Zweig muss dissatisfiable sein.",
    params: [],
  },
  {
    id: "or_c",
    label: "or_c",
    group: "or",
    summary: "NOTIF – Verify-ODER",
    hint: "Rechter Zweig vom Typ V. Kompakter, weniger flexibel.",
    params: [],
  },
  {
    id: "or_b",
    label: "or_b",
    group: "or",
    summary: "BOOLOR der beiden Zweige",
    hint: "Beide Zweige werden ausgeführt. Für thresh-artige Konstruktionen.",
    params: [],
  },
  {
    id: "thresh",
    label: "thresh",
    group: "thresh",
    summary: "k von n beliebigen Fragmenten",
    hint: "Allgemeiner als multi: Zweige können Keys, Zeit oder ganze Policies sein.",
    params: [{ name: "k", kind: "int", min: 1, max: 20 }],
  },
];

export const GROUP_LABEL: Record<OperatorGroup, string> = {
  keys: "Schlüssel",
  time: "Zeit",
  and: "UND",
  or: "ODER",
  thresh: "Schwelle",
  wrap: "Wrapper",
};

export interface BuildParams {
  key?: string;
  keys?: string[];
  n?: number;
  k?: number;
  childCount?: number;
}

export function buildOperator(id: string, params: BuildParams): MsNode {
  switch (id) {
    case "pk":
      return { id: uid(), kind: "pk", key: params.key?.trim() || "A" };
    case "pkh":
      return { id: uid(), kind: "pkh", key: params.key?.trim() || "A" };
    case "multi": {
      const keys = (params.keys ?? ["A", "B", "C"]).map((k) => k.trim()).filter(Boolean);
      const k = Math.min(Math.max(params.k ?? 2, 1), Math.max(keys.length, 1));
      return { id: uid(), kind: "multi", k, keys: keys.length ? keys : ["A", "B"] };
    }
    case "older":
      return { id: uid(), kind: "older", n: clamp(params.n ?? 144, 1, 65535) };
    case "after":
      return { id: uid(), kind: "after", n: Math.max(params.n ?? 800000, 1) };
    case "and_v":
    case "and_b":
      return { id: uid(), kind: id, left: hole("sub.left"), right: hole("sub.right") };
    case "or_i":
    case "or_d":
    case "or_c":
    case "or_b":
      return { id: uid(), kind: id, left: hole("sub.branchA"), right: hole("sub.branchB") };
    case "andor":
      return { id: uid(), kind: "andor", x: hole("X"), y: hole("Y"), z: hole("Z") };
    case "thresh": {
      const count = Math.max(params.childCount ?? 3, 2);
      const k = clamp(params.k ?? 2, 1, count);
      return {
        id: uid(),
        kind: "thresh",
        k,
        children: Array.from({ length: count }, (_, i) => hole(`sub.branchN:${i + 1}`)),
      };
    }
    default:
      return hole();
  }
}

export function wrapNode(child: MsNode, wrap: WrapCode): MsNode {
  return { id: uid(), kind: "wrap", wrap, child };
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(n)));
}
