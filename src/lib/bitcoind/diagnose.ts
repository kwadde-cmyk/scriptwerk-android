import {
  addressSpace,
  isLanIpUrl,
  jsonRpcDirect,
  looksLikeStartos,
  nodeFetch,
  normalizeRpcUrl,
  splitCookie,
  type BitcoindConfig,
  type NodeProbe,
} from "./rpc.ts";

export type DiagStatus = "ok" | "fail" | "warn" | "skip";

export interface DiagStep {
  id: string;
  status: DiagStatus;
  detail: string;
}

export interface DiagReport {
  url: string;
  origin: string;
  space: string;
  steps: DiagStep[];
  ok: boolean;
  probe: NodeProbe | null;
}

function errText(err: unknown): string {
  if (err instanceof Error) {
    const extra = err.cause instanceof Error ? ` · ${err.cause.message}` : "";
    return `${err.name}: ${err.message}${extra}`.slice(0, 240);
  }
  return String(err).slice(0, 240);
}

export async function diagnoseNode(
  config: BitcoindConfig,
  network: "mainnet" = "mainnet",
): Promise<DiagReport> {
  const origin = typeof location !== "undefined" ? location.origin : "";
  const steps: DiagStep[] = [];
  let url = "";

  try {
    url = /^https?:\/\//i.test(config.url.trim())
      ? config.url.trim().replace(/\/+$/, "")
      : normalizeRpcUrl(config.url, network);
    const u = new URL(url);
    const ip = isLanIpUrl(url);
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    const startos = looksLikeStartos(url);
    steps.push({
      id: "url",
      status: ip && u.protocol === "https:" ? "warn" : "ok",
      detail: `${u.protocol}//${u.hostname}:${port} · ${ip ? "IP" : "Name"} · ${addressSpace(url)}${startos ? " · StartOS" : ""}`,
    });
  } catch (e) {
    steps.push({ id: "url", status: "fail", detail: errText(e) });
    return { url: config.url, origin, space: "", steps, ok: false, probe: null };
  }

  const auth = splitCookie(config.username, config.password);
  steps.push({
    id: "creds",
    status: auth.username && auth.password ? "ok" : "warn",
    detail: auth.username
      ? `${auth.username} / ${auth.password ? `•••• (${auth.password.length})` : "kein Passwort"}`
      : "kein Nutzer",
  });

  const { nativeRpcAvailable } = await import("./native-http.ts");
  const native = nativeRpcAvailable();

  if (native) {
    steps.push({ id: "http", status: "ok", detail: "nativer HTTP — kein CORS, keine Brücke" });
  } else if (typeof navigator !== "undefined" && navigator.permissions?.query) {
    try {
      const perm = await navigator.permissions.query({ name: "local-network-access" as PermissionName });
      steps.push({
        id: "lna",
        status: perm.state === "granted" ? "ok" : perm.state === "denied" ? "fail" : "warn",
        detail: perm.state,
      });
    } catch {
      steps.push({ id: "lna", status: "skip", detail: "API nicht vorhanden" });
    }
  } else {
    steps.push({ id: "lna", status: "skip", detail: "API nicht vorhanden" });
  }

  try {
    await nodeFetch(url, {
      method: "POST",
      mode: "no-cors",
      cache: "no-store",
      headers: { "Content-Type": "text/plain" },
      body: "{}",
      signal: AbortSignal.timeout(4000),
    });
    steps.push({ id: "reach", status: "ok", detail: native ? "TCP/TLS erreichbar" : "TCP/TLS erreichbar (opaque)" });
  } catch (e) {
    steps.push({ id: "reach", status: "fail", detail: errText(e) });
  }

  if (!native) {
    try {
      const res = await nodeFetch(url, {
        method: "GET",
        mode: "cors",
        cache: "no-store",
        signal: AbortSignal.timeout(4000),
      });
      const text = await res.text().catch(() => "");
      const onlyPost = /only POST/i.test(text);
      steps.push({
        id: "corsGet",
        status: onlyPost ? "skip" : "ok",
        detail: onlyPost
          ? `HTTP ${res.status} · bitcoind erlaubt nur POST (GET-Meldung ist normal)`
          : `HTTP ${res.status} · type=${res.type}`,
      });
    } catch (e) {
      steps.push({
        id: "corsGet",
        status: "skip",
        detail: `GET nicht lesbar (${errText(e)}) — bitcoind spricht nur POST, das ist erwartet`,
      });
    }

    try {
      const res = await nodeFetch(url, {
        method: "OPTIONS",
        mode: "cors",
        cache: "no-store",
        headers: {
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type",
        },
        signal: AbortSignal.timeout(4000),
      });
      const acao = res.headers.get("access-control-allow-origin");
      const acah = res.headers.get("access-control-allow-headers");
      const acam = res.headers.get("access-control-allow-methods");
      steps.push({
        id: "preflight",
        status: acao ? "ok" : "warn",
        detail: `HTTP ${res.status} · ACAO=${acao || "—"} · Headers=${acah || "—"} · Methods=${acam || "—"}`,
      });
    } catch (e) {
      steps.push({ id: "preflight", status: "fail", detail: errText(e) });
    }
  }

  let probe: NodeProbe | null = null;
  try {
    const net = (await jsonRpcDirect({ ...config, url }, "getnetworkinfo")) as {
      subversion?: string;
      version?: number;
    };
    let chain = "";
    let blocks = 0;
    try {
      const info = (await jsonRpcDirect({ ...config, url }, "getblockchaininfo")) as {
        chain?: string;
        blocks?: number;
      };
      chain = info.chain || "";
      blocks = info.blocks || 0;
    } catch (e) {
      steps.push({ id: "chain", status: "warn", detail: errText(e) });
    }
    probe = {
      subversion: net.subversion || "",
      version: net.version || 0,
      chain,
      blocks,
    };
    steps.push({
      id: "rpc",
      status: "ok",
      detail: `${net.subversion || "getnetworkinfo"} · ${chain || "?"} · ${blocks} Bl.`,
    });
  } catch (e) {
    try {
      await jsonRpcDirect({ ...config, url }, "getdescriptorinfo", [
        "pkh(0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798)",
      ]);
      probe = {
        subversion: looksLikeStartos(url) ? "/StartOS/" : "",
        version: 0,
        chain: "",
        blocks: 0,
      };
      steps.push({
        id: "rpc",
        status: "ok",
        detail: `getdescriptorinfo ok · getnetworkinfo: ${errText(e)}`,
      });
    } catch (e2) {
      steps.push({ id: "rpc", status: "fail", detail: errText(e2) });
    }
  }

  return {
    url,
    origin,
    space: addressSpace(url),
    steps,
    ok: steps.some((s) => s.id === "rpc" && s.status === "ok"),
    probe,
  };
}
