/** Electrum TCP proxy for UTXO lookups. Browser cannot speak Electrum. */
// @ts-nocheck

import net from "node:net";
import tls from "node:tls";

export function electrumEnvUrl() {
  return String(process.env.ELECTRUM_URL ?? "").trim();
}

export function electrumInfo() {
  const url = electrumEnvUrl();
  const source = String(process.env.ELECTRUM_SOURCE ?? "").trim();
  if (!url) return { configured: false, url: "", locked: false, source: "" };
  return { configured: true, url, locked: true, source };
}

function parseTarget(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
      const u = new URL(text);
      const tlsOn = u.protocol === "ssl:" || u.protocol === "tls:" || u.protocol === "electrums:";
      const port = u.port ? Number(u.port) : tlsOn ? 50002 : 50001;
      if (!u.hostname || !Number.isFinite(port)) return null;
      return { host: u.hostname, port, tls: tlsOn };
    }
  } catch {
    return null;
  }
  const m = text.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
  if (!m) return null;
  const host = m[1].replace(/^\[|\]$/g, "");
  const port = m[2] ? Number(m[2]) : 50001;
  if (!host || !Number.isFinite(port)) return null;
  return { host, port, tls: port === 50002 };
}

function hostAllowed(host) {
  const h = String(host ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return false;
  if (h === "localhost" || h === "127.0.0.1" || h === "::1") return true;
  if (h.endsWith(".local") || h.endsWith(".lan")) return true;
  if (/^10(?:\.\d{1,3}){3}$/.test(h)) return true;
  if (/^192\.168(?:\.\d{1,3}){2}$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/.test(h)) return true;
  const env = parseTarget(electrumEnvUrl());
  return Boolean(env && env.host.toLowerCase() === h);
}

function hexToBytes(hex) {
  const h = hex.replace(/^0x/, "");
  const out = Buffer.from(h, "hex");
  return out;
}

function toHex(buf) {
  return Buffer.from(buf).toString("hex");
}

function scriptPubKeyFromAddress(addr) {
  const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  const BECH32M = 0x2bc830a3;
  const polymod = (values) => {
    let chk = 1;
    for (const v of values) {
      const b = chk >> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
    }
    return chk;
  };
  const raw = String(addr ?? "").trim();
  const pos = raw.lastIndexOf("1");
  if (pos < 1) throw new Error("bad address");
  const hrp = raw.slice(0, pos).toLowerCase();
  const body = raw.slice(pos + 1).toLowerCase();
  const data = [];
  for (const c of body) {
    const v = CHARSET.indexOf(c);
    if (v < 0) throw new Error("bad address");
    data.push(v);
  }
  const expand = [];
  for (const c of hrp) expand.push(c.charCodeAt(0) >> 5);
  expand.push(0);
  for (const c of hrp) expand.push(c.charCodeAt(0) & 31);
  const chk = polymod(expand.concat(data));
  if (chk !== 1 && chk !== BECH32M) throw new Error("bad address");
  const from = data.slice(1, -6);
  let acc = 0;
  let bits = 0;
  const conv = [];
  for (const value of from) {
    acc = (acc << 5) | value;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      conv.push((acc >> bits) & 255);
    }
  }
  const version = data[0];
  if (version === 0 && conv.length === 20) return `0014${toHex(conv)}`;
  if (version === 0 && conv.length === 32) return `0020${toHex(conv)}`;
  if (version === 1 && conv.length === 32) return `5120${toHex(conv)}`;
  throw new Error("bad address");
}

async function scripthash(addr) {
  const { createHash } = await import("node:crypto");
  const spk = scriptPubKeyFromAddress(addr);
  const hash = createHash("sha256").update(hexToBytes(spk)).digest();
  return Buffer.from(hash).reverse().toString("hex");
}

function formatVersion(raw) {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean).join(" ");
  if (raw == null) return "";
  return String(raw);
}

/**
 * @param {{ host: string, port: number, tls: boolean }} target
 * @param {{ method: string, params: unknown[] }[]} calls
 */
async function electrumBatch(target, calls, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const sock = target.tls
      ? tls.connect({ host: target.host, port: target.port, servername: target.host, rejectUnauthorized: false })
      : net.connect({ host: target.host, port: target.port });
    let buf = "";
    const pending = new Map();
    let nextId = 1;
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("hw.utxo.unreachable"));
    }, timeoutMs);
    const finish = (err, value) => {
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    sock.setEncoding("utf8");
    sock.on("error", (e) => finish(e));
    sock.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const slot = pending.get(msg.id);
        if (!slot) continue;
        pending.delete(msg.id);
        if (msg.error) slot.reject(new Error(msg.error.message || "electrum error"));
        else slot.resolve(msg.result);
      }
    });
    const onReady = () => {
      const send = (method, params) =>
        new Promise((res, rej) => {
          const id = nextId++;
          pending.set(id, { resolve: res, reject: rej });
          sock.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        });
      void (async () => {
        try {
          const hello = await send("server.version", ["Scriptwerk", "1.4"]);
          const out = [];
          for (const c of calls) out.push(await send(c.method, c.params));
          finish(null, { hello, results: out });
        } catch (e) {
          finish(e);
        }
      })();
    };
    if (target.tls) sock.once("secureConnect", onReady);
    else sock.once("connect", onReady);
  });
}

export async function lookupElectrumUtxos(addresses, serverFromClient) {
  const fromUi = parseTarget(serverFromClient);
  const env = parseTarget(electrumEnvUrl());
  const target = fromUi || env;
  if (!target) {
    return { status: 404, body: JSON.stringify({ error: { message: "hw.utxo.needElectrum" } }) };
  }
  if (!hostAllowed(target.host)) {
    return { status: 400, body: JSON.stringify({ error: { message: "hw.utxo.lanOnly" } }) };
  }
  const addrs = (Array.isArray(addresses) ? addresses : []).map(String).filter(Boolean).slice(0, 200);
  if (!addrs.length) {
    return { status: 400, body: JSON.stringify({ error: { message: "hw.utxo.none" } }) };
  }
  const hashes = [];
  for (const a of addrs) hashes.push({ address: a, scripthash: await scripthash(a) });
  const calls = [
    { method: "blockchain.headers.subscribe", params: [] },
    ...hashes.map((h) => ({
      method: "blockchain.scripthash.listunspent",
      params: [h.scripthash],
    })),
  ];
  const { results: rows } = await electrumBatch(target, calls);
  const head = rows[0];
  const chainHeight = Number(head && typeof head === "object" ? head.height : head) || 0;
  const unspents = [];
  let totalSats = 0;
  hashes.forEach((h, i) => {
    const list = Array.isArray(rows[i + 1]) ? rows[i + 1] : [];
    for (const u of list) {
      const sats = Number(u.value) || 0;
      totalSats += sats;
      unspents.push({
        txid: String(u.tx_hash ?? ""),
        vout: Number(u.tx_pos) || 0,
        amount: sats / 1e8,
        height: Number(u.height) || 0,
        address: h.address,
        desc: "",
      });
    }
  });
  return {
    status: 200,
    body: JSON.stringify({ result: { unspents, total: totalSats / 1e8, height: chainHeight } }),
  };
}

export async function lookupElectrumTip(serverFromClient) {
  const fromUi = parseTarget(serverFromClient);
  const env = parseTarget(electrumEnvUrl());
  const target = fromUi || env;
  if (!target) {
    return { status: 404, body: JSON.stringify({ error: { message: "hw.utxo.needElectrum" } }) };
  }
  if (!hostAllowed(target.host)) {
    return { status: 400, body: JSON.stringify({ error: { message: "hw.utxo.lanOnly" } }) };
  }
  const { results: rows } = await electrumBatch(target, [{ method: "blockchain.headers.subscribe", params: [] }], 4000);
  const head = rows[0];
  const height = Number(head && typeof head === "object" ? head.height : head) || 0;
  return {
    status: 200,
    body: JSON.stringify({ result: { height } }),
  };
}

export async function lookupElectrumPing(serverFromClient) {
  const fromUi = parseTarget(serverFromClient);
  const env = parseTarget(electrumEnvUrl());
  const target = fromUi || env;
  if (!target) {
    return { status: 404, body: JSON.stringify({ error: { message: "hw.utxo.needElectrum" } }) };
  }
  if (!hostAllowed(target.host)) {
    return { status: 400, body: JSON.stringify({ error: { message: "hw.utxo.lanOnly" } }) };
  }
  const { hello } = await electrumBatch(target, [], 8000);
  return {
    status: 200,
    body: JSON.stringify({ result: { version: formatVersion(hello) || "server.version", host: target.host, port: target.port } }),
  };
}

export function attachElectrumProxy(middlewares) {
  middlewares.use(async (req, res, next) => {
    const path = String(req.url ?? "").split("?")[0];
    if (path === "/electrum/info") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify(electrumInfo()));
      return;
    }
    if (path === "/electrum/tip") {
      const method = String(req.method ?? "GET").toUpperCase();
      if (method === "GET" || method === "HEAD") {
        try {
          const out = await lookupElectrumTip("");
          res.statusCode = out.status;
          res.setHeader("content-type", "application/json");
          res.setHeader("cache-control", "no-store");
          res.end(out.body);
        } catch (err) {
          res.statusCode = 502;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: { message: err instanceof Error ? err.message : "electrum failed" } }));
        }
        return;
      }
    }
    if (path !== "/electrum") {
      next();
      return;
    }
    const method = String(req.method ?? "GET").toUpperCase();
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
      if (parsed.ping) {
        const out = await lookupElectrumPing(parsed.server);
        res.statusCode = out.status;
        res.setHeader("content-type", "application/json");
        res.end(out.body);
        return;
      }
      if (parsed.tip) {
        const out = await lookupElectrumTip(parsed.server);
        res.statusCode = out.status;
        res.setHeader("content-type", "application/json");
        res.end(out.body);
        return;
      }
      const out = await lookupElectrumUtxos(parsed.addresses, parsed.server);
      res.statusCode = out.status;
      res.setHeader("content-type", "application/json");
      res.end(out.body);
    } catch (err) {
      res.statusCode = 502;
      res.end(JSON.stringify({ error: { message: err instanceof Error ? err.message : "electrum failed" } }));
    }
  });
}
