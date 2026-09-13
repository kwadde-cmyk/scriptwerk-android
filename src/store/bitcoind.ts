import { create } from "zustand";
import { persist } from "zustand/middleware";
import { analyzeDescriptor } from "@/lib/bitcoind/analyze";
import { diagnoseNode, type DiagReport, type DiagStep } from "@/lib/bitcoind/diagnose";
import { corsBlocked } from "@/lib/bitcoind/bridge";
import {
  normalizeRpcUrl,
  probeElectrum,
  probeNode,
  scanWatchWallet,
  validateOnNode,
  type NodeProbe,
  type NodeValidateResult,
} from "@/lib/bitcoind/rpc";
import { clampUtxoCount, mergeWatchSnapshots, UTXO_SCAN_CAP, type WatchSnapshot } from "@/lib/hw/address-check";
import { checksumOf } from "@/lib/miniscript/checksum";
import { parseElectrumUrl } from "@/lib/electrum";
import { withDeadline } from "@/lib/bitcoind/native-http";



export interface NodeCheck extends NodeValidateResult {
  source: "demo" | "core";
}

interface BitcoindState {
  url: string;
  username: string;
  password: string;
  electrum: string;
  kind: "core" | "startos";
  demo: boolean;
  open: boolean;
  status: "idle" | "connecting" | "ready" | "error";
  bridge: "off" | "needed" | "on";
  probe: NodeProbe | null;
  trace: DiagReport | null;
  lastCheck: NodeCheck | null;
  lastUtxo: { height: number; coins: { height: number; amount: number }[] } | null;
  lastWatch: WatchSnapshot | null;
  error: string | null;
  checking: boolean;
  scanningWatch: boolean;
  setOpen: (open: boolean) => void;
  patch: (p: Partial<Pick<BitcoindState, "url" | "username" | "password" | "kind" | "electrum">>) => void;
  connectDemo: () => void;
  connectLive: (network?: "mainnet") => Promise<void>;
  finishBridge: () => Promise<void>;
  disconnect: () => void;
  validate: (descriptor: string, network?: "mainnet") => Promise<void>;
  scanWatch: (descriptor: string, opts?: { count?: number }) => Promise<WatchSnapshot | null>;
  setLastUtxo: (u: { height: number; coins: { height: number; amount: number }[] } | null) => void;
  setLastWatch: (w: WatchSnapshot | null) => void;
}

const DEMO_PROBE: NodeProbe = {
  subversion: "/Scriptwerk-demo:28.0.0/",
  version: 280000,
  chain: "demo",
  blocks: 0,
};

let finishLock: Promise<void> | null = null;
let connectGen = 0;

function phoneConnectError(err: unknown, native: boolean): string {
  const msg = err instanceof Error ? err.message : "";
  if (msg === "node.err.auth" || msg === "node.err.http") return msg;
  if (native) {
    if (msg === "node.err.unreachable" || msg === "node.err.blocked") return "node.err.blockedPhone";
    return msg.startsWith("node.err.") ? msg : "node.err.blockedPhone";
  }
  return "node.err.phoneNoBridge";
}

async function electrumStep(server: string): Promise<DiagStep> {
  const raw = server.trim();
  if (!raw) {
    return { id: "electrum", status: "warn", detail: "hw.utxo.needElectrum" };
  }
  const target = parseElectrumUrl(raw);
  const where = target ? `${target.tls ? "ssl" : "tcp"} ${target.host}:${target.port}` : raw;
  try {
    const info = await probeElectrum(raw);
    const ver = info.version || "server.version";
    return { id: "electrum", status: "ok", detail: `${info.host}:${info.port} · ${ver}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "hw.utxo.bad";
    return { id: "electrum", status: "fail", detail: `${msg} · ${where}` };
  }
}

function indexerPlaceholder(server: string): DiagStep {
  const raw = server.trim();
  if (!raw) return { id: "electrum", status: "warn", detail: "hw.utxo.needElectrum" };
  const target = parseElectrumUrl(raw);
  const where = target ? `${target.tls ? "ssl" : "tcp"} ${target.host}:${target.port}` : raw;
  if (!target) return { id: "electrum", status: "fail", detail: `hw.utxo.needElectrum · ${raw}` };
  return { id: "electrum", status: "skip", detail: `${where} · ElectrumHost TLS` };
}

function keepElectrum(steps: DiagStep[], get: () => BitcoindState): DiagStep[] {
  const current = get().trace?.steps.find((s) => s.id === "electrum");
  const keep = current && current.status !== "skip" ? current : current ?? indexerPlaceholder(get().electrum);
  return [...steps.filter((s) => s.id !== "electrum"), keep];
}

function applyIndexer(gen: number, step: DiagStep, set: (p: Partial<BitcoindState>) => void, get: () => BitcoindState) {
  if (gen !== connectGen) return;
  const st = get();
  if (!st.trace) return;
  set({
    trace: { ...st.trace, steps: [...st.trace.steps.filter((s) => s.id !== "electrum"), step] },
    error: step.status === "fail" && (st.status === "ready" || st.status === "error") ? step.detail : st.error,
  });
}

function followIndexer(gen: number, server: string, set: (p: Partial<BitcoindState>) => void, get: () => BitcoindState) {
  if (!server.trim()) return;
  void withDeadline(electrumStep(server), 14000, "hw.utxo.unreachable")
    .catch((e: unknown) => {
      const target = parseElectrumUrl(server);
      const where = target ? `${target.host}:${target.port}` : server.trim();
      const msg = e instanceof Error ? e.message : "hw.utxo.unreachable";
      return { id: "electrum", status: "fail" as const, detail: `${msg} · ${where}` };
    })
    .then((step) => applyIndexer(gen, step, set, get));
}

export const useBitcoind = create<BitcoindState>()(
  persist(
    (set, get) => ({
      url: "127.0.0.1",
      username: "",
      password: "",
      electrum: "",
      kind: "core",
      demo: false,
      open: false,
      status: "idle",
      bridge: "off",
      probe: null,
      trace: null,
      lastCheck: null,
      lastUtxo: null,
      lastWatch: null,
      error: null,
      checking: false,
      scanningWatch: false,
      setOpen: (open) => set({ open }),
      patch: (p) => set(p),
      connectDemo: () =>
        set({
          demo: true,
          status: "ready",
          probe: DEMO_PROBE,
          error: null,
          trace: null,
          bridge: "off",
        }),
      connectLive: async (network = "mainnet") => {
        const gen = ++connectGen;
        const { url, username, password, electrum } = get();
        const creds = {
          url: url.trim(),
          username: username.trim(),
          password: password.trim(),
        };
        if (creds.url !== url || creds.username !== username || creds.password !== password) {
          set(creds);
        }
        const { setBridgeAuth } = await import("@/lib/bitcoind/bridge");
        setBridgeAuth(creds.username, creds.password);
        const origin = typeof location !== "undefined" ? location.origin : "";
        const nodeUrl = normalizeRpcUrl(creds.url, network);
        set({
          status: "connecting",
          error: null,
          demo: false,
          lastCheck: null,
          bridge: "off",
          checking: false,
          trace: {
            url: nodeUrl,
            origin,
            space: "local",
            ok: false,
            probe: null,
            steps: [
              { id: "url", status: "ok", detail: nodeUrl },
              indexerPlaceholder(electrum),
            ],
          },
        });
        followIndexer(gen, electrum, set, get);
        const watchdog = setTimeout(() => {
          if (gen !== connectGen) return;
          if (get().status !== "connecting") return;
          set({
            status: "error",
            probe: null,
            error: "node.err.blockedPhone",
            trace: {
              url: nodeUrl,
              origin,
              space: "local",
              ok: false,
              probe: null,
              steps: keepElectrum([{ id: "rpc", status: "fail", detail: "node.err.blockedPhone" }], get),
            },
          });
        }, 12000);
        try {
        const { hostProxyAvailable } = await import("@/lib/bitcoind/rpc");
        const { withDeadline } = await import("@/lib/bitcoind/native-http");
        if (await hostProxyAvailable()) {
          try {
            const probe = await withDeadline(
              probeNode({
                url: nodeUrl,
                username: creds.username,
                password: creds.password,
              }),
              10000,
              "node.err.unreachable",
            );
            if (gen !== connectGen) return;
            set({
              status: "ready",
              probe,
              demo: false,
              error: null,
              bridge: "off",
              trace: {
                url: "same-origin /bitcoind-rpc",
                origin,
                space: "local",
                ok: true,
                probe,
                steps: keepElectrum([{ id: "rpc", status: "ok", detail: "Server-Proxy" }], get),
              },
            });
            return;
          } catch (e) {
            if (gen !== connectGen) return;
            const msg = e instanceof Error ? e.message : "node.err.unreachable";
            set({
              status: "error",
              probe: null,
              error: msg,
              trace: {
                url: nodeUrl,
                origin,
                space: "local",
                ok: false,
                probe: null,
                steps: keepElectrum([{ id: "rpc", status: "fail", detail: msg }], get),
              },
            });
            return;
          }
        }
        const { nativeRpcAvailable, skipNodeBridge } = await import("@/lib/bitcoind/native-http");
        if (skipNodeBridge()) {
          const native = nativeRpcAvailable();
          const cfg = {
            url: nodeUrl,
            username: creds.username,
            password: creds.password,
          };
          try {
            const probe = await withDeadline(
              probeNode(cfg),
              10000,
              native ? "node.err.blockedPhone" : "node.err.phoneNoBridge",
            );
            if (gen !== connectGen) return;
            set({
              status: "ready",
              probe,
              demo: false,
              error: null,
              bridge: "off",
              trace: {
                url: cfg.url,
                origin,
                space: "local",
                ok: true,
                probe,
                steps: keepElectrum(
                  [
                    { id: "url", status: "ok", detail: cfg.url },
                    { id: "http", status: "ok", detail: native ? "nativer HTTP" : "direkt (keine Brücke)" },
                    { id: "rpc", status: "ok", detail: probe.subversion || "getnetworkinfo" },
                  ],
                  get,
                ),
              },
            });
            return;
          } catch (e) {
            if (gen !== connectGen) return;
            const msg = phoneConnectError(e, native);
            set({
              status: "error",
              probe: null,
              bridge: "off",
              error: msg,
              trace: {
                url: cfg.url,
                origin,
                space: "local",
                ok: false,
                probe: null,
                steps: keepElectrum(
                  [
                    { id: "url", status: "ok", detail: cfg.url },
                    { id: "rpc", status: "fail", detail: msg },
                  ],
                  get,
                ),
              },
            });
            return;
          }
        }
        const report = await diagnoseNode(
          { url: creds.url, username: creds.username, password: creds.password },
          network,
        );
        if (gen !== connectGen) return;
        const traced: DiagReport = {
          ...report,
          steps: keepElectrum(report.steps, get),
        };
        if (report.ok && report.probe) {
          set({
            status: "ready",
            probe: report.probe,
            demo: false,
            error: null,
            trace: { ...traced, ok: true },
            bridge: "off",
          });
          return;
        }
        if (corsBlocked(report)) {
          const { isBridgeOn } = await import("@/lib/bitcoind/bridge");
          set({
            status: "error",
            probe: null,
            trace: traced,
            bridge: "needed",
            error: "node.err.cors",
          });
          if (isBridgeOn()) void get().finishBridge();
          return;
        }
        const failed = [...report.steps].reverse().find((s) => s.status === "fail");
        set({
          status: "error",
          probe: null,
          trace: traced,
          bridge: "off",
          error: failed ? `${failed.id}: ${failed.detail}` : "node.err.blocked",
        });
        } catch (e) {
          if (gen !== connectGen) return;
          if (get().status !== "connecting") return;
          const { nativeRpcAvailable } = await import("@/lib/bitcoind/native-http");
          const msg = phoneConnectError(e, nativeRpcAvailable());
          set({
            status: "error",
            probe: null,
            error: msg,
            trace: {
              url: nodeUrl,
              origin,
              space: "local",
              ok: false,
              probe: null,
              steps: keepElectrum([{ id: "rpc", status: "fail", detail: msg }], get),
            },
          });
        } finally {
          clearTimeout(watchdog);
        }
      },
      finishBridge: () => {
        if (finishLock) return finishLock;
        finishLock = (async () => {
        const gen = connectGen;
        const { url, username, password, trace, electrum } = get();
        set({ status: "connecting", bridge: "on", error: null, checking: false });
        followIndexer(gen, electrum, set, get);
        try {
          const { lastBridgeHttp } = await import("@/lib/bitcoind/bridge");
          const probe = await probeNode({ url: normalizeRpcUrl(url), username, password });
          if (gen !== connectGen) return;
          const http = lastBridgeHttp();
          const summary = probe.subversion
            ? `${probe.subversion}${probe.chain ? ` · ${probe.chain}` : ""}${probe.blocks ? ` · ${probe.blocks} Bl.` : ""}`
            : (http || "POST 200").slice(0, 160);
          const steps = keepElectrum(
            trace
              ? [
                  ...trace.steps
                    .filter((s) => s.id !== "bridge" && s.id !== "corsGet" && s.id !== "preflight" && s.id !== "perm" && s.id !== "electrum")
                    .map((s) => (s.id === "rpc" ? { ...s, status: "ok" as const, detail: "via Brücke" } : s)),
                  { id: "bridge", status: "ok" as const, detail: summary },
                ]
              : [{ id: "bridge", status: "ok" as const, detail: summary }],
            get,
          );
          set({
            status: "ready",
            probe,
            demo: false,
            error: null,
            bridge: "on",
            trace: trace ? { ...trace, ok: true, probe, steps } : { url, origin: "", space: "local", ok: true, probe, steps },
          });
        } catch (e) {
          if (gen !== connectGen) return;
          const { lastBridgeHttp } = await import("@/lib/bitcoind/bridge");
          const detail = lastBridgeHttp() || (e instanceof Error ? e.message : "node.err.blocked");
          set({
            status: "error",
            error: e instanceof Error ? e.message : "node.err.blocked",
            bridge: "on",
            trace: trace
              ? {
                  ...trace,
                  steps: keepElectrum(
                    [
                      ...trace.steps.filter((s) => s.id !== "bridge" && s.id !== "electrum"),
                      { id: "bridge", status: "fail", detail },
                    ],
                    get,
                  ),
                }
              : trace,
          });
        }
        })().finally(() => {
          finishLock = null;
        });
        return finishLock;
      },
      disconnect: () => {
        connectGen += 1;
        void import("@/lib/bitcoind/bridge").then((m) => m.dropBridge());
        set({
          demo: false,
          status: "idle",
          probe: null,
          lastCheck: null,
          lastUtxo: null,
          lastWatch: null,
          error: null,
          trace: null,
          bridge: "off",
        });
      },
      validate: async (descriptor, network = "mainnet") => {
        const { demo, status, url, username, password } = get();
        if (status !== "ready") {
          set({ error: "node.err.notConnected", lastCheck: null });
          return;
        }
        if (demo) {
          const local = analyzeDescriptor(descriptor);
          if (!local.ok || !local.info) {
            set({ error: local.error || "node.err.invalid", lastCheck: null });
            return;
          }
          set({
            error: null,
            lastCheck: {
              ...local.info,
              addresses: [],
              exportChecksum: local.info.checksum,
              checksumNote: "match",
              source: "demo",
            },
          });
          return;
        }
        set({ error: null, checking: true });
        try {
          const { withDeadline } = await import("@/lib/bitcoind/native-http");
          const result = await withDeadline(
            validateOnNode(
              { url: normalizeRpcUrl(url, network), username, password },
              descriptor,
            ),
            15000,
            "node.err.unreachable",
          );
          set({ lastCheck: { ...result, source: "core" }, error: null, checking: false });
        } catch (e) {
          set({
            lastCheck: null,
            checking: false,
            error: e instanceof Error ? e.message : "node.err.invalid",
          });
        }
      },
      setLastUtxo: (u) => set({ lastUtxo: u }),
      scanWatch: async (descriptor, opts) => {
        const { demo, status, url, username, password, electrum } = get();
        if (status !== "ready" || demo) return null;
        const n = clampUtxoCount(opts?.count ?? 20);
        const checksum = checksumOf(descriptor);
        set({ scanningWatch: true });
        try {
          const cfg = { url: normalizeRpcUrl(url), username, password };
          let from = 0;
          let merged: WatchSnapshot | null = null;
          while (from < UTXO_SCAN_CAP) {
            const next = await scanWatchWallet(cfg, descriptor, {
              count: n,
              receive: true,
              change: true,
              electrum,
              from,
              checksum,
            });
            merged = merged ? mergeWatchSnapshots(merged, next) : next;
            from += n;
            merged.scanned = Math.min(from, UTXO_SCAN_CAP);
            get().setLastWatch(merged);
            if (!next.unspents.length) break;
          }
          set({ scanningWatch: false });
          return merged;
        } catch (e) {
          set({ scanningWatch: false });
          throw e;
        }
      },
      setLastWatch: (w) =>
        set({
          lastWatch: w,
          lastUtxo: w
            ? { height: w.height, coins: w.unspents.map((u) => ({ height: u.height, amount: u.amount })) }
            : null,
        }),
    }),
    {
      name: "scriptwerk-bitcoind-v3",
      partialize: (s) => ({
        url: s.url,
        username: s.username,
        kind: s.kind,
        electrum: s.electrum,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<BitcoindState> & { esplora?: string };
        const { esplora: _drop, ...rest } = p;
        return { ...current, ...rest };
      },
    },
  ),
);
