/** Shared Bitcoin Core JSON-RPC proxy. Used by Nitro middleware and Vite. */

import { attachElectrumProxy } from "./electrum-proxy.mjs";

export function bitcoindUpstream() {
  const url = String(process.env.BITCOIND_RPC_URL ?? "").trim();
  return url ? url.replace(/\/+$/, "") : "";
}

export function bitcoindInfo() {
  const url = bitcoindUpstream();
  if (!url) return null;
  const pass = String(process.env.BITCOIND_RPC_PASSWORD ?? "").trim();
  const user = String(process.env.BITCOIND_RPC_USER ?? process.env.BITCOIND_RPC_USERNAME ?? "").trim();
  return {
    configured: true,
    url,
    user,
    password: pass,
    source: String(process.env.BITCOIND_RPC_SOURCE ?? "env").trim() || "env",
    locked: Boolean(pass || user),
    build: String(process.env.SCRIPTWERK_BUILD ?? "").trim(),
  };
}

/**
 * @param {{ method?: string, params?: unknown[], id?: unknown, auth?: { user?: string, username?: string, pass?: string, password?: string } }} input
 * @returns {Promise<{ status: number, body: string }>}
 */
export async function forwardBitcoindRpc(input) {
  const upstream = bitcoindUpstream();
  if (!upstream) {
    return { status: 404, body: JSON.stringify({ error: { code: -1, message: "BITCOIND_RPC_URL unset" } }) };
  }
  const method = String(input?.method ?? "");
  if (!method) {
    return { status: 400, body: JSON.stringify({ error: { code: -32600, message: "method required" } }) };
  }
  const fromForm = input?.auth && typeof input.auth === "object" ? input.auth : null;
  const envUser = String(process.env.BITCOIND_RPC_USER ?? process.env.BITCOIND_RPC_USERNAME ?? "").trim();
  const envPass = String(process.env.BITCOIND_RPC_PASSWORD ?? "").trim();
  const formUser = String(fromForm?.user ?? fromForm?.username ?? "").trim();
  const formPass = String(fromForm?.pass ?? fromForm?.password ?? "").trim();
  // Env wins. Browser/localStorage must not override the StartOS-injected password.
  const user = envUser || formUser;
  const pass = envPass || formPass;
  const payload = JSON.stringify({
    jsonrpc: "1.0",
    id: input?.id ?? 1,
    method,
    params: Array.isArray(input?.params) ? input.params : [],
  });
  /** @type {Record<string, string>} */
  const headers = { "Content-Type": "text/plain", Accept: "application/json" };
  if (user) {
    headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`;
  }
  const res = await fetch(upstream, { method: "POST", headers, body: payload });
  const text = await res.text();
  return { status: res.status, body: text || "{}" };
}

/**
 * @param {{ use: (fn: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next: () => void) => void) => void }} middlewares
 */
export function attachBitcoindProxy(middlewares) {
  attachElectrumProxy(middlewares);
  middlewares.use(async (req, res, next) => {
    const path = String(req.url ?? "").split("?")[0];
    if (path === "/bitcoind-rpc/info") {
      const info = bitcoindInfo();
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify(info ?? { configured: false }));
      return;
    }
    if (path !== "/bitcoind-rpc") {
      next();
      return;
    }
    const method = String(req.method ?? "GET").toUpperCase();
    if (!bitcoindUpstream()) {
      if (method === "GET" || method === "HEAD") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.setHeader("cache-control", "no-store");
        res.end(JSON.stringify({ configured: false }));
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { message: "BITCOIND_RPC_URL unset" } }));
      return;
    }
    if (method === "GET" || method === "HEAD") {
      res.statusCode = 204;
      res.setHeader("cache-control", "no-store");
      res.end();
      return;
    }
    if (method !== "POST") {
      res.statusCode = 405;
      res.end("POST only");
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let parsed = {};
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { message: "invalid json" } }));
      return;
    }
    try {
      const out = await forwardBitcoindRpc(parsed);
      res.statusCode = out.status;
      res.setHeader("content-type", "application/json");
      res.end(out.body);
    } catch (err) {
      res.statusCode = 502;
      res.end(JSON.stringify({ error: { message: err instanceof Error ? err.message : "proxy failed" } }));
    }
  });
}
