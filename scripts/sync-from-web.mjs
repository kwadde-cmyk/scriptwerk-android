#!/usr/bin/env node
/**
 * Pull feature code from scriptwerk-startos (web) and keep Android-only adapters.
 *
 * Web is the source of truth for UI / policy / wallet.
 * Android keeps native HTTP, Electrum TLS, USB polyfill, and Capacitor wiring.
 *
 * Overlay files (exist in both trees, Android wins): listed in OVERLAY.
 * Android-only files matching native-* / usb-polyfill* / usb-util.ts are auto-kept.
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEB = process.env.WEB_REPO || "https://github.com/kwadde-cmyk/scriptwerk-startos.git";
const WEB_REF = process.env.WEB_REF || "main";
const FORCE = process.env.FORCE_SYNC === "1";

const SHARED = ["src", "public", "migrations"];
const OVERLAY = [
  "src/lib/platform.ts",
  "src/lib/platform.test.ts",
  "src/lib/bitcoind/native-http.ts",
  "src/lib/bitcoind/native-electrum.ts",
  "src/lib/bitcoind/esplora.test.ts",
  "src/lib/hw/native-usb.ts",
  "src/lib/hw/usb-polyfill.ts",
  "src/lib/hw/usb-polyfill.test.ts",
  "src/lib/hw/usb-util.ts",
];

function sh(cmd, args, cwd = root) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8" }).trim();
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function copyTree(from, to) {
  rmSync(to, { recursive: true, force: true });
  for (const file of walk(from)) {
    const rel = relative(from, file);
    const dest = join(to, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(file, dest);
  }
}

function keepName(rel) {
  if (OVERLAY.includes(rel)) return true;
  const base = rel.replace(/^.*\//, "");
  return /^(native-.*|usb-polyfill.*|usb-util\.ts)$/.test(base);
}

function insertOnce(src, marker, haystack, replacement) {
  if (src.includes(marker)) return src;
  if (!src.includes(haystack)) return src;
  return src.replace(haystack, replacement);
}

function assertContains(file, needles) {
  const src = readFileSync(file, "utf8");
  const missing = needles.filter((n) => !src.includes(n));
  if (missing.length) {
    throw new Error(`[sync] ${relative(root, file)} missing: ${missing.join(", ")}`);
  }
}

function patchRpc(src) {
  let out = src;
  out = insertOnce(
    out,
    "nativeRpcAvailable",
    `export async function nodeFetch(url: string, init: RequestInit): Promise<Response> {
  const space = addressSpace(url);`,
    `export async function nodeFetch(url: string, init: RequestInit): Promise<Response> {
  const { nativeRpcAvailable, nativeHttp } = await import("./native-http.ts");
  if (nativeRpcAvailable()) {
    try {
      return await nativeHttp(url, init);
    } catch (err) {
      throw classifyFetchError(err);
    }
  }
  const space = addressSpace(url);`,
  );
  if (!out.includes("function classifyFetchError")) {
    out = insertOnce(
      out,
      "function classifyFetchError",
      `    throw first;
  }
}`,
      `    throw first;
  }
}

function classifyFetchError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/abort|timeout/i.test(msg)) return new Error("node.err.unreachable");
  return new Error("node.err.blocked");
}`,
    );
  }

  out = insertOnce(
    out,
    "nativeElectrumLookup",
    `async function electrumLookup(addresses: string[], server: string): Promise<UtxoScanResult> {
  const unique = [...new Set(addresses.filter(Boolean))];
  const res = await fetch("/electrum", {`,
    `async function electrumLookup(addresses: string[], server: string): Promise<UtxoScanResult> {
  const unique = [...new Set(addresses.filter(Boolean))];
  if (!server.trim()) throw new Error("hw.utxo.needElectrum");
  const { nativeRpcAvailable } = await import("./native-http.ts");
  if (nativeRpcAvailable()) {
    const { nativeElectrumLookup } = await import("./native-electrum.ts");
    return nativeElectrumLookup(unique, server);
  }
  const res = await fetch("/electrum", {`,
  );

  out = insertOnce(
    out,
    "nativeElectrumPing",
    `export async function fetchElectrumTip(server?: string): Promise<number> {
  const res = await fetch("/electrum", {`,
    `export async function probeElectrum(server: string, sniFallback?: string): Promise<{ version: string; host: string; port: number; cert?: string }> {
  const raw = server.trim();
  if (!raw) throw new Error("hw.utxo.needElectrum");
  const { nativeRpcAvailable, withDeadline } = await import("./native-http.ts");
  if (nativeRpcAvailable()) {
    const { nativeElectrumPing } = await import("./native-electrum.ts");
    return nativeElectrumPing(raw, sniFallback);
  }
  const res = await withDeadline(
    fetch("/electrum", {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ ping: true, server: raw }),
    }),
    8000,
    "hw.utxo.unreachable",
  );
  const body = (await res.json().catch(() => null)) as {
    result?: { version?: string; host?: string; port?: number };
    error?: { message?: string };
  } | null;
  if (body?.error?.message) throw new Error(body.error.message);
  if (!res.ok || !body?.result) throw new Error(body?.error?.message || "hw.utxo.needElectrum");
  return {
    version: String(body.result.version || "server.version"),
    host: String(body.result.host || raw),
    port: Number(body.result.port) || 0,
  };
}

export async function fetchElectrumTip(server?: string): Promise<number> {
  const raw = (server ?? "").trim();
  if (!raw) throw new Error("hw.utxo.needElectrum");
  const { nativeRpcAvailable } = await import("./native-http.ts");
  if (nativeRpcAvailable()) {
    const { nativeElectrumTip } = await import("./native-electrum.ts");
    return nativeElectrumTip(raw);
  }
  const res = await fetch("/electrum", {`,
  );
  return out;
}

function patchElectrum(src) {
  if (src.includes("nativeIndexerHostAllowed")) return src;
  return `${src.trimEnd()}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\\[|\\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0";
}

export function isPrivateIpv4(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\\[|\\]$/g, "");
  if (/^10(?:\\.\\d{1,3}){3}$/.test(h)) return true;
  if (/^192\\.168(?:\\.\\d{1,3}){2}$/.test(h)) return true;
  if (/^172\\.(1[6-9]|2\\d|3[01])(?:\\.\\d{1,3}){2}$/.test(h)) return true;
  return false;
}

export function isPublicIndexerHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\\[|\\]$/g, "").replace(/\\.$/, "");
  if (!h) return false;
  return (
    h === "mempool.space" ||
    h.endsWith(".mempool.space") ||
    h === "blockstream.info" ||
    h.endsWith(".blockstream.info")
  );
}

export function indexerHostAllowed(host: string, envUrl = ""): boolean {
  return electrumHostAllowed(host, envUrl) && !isPublicIndexerHost(host);
}

export function nativeIndexerHostAllowed(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\\[|\\]$/g, "");
  if (!h) return false;
  if (isPublicIndexerHost(h) || isLoopbackHost(h)) return false;
  if (/^\\d{1,3}(?:\\.\\d{1,3}){3}$/.test(h)) return isPrivateIpv4(h);
  return true;
}

export function formatElectrumVersion(raw: unknown): string {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean).join(" ");
  if (raw == null) return "";
  return String(raw);
}
`;
}

function patchTypes(src) {
  let out = src;
  if (!out.includes("hasWebHid")) {
    out = insertOnce(
      out,
      'from "../platform.ts"',
      `import type { Bip388Policy } from "@/lib/miniscript/bip388";`,
      `import type { Bip388Policy } from "@/lib/miniscript/bip388";
import { hasWebHid, isFramed } from "../platform.ts";`,
    );
    out = insertOnce(
      out,
      "hasWebHid()",
      `export function detectHid(): HidSupport {
  if (typeof navigator === "undefined" || !("hid" in navigator) || !navigator.hid) return "missing";
  try {
    if (window.self !== window.top) return "iframe";
  } catch {
    return "iframe";
  }
  return "ok";
}`,
      `export function detectHid(): HidSupport {
  if (typeof window === "undefined") return "missing";
  if (isFramed()) return "iframe";
  if (hasWebHid()) return "ok";
  if (typeof navigator === "undefined" || !("hid" in navigator) || !navigator.hid) return "missing";
  try {
    if (window.self !== window.top) return "iframe";
  } catch {
    return "iframe";
  }
  return "ok";
}`,
    );
  }
  return out;
}

function patchHwImport(src) {
  let out = src;
  if (!out.includes("installNativeUsbPolyfill")) {
    out = insertOnce(
      out,
      "installNativeUsbPolyfill",
      `from "./types.ts";`,
      `from "./types.ts";
import { installNativeUsbPolyfill } from "./native-usb.ts";`,
    );
  }
  out = insertOnce(
    out,
    "await installNativeUsbPolyfill()",
    `  await ensureBuffer();\n`,
    `  await ensureBuffer();\n  await installNativeUsbPolyfill();\n`,
  );
  out = insertOnce(
    out,
    "await installNativeUsbPolyfill()",
    `  const bitbox: BitboxMod = await import("bitbox-api");`,
    `  await installNativeUsbPolyfill();\n  const bitbox: BitboxMod = await import("bitbox-api");`,
  );
  return out;
}

function patchDiagnose(src) {
  if (src.includes("nativeRpcAvailable")) return src;
  return insertOnce(
    src,
    "nativeRpcAvailable",
    `  try {
    await nodeFetch(url, {`,
    `  const { nativeRpcAvailable } = await import("./native-http.ts");
  const native = nativeRpcAvailable();
  if (native) {
    steps.push({ id: "http", status: "ok", detail: "nativer HTTP — kein CORS, keine Brücke" });
  }

  try {
    await nodeFetch(url, {`,
  );
}

function patchStore(src) {
  let out = src;
  if (!out.includes("skipNodeBridge")) {
    out = insertOnce(
      out,
      "skipNodeBridge",
      `        if (await hostProxyAvailable()) {`,
      `        const { nativeRpcAvailable, skipNodeBridge, withDeadline } = await import("@/lib/bitcoind/native-http");
        if (skipNodeBridge()) {
          const native = nativeRpcAvailable();
          const nodeUrl = normalizeRpcUrl(creds.url, network);
          try {
            const probe = await withDeadline(
              probeNode({ url: nodeUrl, username: creds.username, password: creds.password }),
              10000,
              native ? "node.err.blockedPhone" : "node.err.phoneNoBridge",
            );
            set({
              status: "ready",
              probe,
              demo: false,
              error: null,
              bridge: "off",
              trace: {
                url: nodeUrl,
                origin: typeof location !== "undefined" ? location.origin : "",
                space: "local",
                ok: true,
                probe,
                steps: [
                  { id: "url", status: "ok", detail: nodeUrl },
                  { id: "http", status: "ok", detail: native ? "nativer HTTP" : "direkt (keine Brücke)" },
                  { id: "rpc", status: "ok", detail: probe.subversion || "getnetworkinfo" },
                ],
              },
            });
            return;
          } catch (e) {
            const msg = e instanceof Error ? e.message : "node.err.blockedPhone";
            set({
              status: "error",
              probe: null,
              bridge: "off",
              error: native ? "node.err.blockedPhone" : msg,
            });
            return;
          }
        }
        if (await hostProxyAvailable()) {`,
    );
  }
  return out;
}

function upsertI18n(src, key, de, en, beforeKey) {
  const needle = `  "${beforeKey}":`;
  const first = src.indexOf(needle);
  const second = first >= 0 ? src.indexOf(needle, first + needle.length) : -1;
  if (first < 0 || second < 0) return src;
  const lineRe = new RegExp(`  "${key.replace(/\\./g, "\\\\.")}": ".*",\\n`, "g");
  let out = src.replace(lineRe, "");
  const f = out.indexOf(needle);
  const s = out.indexOf(needle, f + needle.length);
  if (f < 0 || s < 0) return src;
  out = out.slice(0, s) + `  "${key}": "${en}",\n` + out.slice(s);
  out = out.slice(0, f) + `  "${key}": "${de}",\n` + out.slice(f);
  return out;
}

function patchI18n(src) {
  let out = src;
  const hw = [
    [
      "hw.utxo.noPublic",
      "Kein öffentlicher Indexer. Fulcrum oder Electrs im Heimnetz.",
      "No public indexer. Use Fulcrum or Electrs on the LAN.",
    ],
    [
      "hw.utxo.plugin",
      "Electrum-Plugin antwortet nicht. APK deinstallieren und neu sideloaden.",
      "Electrum plugin did not answer. Uninstall the APK and sideload again.",
    ],
    [
      "hw.utxo.loopback",
      "127.0.0.1 ist das Telefon, nicht Fulcrum. LAN-IP der Box eintragen.",
      "127.0.0.1 is the phone, not Fulcrum. Enter the box LAN IP.",
    ],
  ];
  for (const [key, de, en] of hw) {
    out = upsertI18n(out, key, de, en, "hw.utxo.needElectrum");
  }
  const node = [
    [
      "node.err.blockedPhone",
      "Node nicht erreichbar. LAN-IP der Core eintragen (nicht 127.0.0.1). StartOS: .local und Root-CA auf dem Telefon.",
      "Node unreachable. Enter the Core LAN IP (not 127.0.0.1). StartOS: .local address and root CA on the phone.",
    ],
    [
      "node.err.phoneNoBridge",
      "Direktverbindung ohne Brücke fehlgeschlagen.",
      "Direct connection without a bridge failed.",
    ],
  ];
  for (const [key, de, en] of node) {
    out = upsertI18n(out, key, de, en, "node.err.blocked");
  }
  return out;
}

function mergePackage(webPkg, androidPkg) {
  const capDeps = {};
  const capDev = {};
  for (const [k, v] of Object.entries(androidPkg.dependencies || {})) {
    if (k.startsWith("@capacitor/")) capDeps[k] = v;
  }
  for (const [k, v] of Object.entries(androidPkg.devDependencies || {})) {
    if (k.startsWith("@capacitor/")) capDev[k] = v;
  }
  return {
    ...webPkg,
    name: androidPkg.name || webPkg.name,
    scripts: {
      ...webPkg.scripts,
      "build:apk-web": "node scripts/with-app-env.mjs npx vite build --config vite.apk.config.ts",
      "build:apk": "node scripts/build-apk.mjs",
      "sync:web": "node scripts/sync-from-web.mjs",
    },
    dependencies: { ...webPkg.dependencies, ...capDeps },
    devDependencies: { ...webPkg.devDependencies, ...capDev },
  };
}

function readPrevSha() {
  const p = join(root, ".web-upstream");
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf8").trim().split("\n")[0] || "";
}

function webVersion(webRoot) {
  const pkgPath = join(webRoot, "deploy/startos/package.json");
  if (existsSync(pkgPath)) {
    const v = JSON.parse(readFileSync(pkgPath, "utf8")).version;
    if (typeof v === "string" && v.trim()) return v.trim().split(":")[0];
  }
  try {
    const msg = sh("git", ["log", "-1", "--pretty=%s"], webRoot);
    const m = msg.match(/^(\d+\.\d+\.\d+)/);
    if (m) return m[1];
  } catch {
    /* ignore */
  }
  return "0.0.0";
}

function bumpAndroidVersion(versionName, shaChanged) {
  const gradle = join(root, "android/app/build.gradle");
  if (!existsSync(gradle)) return { code: 0, name: versionName };
  let g = readFileSync(gradle, "utf8");
  const m = g.match(/versionCode\s+(\d+)/);
  const current = m ? Number(m[1]) : 1;
  const code = shaChanged ? current + 1 : current;
  g = g.replace(/versionCode\s+\d+/, `versionCode ${code}`);
  g = g.replace(/versionName\s+"[^"]+"/, `versionName "${versionName}"`);
  writeFileSync(gradle, g);
  return { code, name: versionName };
}

const tmp = mkdtempSync(join(tmpdir(), "scriptwerk-web-"));
try {
  console.log(`[sync] clone ${WEB} @ ${WEB_REF}`);
  sh("git", ["clone", "--depth", "1", "--branch", WEB_REF, WEB, tmp]);
  const webSha = sh("git", ["rev-parse", "HEAD"], tmp);
  const prevSha = readPrevSha();
  const shaChanged = webSha !== prevSha;
  if (!shaChanged && !FORCE) {
    console.log(`[sync] already at web ${webSha.slice(0, 7)} — nothing to do`);
    process.exit(0);
  }

  const overlayDir = join(tmp, ".android-overlay");
  mkdirSync(overlayDir, { recursive: true });
  const keep = new Set(OVERLAY);
  for (const dir of SHARED) {
    const localDir = join(root, dir);
    for (const file of walk(localDir)) {
      const rel = join(dir, relative(localDir, file));
      if (keepName(rel)) keep.add(rel);
    }
  }
  for (const rel of keep) {
    const src = join(root, rel);
    if (!existsSync(src)) continue;
    const dest = join(overlayDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }

  for (const dir of SHARED) {
    const from = join(tmp, dir);
    if (!existsSync(from)) continue;
    console.log(`[sync] copy ${dir}/`);
    copyTree(from, join(root, dir));
  }

  for (const rel of keep) {
    const src = join(overlayDir, rel);
    if (!existsSync(src)) continue;
    const dest = join(root, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }

  const rpcPath = join(root, "src/lib/bitcoind/rpc.ts");
  writeFileSync(rpcPath, patchRpc(readFileSync(rpcPath, "utf8")));
  const elPath = join(root, "src/lib/electrum.ts");
  writeFileSync(elPath, patchElectrum(readFileSync(elPath, "utf8")));
  const typesPath = join(root, "src/lib/hw/types.ts");
  if (existsSync(typesPath)) writeFileSync(typesPath, patchTypes(readFileSync(typesPath, "utf8")));
  for (const f of ["src/lib/hw/ledger.ts", "src/lib/hw/bitbox.ts"]) {
    const p = join(root, f);
    if (existsSync(p)) writeFileSync(p, patchHwImport(readFileSync(p, "utf8")));
  }
  const diag = join(root, "src/lib/bitcoind/diagnose.ts");
  if (existsSync(diag)) writeFileSync(diag, patchDiagnose(readFileSync(diag, "utf8")));
  const store = join(root, "src/store/bitcoind.ts");
  if (existsSync(store)) writeFileSync(store, patchStore(readFileSync(store, "utf8")));
  const i18n = join(root, "src/lib/i18n.ts");
  if (existsSync(i18n)) writeFileSync(i18n, patchI18n(readFileSync(i18n, "utf8")));

  const webPkg = JSON.parse(readFileSync(join(tmp, "package.json"), "utf8"));
  const androidPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  writeFileSync(join(root, "package.json"), `${JSON.stringify(mergePackage(webPkg, androidPkg), null, 2)}\n`);
  if (existsSync(join(tmp, "tsconfig.json"))) {
    copyFileSync(join(tmp, "tsconfig.json"), join(root, "tsconfig.json"));
  }

  const versionName = webVersion(tmp);
  const ver = bumpAndroidVersion(versionName, shaChanged);
  writeFileSync(join(root, ".web-upstream"), `${webSha}\n${WEB_REF}\n`);

  assertContains(rpcPath, ["nativeRpcAvailable", "nativeElectrumLookup", "nativeElectrumPing"]);
  assertContains(join(root, "src/store/bitcoind.ts"), ["skipNodeBridge"]);
  assertContains(join(root, "src/lib/hw/types.ts"), ["hasWebHid()"]);
  assertContains(join(root, "src/lib/hw/ledger.ts"), ["installNativeUsbPolyfill"]);
  assertContains(join(root, "src/lib/hw/bitbox.ts"), ["installNativeUsbPolyfill"]);
  for (const rel of ["src/lib/hw/usb-util.ts", "src/lib/hw/usb-polyfill.ts", "src/lib/bitcoind/native-http.ts"]) {
    if (!existsSync(join(root, rel))) throw new Error(`[sync] overlay missing after restore: ${rel}`);
  }

  console.log(
    `[sync] web ${webSha.slice(0, 7)} → APK ${ver.name} (${ver.code})${shaChanged ? "" : " [same sha, versionCode kept]"}`,
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
