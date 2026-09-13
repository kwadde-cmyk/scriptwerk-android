import type { MsNode } from "./ast.ts";
import { nodeSubtitle, nodeTitle } from "./explain.ts";
import { t, type Locale } from "../i18n.ts";

export interface LayoutBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  subtitle: string;
  kind: MsNode["kind"];
  hole: boolean;
}

export interface LayoutEdge {
  from: string;
  to: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  label?: string;
}

export interface Layout {
  boxes: LayoutBox[];
  edges: LayoutEdge[];
  width: number;
  height: number;
}

const NW = 176;
const NH = 56;
const WRAP_H = 26;
const WRAP_GY = 8;
const GX = 28;
const GY = 56;

interface Measured {
  node: MsNode;
  w: number;
  h: number;
  boxH: number;
  gap: number;
  kids: Measured[];
}

function kidsOf(n: MsNode): MsNode[] {
  switch (n.kind) {
    case "thresh":
      return n.children;
    case "and_v":
    case "and_b":
    case "or_i":
    case "or_d":
    case "or_c":
    case "or_b":
      return [n.left, n.right];
    case "andor":
      return [n.x, n.y, n.z];
    case "wrap":
      return [n.child];
    default:
      return [];
  }
}

function edgeLabel(parent: MsNode, index: number, locale: Locale): string | undefined {
  if (parent.kind === "and_v" || parent.kind === "and_b") return t(locale, "edge.and");
  if (parent.kind === "or_i" || parent.kind === "or_d" || parent.kind === "or_c" || parent.kind === "or_b") {
    return t(locale, "edge.or");
  }
  if (parent.kind === "andor") return index === 2 ? t(locale, "edge.else") : index === 0 ? "X" : "Y";
  return undefined;
}

function measure(n: MsNode): Measured {
  const kids = kidsOf(n).map(measure);
  const kidsW = kids.reduce((s, k) => s + k.w, 0) + GX * Math.max(0, kids.length - 1);
  const kidsH = kids.reduce((m, k) => Math.max(m, k.h), 0);
  const boxH = n.kind === "wrap" ? WRAP_H : NH;
  const gap = n.kind === "wrap" ? WRAP_GY : GY;
  const w = Math.max(NW, kidsW);
  const h = boxH + (kids.length ? gap + kidsH : 0);
  return { node: n, w, h, boxH, gap, kids };
}

function place(
  m: Measured,
  x: number,
  y: number,
  boxes: LayoutBox[],
  edges: LayoutEdge[],
  locale: Locale,
) {
  const boxX = x + (m.w - NW) / 2;
  boxes.push({
    id: m.node.id,
    x: boxX,
    y,
    w: NW,
    h: m.boxH,
    title: nodeTitle(m.node, locale),
    subtitle: nodeSubtitle(m.node, locale),
    kind: m.node.kind,
    hole: m.node.kind === "hole",
  });
  const childY = y + m.boxH + m.gap;
  let cx =
    x + (m.w - (m.kids.reduce((s, k) => s + k.w, 0) + GX * Math.max(0, m.kids.length - 1))) / 2;
  m.kids.forEach((k, i) => {
    const kx = cx + (k.w - NW) / 2;
    edges.push({
      from: m.node.id,
      to: k.node.id,
      x1: boxX + NW / 2,
      y1: y + m.boxH,
      x2: kx + NW / 2,
      y2: childY,
      label: m.node.kind === "wrap" ? undefined : edgeLabel(m.node, i, locale),
    });
    place(k, cx, childY, boxes, edges, locale);
    cx += k.w + GX;
  });
}

export function layoutTree(root: MsNode | null, locale: Locale = "de"): Layout {
  if (!root) return { boxes: [], edges: [], width: 320, height: 200 };
  const m = measure(root);
  const boxes: LayoutBox[] = [];
  const edges: LayoutEdge[] = [];
  place(m, 24, 20, boxes, edges, locale);
  return { boxes, edges, width: m.w + 48, height: m.h + 40 };
}
