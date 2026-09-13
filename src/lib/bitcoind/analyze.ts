import { descsumCheck, descsumCreate } from "../miniscript/checksum.ts";

export interface DescriptorInfo {
  descriptor: string;
  checksum: string;
  isrange: boolean;
  issolvable: boolean;
  hasprivatekeys: boolean;
}

export interface AnalyzeResult {
  ok: boolean;
  info?: DescriptorInfo;
  error?: string;
}

const KEY_EXPR =
  /(?:xpub|tpub|ypub|zpub|vpub|Ypub|Zpub|Vpub|xprv|tprv)[1-9A-HJ-NP-Za-km-z]+|(?:02|03)[0-9a-fA-F]{64}/;

export function analyzeDescriptor(raw: string): AnalyzeResult {
  const text = raw.trim();
  if (!text) return { ok: false, error: "node.err.empty" };

  const hash = text.lastIndexOf("#");
  const body = hash >= 0 ? text.slice(0, hash) : text;
  if (hash >= 0 && !descsumCheck(text)) {
    return { ok: false, error: "node.err.checksum" };
  }
  if (!/^(wsh|tr|pkh|wpkh|sh|wsh|multi)\(/i.test(body)) {
    return { ok: false, error: "node.err.type" };
  }
  if (body.includes("/*?*/") || /\bhole\b/i.test(body)) {
    return { ok: false, error: "node.err.incomplete" };
  }

  const withCs = descsumCreate(body);
  const checksum = withCs.slice(withCs.lastIndexOf("#") + 1);
  const isrange = /\/\*|'\/\*|\/<\d+;\d+>\//.test(body);
  const hasprivatekeys = /\b[xt]prv|\b[5KL][1-9A-HJ-NP-Za-km-z]{50,52}\b/.test(body);
  const hasKey = KEY_EXPR.test(body);
  const leftoverAlias = /(?<![A-Za-z0-9_/[\]])[A-Z][A-Z0-9]{0,3}(?![A-Za-z0-9_])/.test(
    body.replace(/\[[^\]]*]/g, "").replace(KEY_EXPR, ""),
  );
  const issolvable = hasKey && !leftoverAlias;

  return {
    ok: true,
    info: {
      descriptor: withCs,
      checksum,
      isrange,
      issolvable,
      hasprivatekeys,
    },
  };
}
