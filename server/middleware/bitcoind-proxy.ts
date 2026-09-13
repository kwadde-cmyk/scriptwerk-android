import { bitcoindInfo, bitcoindUpstream, forwardBitcoindRpc } from "../../scripts/bitcoind-proxy.mjs";
import { electrumInfo, lookupElectrumPing, lookupElectrumTip, lookupElectrumUtxos } from "../../scripts/electrum-proxy.mjs";

interface ProxyEvent {
  url: URL;
  req: { method: string; json?: () => Promise<unknown>; text?: () => Promise<string> };
}

export default async function bitcoindProxyMiddleware(
  event: ProxyEvent,
  next: () => unknown | Promise<unknown>,
): Promise<unknown> {
  if (event.url.pathname === "/electrum/info") {
    return new Response(JSON.stringify(electrumInfo()), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  if (event.url.pathname === "/electrum/tip") {
    try {
      const out = await lookupElectrumTip("");
      return new Response(out.body, {
        status: out.status,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: { message: err instanceof Error ? err.message : "electrum failed" } }),
        { status: 502, headers: { "content-type": "application/json" } },
      );
    }
  }
  if (event.url.pathname === "/electrum") {
    const method = (event.req.method ?? "GET").toUpperCase();
    if (method === "GET" || method === "HEAD") {
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }
    if (method !== "POST") return new Response("POST only", { status: 405 });
    let parsed: { addresses?: string[]; server?: string; tip?: boolean; ping?: boolean } = {};
    try {
      if (typeof event.req.json === "function") parsed = (await event.req.json()) as typeof parsed;
      else if (typeof event.req.text === "function") parsed = JSON.parse((await event.req.text()) || "{}") as typeof parsed;
    } catch {
      return new Response(JSON.stringify({ error: { message: "invalid json" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    try {
      if (parsed.ping) {
        const out = await lookupElectrumPing(parsed.server);
        return new Response(out.body, {
          status: out.status,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      }
      if (parsed.tip) {
        const out = await lookupElectrumTip(parsed.server);
        return new Response(out.body, {
          status: out.status,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      }
      const out = await lookupElectrumUtxos(parsed.addresses, parsed.server);
      return new Response(out.body, {
        status: out.status,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: { message: err instanceof Error ? err.message : "electrum failed" } }),
        { status: 502, headers: { "content-type": "application/json" } },
      );
    }
  }
  if (event.url.pathname === "/bitcoind-rpc/info") {
    const info = bitcoindInfo();
    return new Response(JSON.stringify(info ?? { configured: false }), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  if (event.url.pathname !== "/bitcoind-rpc") return next();
  if (!bitcoindUpstream()) {
    const method = (event.req.method ?? "GET").toUpperCase();
    if (method === "GET" || method === "HEAD") {
      return new Response(JSON.stringify({ configured: false }), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }
    return new Response(JSON.stringify({ error: { message: "BITCOIND_RPC_URL unset" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  const method = (event.req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") {
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }
  if (method !== "POST") return new Response("POST only", { status: 405 });

  let parsed: { method?: string; params?: unknown[]; id?: unknown } = {};
  try {
    if (typeof event.req.json === "function") parsed = (await event.req.json()) as typeof parsed;
    else if (typeof event.req.text === "function") parsed = JSON.parse((await event.req.text()) || "{}") as typeof parsed;
  } catch {
    return new Response(JSON.stringify({ error: { message: "invalid json" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  try {
    const out = await forwardBitcoindRpc(parsed);
    return new Response(out.body, {
      status: out.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: { message: err instanceof Error ? err.message : "proxy failed" } }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
}
