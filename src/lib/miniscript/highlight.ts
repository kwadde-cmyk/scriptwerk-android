import type { KeyEntry } from "./keys.ts";
import { formatFingerprint } from "./keys.ts";
import type { Stage } from "./stages.ts";
import { checksumOf, CHILD_PATH_FORMS, rewriteDescriptorChildPath, stripChecksum } from "./checksum.ts";

export interface ScriptSpan {
  text: string;
  color: string;
  kind: "key" | "stage" | "paren" | "fn" | "checksum" | "plain";
}

export const KEY_PALETTE = ["#e8c27a", "#7db8c9", "#d4899a", "#8fba84", "#b89ad4", "#e0a06a", "#7d9b96", "#c45c4a"];
export const DEPTH_PALETTE = ["#ece8e1", "#7db8c9", "#e8c27a", "#d4899a", "#8fba84", "#b89ad4", "#e0a06a"];
export const STAGE_PALETTE = ["#7d9b96", "#c4a574", "#c45c4a", "#7db8c9"];

const ORIGIN_RE =
  /\[[0-9a-fA-F]{8}[^\]]*\](?:xpub|tpub|ypub|zpub|vpub|Ypub|Zpub|Vpub)[1-9A-HJ-NP-Za-km-z]+(?:\/(?:<[^>]+>|\d+)\/\*)?/y;
const FN_RE = /^(sortedmulti|multi|thresh|andor|and_v|and_b|or_i|or_d|or_c|or_b|older|after|pkh|pk|wsh|sh)\b/y;
const WRAP_RE = /^[ascdjnltuv]:/y;
const CS_RE = /#[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{8}$/;

export function descriptorChecksums(desc: string): { path: string; checksum: string }[] {
  const raw = stripChecksum(desc).trim();
  if (!raw) return [];
  const seen = new Set<string>();
  const out: { path: string; checksum: string }[] = [];
  const forms = /\/<\d+;\d+>\//.test(raw) || /\/\d+\/\*/.test(raw) ? CHILD_PATH_FORMS : ([""] as const);
  for (const form of forms) {
    const next = form ? rewriteDescriptorChildPath(desc, form) : descsumSafe(desc);
    const cs = checksumOf(next);
    if (!cs || seen.has(`${form}:${cs}`)) continue;
    seen.add(`${form}:${cs}`);
    out.push({ path: form, checksum: cs });
  }
  return out;
}

function descsumSafe(desc: string): string {
  const body = stripChecksum(desc);
  const cs = checksumOf(body);
  return cs ? `${body}#${cs}` : body;
}

export function peekScript(value: string, head = 42): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const m = flat.match(CS_RE);
  const cs = m ? m[0] : "";
  const body = cs ? flat.slice(0, -cs.length) : flat;
  if (body.length <= head) return flat;
  return `${body.slice(0, head)}…${cs}`;
}

export function keyColor(name: string, keys: KeyEntry[]): string {
  const masters = [...new Set(keys.map((k) => k.name).filter(Boolean))];
  const base = name.match(/^([A-Za-z_][A-Za-z_]*)/)?.[1] ?? name;
  const i = Math.max(0, masters.indexOf(base));
  return KEY_PALETTE[i % KEY_PALETTE.length]!;
}

function fpColor(fp: string, keys: KeyEntry[]): string | null {
  const needle = formatFingerprint(fp);
  const hit = keys.find((k) => formatFingerprint(k.fingerprint) === needle);
  return hit ? keyColor(hit.name, keys) : null;
}

function stageColor(delay: number, stages: Stage[]): string {
  const delays = [...new Set(stages.map((s) => s.delay))].sort((a, b) => a - b);
  const i = delays.indexOf(delay);
  return STAGE_PALETTE[(i < 0 ? 0 : i) % STAGE_PALETTE.length]!;
}

export function highlightScript(src: string, keys: KeyEntry[] = [], stages: Stage[] = []): ScriptSpan[] {
  const out: ScriptSpan[] = [];
  let i = 0;
  const n = src.length;
  const aliases = [...keys.map((k) => k.name), ...keys.flatMap((k) => {
    const extra: string[] = [];
    for (const c of k.children) {
      const m = c.path.match(/48'\/\d+'\/(\d+)'/);
      if (m && Number(m[1]) > 0) extra.push(`${k.name}${m[1]}`);
    }
    return extra;
  })]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const stack: string[] = [];
  let depth = 0;

  function push(text: string, color: string, kind: ScriptSpan["kind"]) {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.color === color && last.kind === kind) last.text += text;
    else out.push({ text, color, kind });
  }

  while (i < n) {
    if (src[i] === "#" && i === src.lastIndexOf("#") && /^#[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{8}$/.test(src.slice(i))) {
      push(src.slice(i), "#c4a574", "checksum");
      break;
    }

    ORIGIN_RE.lastIndex = i;
    const origin = ORIGIN_RE.exec(src);
    if (origin && origin.index === i) {
      const fp = origin[0].slice(1, 9);
      const color = fpColor(fp, keys) ?? KEY_PALETTE[Math.abs(hashStr(fp)) % KEY_PALETTE.length]!;
      push(origin[0], color, "key");
      i += origin[0].length;
      continue;
    }

    let aliasHit = "";
    for (const a of aliases) {
      if (src.startsWith(a, i) && !/[A-Za-z0-9_]/.test(src[i + a.length] ?? "")) {
        aliasHit = a;
        break;
      }
    }
    if (aliasHit) {
      push(aliasHit, keyColor(aliasHit, keys), "key");
      i += aliasHit.length;
      continue;
    }

    FN_RE.lastIndex = i;
    const fn = FN_RE.exec(src);
    if (fn && fn.index === i) {
      const name = fn[1]!;
      if (name === "older" || name === "after") {
        const rest = src.slice(i + name.length);
        const num = rest.match(/^\((\d+)\)/);
        if (num) {
          const delay = Number(num[1]);
          push(`${name}(${num[1]})`, stageColor(delay, stages), "stage");
          i += name.length + num[0].length;
          continue;
        }
      }
      push(name, "#9a958c", "fn");
      i += name.length;
      continue;
    }

    WRAP_RE.lastIndex = i;
    const wrap = WRAP_RE.exec(src);
    if (wrap && wrap.index === i) {
      push(wrap[0], "#6b6760", "fn");
      i += wrap[0].length;
      continue;
    }

    const ch = src[i]!;
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      const color = DEPTH_PALETTE[depth % DEPTH_PALETTE.length]!;
      stack.push(color);
      push(ch, color, "paren");
      i += 1;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      const color = stack.pop() ?? DEPTH_PALETTE[0]!;
      depth = Math.max(0, depth - 1);
      push(ch, color, "paren");
      i += 1;
      continue;
    }

    push(ch, "#ece8e1", "plain");
    i += 1;
  }
  return out;
}

function hashStr(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}
