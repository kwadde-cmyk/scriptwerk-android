import { uid } from "../utils.ts";

export type WrapCode = "v" | "a" | "c" | "d" | "j" | "n" | "t" | "u" | "l" | "s";

export type MsNode =
  | { id: string; kind: "hole"; hint?: string }
  | { id: string; kind: "pk"; key: string }
  | { id: string; kind: "pkh"; key: string }
  | { id: string; kind: "multi"; k: number; keys: string[]; sorted?: boolean }
  | { id: string; kind: "thresh"; k: number; children: MsNode[] }
  | { id: string; kind: "older"; n: number }
  | { id: string; kind: "after"; n: number }
  | { id: string; kind: "and_v" | "and_b"; left: MsNode; right: MsNode }
  | { id: string; kind: "andor"; x: MsNode; y: MsNode; z: MsNode }
  | { id: string; kind: "or_i" | "or_d" | "or_c" | "or_b"; left: MsNode; right: MsNode }
  | { id: string; kind: "wrap"; wrap: WrapCode; child: MsNode };

export type BinaryKind = "and_v" | "and_b" | "or_i" | "or_d" | "or_c" | "or_b";

export function hole(hint?: string): MsNode {
  return { id: uid(), kind: "hole", hint };
}

export function isHole(n: MsNode): n is Extract<MsNode, { kind: "hole" }> {
  return n.kind === "hole";
}

export function visit(node: MsNode, fn: (n: MsNode) => void): void {
  fn(node);
  switch (node.kind) {
    case "thresh":
      node.children.forEach((c) => visit(c, fn));
      break;
    case "and_v":
    case "and_b":
    case "or_i":
    case "or_d":
    case "or_c":
    case "or_b":
      visit(node.left, fn);
      visit(node.right, fn);
      break;
    case "andor":
      visit(node.x, fn);
      visit(node.y, fn);
      visit(node.z, fn);
      break;
    case "wrap":
      visit(node.child, fn);
      break;
    default:
      break;
  }
}

export function findNode(root: MsNode, id: string): MsNode | null {
  let found: MsNode | null = null;
  visit(root, (n) => {
    if (n.id === id) found = n;
  });
  return found;
}

export function mapNode(root: MsNode, id: string, mapper: (n: MsNode) => MsNode): MsNode {
  if (root.id === id) return mapper(root);
  switch (root.kind) {
    case "thresh":
      return { ...root, children: root.children.map((c) => mapNode(c, id, mapper)) };
    case "and_v":
    case "and_b":
    case "or_i":
    case "or_d":
    case "or_c":
    case "or_b":
      return {
        ...root,
        left: mapNode(root.left, id, mapper),
        right: mapNode(root.right, id, mapper),
      };
    case "andor":
      return {
        ...root,
        x: mapNode(root.x, id, mapper),
        y: mapNode(root.y, id, mapper),
        z: mapNode(root.z, id, mapper),
      };
    case "wrap":
      return { ...root, child: mapNode(root.child, id, mapper) };
    default:
      return root;
  }
}

export function mapKeyStrings(node: MsNode, fn: (key: string) => string): MsNode {
  switch (node.kind) {
    case "pk":
    case "pkh":
      return { ...node, key: fn(node.key) };
    case "multi":
      return { ...node, keys: node.keys.map(fn) };
    case "thresh":
      return { ...node, children: node.children.map((c) => mapKeyStrings(c, fn)) };
    case "and_v":
    case "and_b":
    case "or_i":
    case "or_d":
    case "or_c":
    case "or_b":
      return { ...node, left: mapKeyStrings(node.left, fn), right: mapKeyStrings(node.right, fn) };
    case "andor":
      return {
        ...node,
        x: mapKeyStrings(node.x, fn),
        y: mapKeyStrings(node.y, fn),
        z: mapKeyStrings(node.z, fn),
      };
    case "wrap":
      return { ...node, child: mapKeyStrings(node.child, fn) };
    default:
      return node;
  }
}

export function collectKeys(root: MsNode): string[] {
  const set = new Set<string>();
  visit(root, (n) => {
    if (n.kind === "pk" || n.kind === "pkh") set.add(n.key);
    if (n.kind === "multi") n.keys.forEach((k) => set.add(k));
  });
  return [...set];
}

export function hasHoles(root: MsNode): boolean {
  let holes = false;
  visit(root, (n) => {
    if (n.kind === "hole") holes = true;
  });
  return holes;
}

export function coreOf(node: MsNode): MsNode {
  let cur = node;
  while (cur.kind === "wrap") cur = cur.child;
  return cur;
}

export function cloneWithIds(node: MsNode): MsNode {
  switch (node.kind) {
    case "hole":
      return { ...node, id: uid() };
    case "pk":
    case "pkh":
    case "older":
    case "after":
      return { ...node, id: uid() };
    case "multi":
      return { ...node, id: uid(), keys: [...node.keys] };
    case "thresh":
      return { ...node, id: uid(), children: node.children.map(cloneWithIds) };
    case "and_v":
    case "and_b":
    case "or_i":
    case "or_d":
    case "or_c":
    case "or_b":
      return { id: uid(), kind: node.kind, left: cloneWithIds(node.left), right: cloneWithIds(node.right) };
    case "andor":
      return {
        ...node,
        id: uid(),
        x: cloneWithIds(node.x),
        y: cloneWithIds(node.y),
        z: cloneWithIds(node.z),
      };
    case "wrap":
      return { id: uid(), kind: "wrap", wrap: node.wrap, child: cloneWithIds(node.child) };
  }
}
