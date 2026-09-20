import { useEffect, useRef, useState } from "react";
import { compiledForStudio } from "@/lib/miniscript/policy-mode";
import { checksumOf } from "@/lib/miniscript/checksum";
import { bookmarkletHref, bridgeScript, openNodeTab, originOf, watchBridge } from "@/lib/bitcoind/bridge";
import { useBitcoind } from "@/store/bitcoind";
import type { DiagStatus } from "@/lib/bitcoind/diagnose";
import { useStudio } from "@/store/studio";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useT } from "@/lib/use-t";
import { localizeMessage } from "@/lib/i18n";
import { CopyButton } from "@/components/copy-button";
import { AddressLine } from "@/components/address-qr";
import { UtxoScanPanel } from "@/components/utxo-scan";
import { Loader2, Server } from "lucide-react";
import { toast } from "sonner";
import {
  defaultRpcPort,
  deriveAddressRange,
  hostElectrumInfo,
  hostProxyAvailable,
  hostProxyInfo,
  isLanIpUrl,
  looksLikeStartos,
  normalizeRpcUrl,
  setUseHostProxy,
} from "@/lib/bitcoind/rpc";
import { descriptorForBranch } from "@/lib/hw/address-check";

export function NodeButton() {
  const { t } = useT();
  const open = useBitcoind((s) => s.open);
  const setOpen = useBitcoind((s) => s.setOpen);
  const status = useBitcoind((s) => s.status);
  const checking = useBitcoind((s) => s.checking);
  const ready = status === "ready";
  const loading = status === "connecting" || checking;
  useKeepBridge();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="icon" className="relative size-9" aria-label={t("header.node")} aria-pressed={ready} aria-busy={loading}>
          {loading ? <Loader2 className="animate-spin" /> : <Server />}
          {ready && !loading ? <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-ok" aria-hidden /> : null}
          {loading ? <span className="absolute top-1.5 right-1.5 size-1.5 animate-pulse rounded-full bg-warn" aria-hidden /> : null}
        </Button>
      </DialogTrigger>
      <NodeDialogBody />
    </Dialog>
  );
}

function useKeepBridge() {
  const url = useBitcoind((s) => s.url);
  const username = useBitcoind((s) => s.username);
  const password = useBitcoind((s) => s.password);
  const finishBridge = useBitcoind((s) => s.finishBridge);
  const network = useStudio((s) => s.network);
  const nodeUrl = normalizeRpcUrl(url, network);

  useEffect(() => {
    return watchBridge(originOf(nodeUrl), { user: username, pass: password }, () => {
      void (async () => {
        await finishBridge();
        const st = useBitcoind.getState();
        if (st.status !== "ready") return;
        const s = useStudio.getState();
        const compiled = compiledForStudio(s);
        if (compiled?.ok && compiled.descriptor.includes("xpub")) {
          await st.validate(compiled.descriptor, s.network);
        }
      })();
    });
  }, [nodeUrl, username, password, finishBridge]);
}

function NodeDialogBody() {
  const { t, locale } = useT();
  const url = useBitcoind((s) => s.url);
  const username = useBitcoind((s) => s.username);
  const password = useBitcoind((s) => s.password);
  const electrum = useBitcoind((s) => s.electrum);
  const kind = useBitcoind((s) => s.kind);
  const patch = useBitcoind((s) => s.patch);
  const status = useBitcoind((s) => s.status);
  const demo = useBitcoind((s) => s.demo);
  const probe = useBitcoind((s) => s.probe);
  const lastCheck = useBitcoind((s) => s.lastCheck);
  const checking = useBitcoind((s) => s.checking);
  const error = useBitcoind((s) => s.error);
  const trace = useBitcoind((s) => s.trace);
  const connectDemo = useBitcoind((s) => s.connectDemo);
  const connectLive = useBitcoind((s) => s.connectLive);
  const disconnect = useBitcoind((s) => s.disconnect);
  const validate = useBitcoind((s) => s.validate);
  const bridge = useBitcoind((s) => s.bridge);
  const network = useStudio((s) => s.network);
  const [busy, setBusy] = useState(false);
  const [proxyOn, setProxyOn] = useState(false);
  const [presetUser, setPresetUser] = useState("");
  const [buildTag, setBuildTag] = useState("");
  const presetRef = useRef({ url: "", user: "", password: "", electrum: "" });
  const [authLocked, setAuthLocked] = useState(false);
  const [canLock, setCanLock] = useState(false);
  const [electrumPreset, setElectrumPreset] = useState("");
  const [electrumSource, setElectrumSource] = useState("");
  const passRef = useRef<HTMLInputElement>(null);

  const compiled = useStudio(compiledForStudio);
  const ready = status === "ready";
  const errText = error ? localizeMessage(locale, error) : null;
  const port = defaultRpcPort(network);
  const startos = kind === "startos" || looksLikeStartos(url);
  const ipWarn = startos && isLanIpUrl(url);
  const nodeUrl = normalizeRpcUrl(url, network);

  useEffect(() => {
    void hostProxyAvailable().then(setProxyOn);
    void hostProxyInfo().then((info) => {
      if (!info) return;
      setProxyOn(true);
      setCanLock(info.locked || Boolean(info.user || info.password));
      setAuthLocked(info.locked || Boolean(info.user || info.password));
      setUseHostProxy(true);
      setPresetUser(info.user);
      setBuildTag(info.build);
      presetRef.current = { ...presetRef.current, url: info.url, user: info.user, password: info.password };
      const st = useBitcoind.getState();
      st.patch({
        ...(info.url ? { url: info.url } : {}),
        ...(info.user ? { username: info.user } : {}),
        ...(info.password ? { password: info.password } : {}),
        kind: "startos",
      });
      if (st.status === "idle") void st.connectLive(useStudio.getState().network);
    });
    void hostElectrumInfo().then((info) => {
      if (!info) return;
      setElectrumPreset(info.url);
      setElectrumSource(info.source);
      presetRef.current = { ...presetRef.current, electrum: info.url };
      useBitcoind.getState().patch({ electrum: info.url });
    });
  }, []);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogContent className="max-h-[min(720px,calc(100dvh-2rem))] w-[min(520px,calc(100vw-1.5rem))] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{t("node.title")}</DialogTitle>
        <DialogDescription>{t("node.blurb")}</DialogDescription>
      </DialogHeader>

      {canLock ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-2xs font-medium tracking-[0.14em] text-fg-subtle uppercase">{t("node.lock")}</span>
          <div role="group" aria-label={t("node.lock")} className="flex flex-wrap gap-1.5">
            <button
              type="button"
              aria-pressed={authLocked}
              onClick={() => {
                setAuthLocked(true);
                setUseHostProxy(true);
              }}
              className={
                authLocked
                  ? "h-9 rounded-full bg-primary px-3 text-xs text-primary-foreground"
                  : "h-9 rounded-full border border-border px-3 text-xs text-fg-muted hover:bg-muted hover:text-fg"
              }
            >
              {t("node.lockOn")}
            </button>
            <button
              type="button"
              aria-pressed={!authLocked}
              onClick={() => {
                setAuthLocked(false);
                setUseHostProxy(false);
              }}
              className={
                !authLocked
                  ? "h-9 rounded-full bg-primary px-3 text-xs text-primary-foreground"
                  : "h-9 rounded-full border border-border px-3 text-xs text-fg-muted hover:bg-muted hover:text-fg"
              }
            >
              {t("node.lockOff")}
            </button>
            <button
              type="button"
              onClick={() => {
                const p = presetRef.current;
                patch({
                  url: p.url,
                  username: p.user,
                  password: p.password,
                  electrum: p.electrum || electrumPreset,
                  kind: "startos",
                });
                setAuthLocked(true);
                setUseHostProxy(true);
              }}
              className="h-9 rounded-full border border-border px-3 text-xs text-fg-muted hover:bg-muted hover:text-fg"
            >
              {t("node.resetPreset")}
            </button>
          </div>
          <p className="text-2xs text-pretty text-fg-muted">{t("node.lockHint")}</p>
        </div>
      ) : null}

      <form
        className="space-y-3"
        autoComplete="on"
        onSubmit={(e) => {
          e.preventDefault();
          if (authLocked) {
            void run(() => connectLive(network));
            return;
          }
          const fd = new FormData(e.currentTarget);
          const nextUrl = String(fd.get("url") ?? "").trim();
          const nextUser = String(fd.get("username") ?? "").trim();
          const nextPass = String(fd.get("password") ?? passRef.current?.value ?? "").trim();
          const nextElectrum = String(fd.get("electrum") ?? "").trim();
          patch({
            url: nextUrl,
            username: nextUser,
            password: nextPass,
            electrum: nextElectrum,
            kind: looksLikeStartos(nextUrl) ? "startos" : kind,
          });
          setUseHostProxy(false);
          void run(() => connectLive(network));
        }}
      >
        <div>
          <Label htmlFor="node-url">{t("node.url")}</Label>
          <Input
            id="node-url"
            name="url"
            autoComplete="url"
            value={url}
            disabled={authLocked}
            onChange={(e) => {
              const next = e.target.value;
              patch({
                url: next,
                kind: looksLikeStartos(next) ? "startos" : kind,
              });
            }}
            placeholder={`https://host:port  ·  ${port}`}
            className="mt-1.5 font-mono text-xs"
          />
          <p className="mt-1 text-2xs text-fg-subtle">
            {startos ? t("node.startos.portHint") : t("node.portHint", { port })}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label htmlFor="node-user">{t("node.user")}</Label>
            <Input
              id="node-user"
              name="username"
              autoComplete="username"
              value={username}
              disabled={authLocked}
              onChange={(e) => patch({ username: e.target.value })}
              onInput={(e) => patch({ username: e.currentTarget.value })}
              placeholder={startos ? t("node.userPlaceholder") : "__cookie__"}
              className="mt-1.5 font-mono text-xs"
            />
          </div>
          <div>
            <Label htmlFor="node-pass">{t("node.pass")}</Label>
            <Input
              id="node-pass"
              ref={passRef}
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              disabled={authLocked}
              onChange={(e) => patch({ password: e.target.value })}
              onInput={(e) => patch({ password: e.currentTarget.value })}
              className="mt-1.5 font-mono text-xs"
            />
          </div>
        </div>
        <p className="text-2xs text-pretty text-fg-muted">
          {proxyOn && canLock ? t("node.startos.help") : startos ? t("node.startos.rpcUser") : t("node.lanHelp")}
        </p>
        <div>
          <Label htmlFor="node-electrum">{t("node.electrum")}</Label>
          <Input
            id="node-electrum"
            name="electrum"
            value={electrum}
            disabled={authLocked && Boolean(electrumPreset)}
            onChange={(e) => patch({ electrum: e.target.value })}
            placeholder="host.local:50001"
            className="mt-1.5 font-mono text-xs"
          />
          <p className="mt-1 text-2xs text-pretty text-fg-muted">
            {electrumPreset
              ? t("node.electrumStartos", { name: electrumSource === "electrs" ? "Electrs" : "Fulcrum" })
              : t("node.electrumHint")}
          </p>
        </div>
        {ipWarn ? <p className="text-2xs text-pretty text-warn">{t("node.startos.ipWarn")}</p> : null}

        <NodeLoading busy={busy} />
        {proxyOn ? (
          <p className="text-xs text-ok">
            {presetUser ? t("node.presetStartos", { user: presetUser }) : t("node.proxyOn")}
            {buildTag ? ` · ${buildTag}` : ""}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {ready ? (
            <Button type="button" variant="outline" onClick={disconnect}>
              {t("node.disconnect")}
            </Button>
          ) : (
            <>
              <Button type="submit" disabled={busy || status === "connecting"}>
                {status === "connecting" ? t("node.loading.connect") : t("node.connect")}
              </Button>
              <Button type="button" variant="outline" disabled={busy} onClick={connectDemo}>
                {t("node.demo")}
              </Button>
            </>
          )}
          <Button
            type="button"
            disabled={busy || checking || !ready || !compiled?.ok}
            onClick={() =>
              void run(async () => {
                if (!compiled?.ok) {
                  toast.error(compiled?.error ?? t("node.err.empty"));
                  return;
                }
                await validate(compiled.descriptor, network);
                const st = useBitcoind.getState();
                if (st.error) toast.error(localizeMessage(locale, st.error));
                else toast.success(t("node.checkOk"));
              })
            }
          >
            {checking ? t("node.loading.check") : t("node.check")}
          </Button>
        </div>

        {ready && probe ? (
          <p className="text-xs text-fg-muted">
            {demo ? t("node.demoOn") : probe.subversion || t("node.connected")}
            {probe.chain && probe.chain !== "demo" ? ` · ${probe.chain}` : ""}
            {probe.blocks ? ` · ${probe.blocks} Bl.` : ""}
          </p>
        ) : null}
        {errText && !trace ? <p className="text-xs text-danger">{errText}</p> : null}
        {error && /node\.err\.auth|\b401\b/.test(error) ? (
          <p className="text-2xs text-pretty text-warn">{t("node.err.authHint")}</p>
        ) : null}
        {error === "node.err.blocked" || error === "node.err.cors" || (status !== "ready" && trace?.steps.some((s) => s.status === "fail")) ? (
          <Button type="button" variant="outline" size="sm" onClick={() => openNodeTab(nodeUrl)}>
            {t("node.openCert")}
          </Button>
        ) : null}
        {bridge === "needed" || bridge === "on" ? <BridgePanel nodeUrl={nodeUrl} /> : null}
        {trace ? <TracePanel /> : null}
        {lastCheck ? <CheckResult /> : null}
        <DeriveAddressBox />
      </form>
    </DialogContent>
  );
}

export function NodeCheckCard() {
  const { t, locale } = useT();
  const status = useBitcoind((s) => s.status);
  const checking = useBitcoind((s) => s.checking);
  const lastCheck = useBitcoind((s) => s.lastCheck);
  const error = useBitcoind((s) => s.error);
  const validate = useBitcoind((s) => s.validate);
  const setOpen = useBitcoind((s) => s.setOpen);
  const demo = useBitcoind((s) => s.demo);
  const network = useStudio((s) => s.network);
  const compiled = useStudio(compiledForStudio);
  const ready = status === "ready";

  function runCheck() {
    if (!ready) {
      setOpen(true);
      return;
    }
    if (compiled?.ok) void validate(compiled.descriptor, network);
  }

  const checkBtn = (
    <Button type="button" disabled={!compiled?.ok || checking} onClick={runCheck}>
      {checking ? t("node.loading.check") : ready ? t("node.check") : t("node.open")}
    </Button>
  );

  if (!ready) {
    return (
      <section className="space-y-2">
        <h2 className="text-2xs font-medium tracking-[0.14em] text-fg-subtle uppercase">{t("node.checkTitle")}</h2>
        <p className="text-xs text-fg-muted">{t("node.needConn")}</p>
        {checkBtn}
        {error ? <p className="text-xs text-danger">{localizeMessage(locale, error)}</p> : null}
        <DeriveAddressBox />
      </section>
    );
  }

  return (
    <section className="space-y-2">
      {checking ? <NodeLoading busy={false} /> : null}
      {error ? <p className="text-xs text-danger">{localizeMessage(locale, error)}</p> : null}
      <div className="space-y-2 rounded-lg border border-border bg-surface px-3 py-3">
        <div className="flex items-start justify-between gap-2">
          <p className="pt-1.5 text-xs text-fg-muted">{demo ? t("node.demoOn") : t("node.connected")}</p>
          {checkBtn}
        </div>
        {lastCheck ? <CheckResult bare /> : null}
        <DeriveAddressBox />
      </div>
    </section>
  );
}

function NodeLoading({ busy }: { busy: boolean }) {
  const { t } = useT();
  const status = useBitcoind((s) => s.status);
  const checking = useBitcoind((s) => s.checking);
  const bridge = useBitcoind((s) => s.bridge);
  let label: string | null = null;
  if (checking) label = t("node.loading.check");
  else if (status === "connecting" || busy) label = t("node.loading.connect");
  else if (bridge === "needed") label = t("node.loading.bridge");
  if (!label) return null;
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-fg" role="status" aria-live="polite">
      <Loader2 className="size-3.5 shrink-0 animate-spin text-fg-muted" />
      <span>{label}</span>
    </div>
  );
}

function BridgePanel({ nodeUrl }: { nodeUrl: string }) {
  const { t } = useT();
  const bridge = useBitcoind((s) => s.bridge);
  const origin = typeof location !== "undefined" ? location.origin : "";
  const href = bookmarkletHref(origin);
  const script = bridgeScript(origin);

  function copy(text: string, ok: string) {
    void navigator.clipboard.writeText(text).then(
      () => toast.success(ok),
      () => toast.message(t("node.bridge.console")),
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-border bg-surface px-3 py-2">
      <p className="text-2xs font-medium tracking-[0.14em] text-fg-subtle uppercase">{t("node.bridge.title")}</p>
      <p className="text-xs text-pretty text-fg-muted">
        {bridge === "on" ? t("node.bridge.on") : t("node.bridge.help")}
      </p>
      {bridge !== "on" ? <p className="text-xs text-pretty text-fg">{t("node.bridge.postOnly")}</p> : null}
      {bridge === "needed" ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => openNodeTab(nodeUrl)}>
            {t("node.bridge.openTab")}
          </Button>
          <Button size="sm" onClick={() => copy(script, t("node.bridge.copied"))}>
            {t("node.bridge.copy")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => copy(href, t("node.bridge.bookmarkCopied"))}>
            {t("node.bridge.bookmark")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function shortenDisplay(text: string): string {
  const raw = text.trim();
  if (raw.length < 36) return text;
  const marked = text
    .replace(/https?:\/\/[^\s]+/gi, shortenUrl)
    .replace(/\b((?:bc1|tb1|bcrt1)[a-z0-9]{20,}|[13nm2][a-km-zA-HJ-NP-Z1-9]{25,})\b/g, shortenBtc);
  if (marked !== text) return marked;
  return `${raw.slice(0, 18)}…${raw.slice(-12)}`;
}

function shortenUrl(raw: string): string {
  try {
    const u = new URL(raw);
    let host = u.hostname;
    if (host.length > 22) host = `${host.slice(0, 10)}…${host.slice(-8)}`;
    return `${u.protocol}//${host}${u.port ? `:${u.port}` : ""}`;
  } catch {
    return raw.length > 40 ? `${raw.slice(0, 16)}…${raw.slice(-10)}` : raw;
  }
}

function shortenBtc(s: string): string {
  return s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s;
}

function ClipText({ value, className, copy }: { value: string; className?: string; copy?: boolean }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const short = shortenDisplay(value);
  if (!value) return <span className={className}>—</span>;
  const body =
    short === value ? (
      <span className={className}>{value}</span>
    ) : (
      <button
        type="button"
        className={`max-w-full text-left font-mono break-all ${className ?? ""}`}
        onClick={() => setOpen((v) => !v)}
        title={open ? t("node.addr.less") : t("node.addr.more")}
        aria-expanded={open}
      >
        {open ? value : short}
      </button>
    );
  if (!copy) return body;
  return (
    <span className="inline-flex max-w-full items-start gap-0.5">
      {body}
      <CopyButton value={value} />
    </span>
  );
}

function stepDot(status: DiagStatus): string {
  if (status === "ok") return "bg-ok";
  if (status === "fail") return "bg-danger";
  if (status === "warn") return "bg-warn";
  return "bg-fg-subtle";
}

function TracePanel() {
  const { t } = useT();
  const trace = useBitcoind((s) => s.trace);
  const status = useBitcoind((s) => s.status);
  if (!trace) return null;
  const connected = status === "ready" && trace.ok;
  const steps = connected
    ? trace.steps.filter((s) => s.id === "url" || s.id === "auth" || s.id === "rpc" || s.id === "bridge")
    : trace.steps;
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2">
      <p className="text-2xs font-medium tracking-[0.14em] text-fg-subtle uppercase">{t("node.diag.title")}</p>
      <p className="mt-1 text-2xs text-pretty text-fg-muted">{t("node.diag.hint")}</p>
      <p className="mt-1.5 flex flex-wrap items-baseline gap-x-1 font-mono text-2xs text-fg-muted">
        <span>{t("node.diag.origin")}:</span>
        <ClipText value={trace.origin || "—"} />
      </p>
      <p className="flex flex-wrap items-baseline gap-x-1 font-mono text-2xs text-fg-muted">
        <span>{t("node.diag.target")}:</span>
        <ClipText value={trace.url} />
      </p>
      <ol className="mt-2 space-y-1.5">
        {steps.map((step) => (
          <li key={step.id} className="flex items-start gap-2 text-xs">
            <span className={`mt-1 size-1.5 shrink-0 rounded-full ${stepDot(step.status)}`} aria-hidden />
            <span className="min-w-0">
              <span className="text-fg">{t(`node.diag.${step.id}`)}</span>
              <span className="mt-0.5 block min-w-0">
                <ClipText value={step.detail} className="text-2xs text-fg-muted" />
              </span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function DeriveAddressBox() {
  const { t, locale } = useT();
  const compiled = useStudio(compiledForStudio);
  const status = useBitcoind((s) => s.status);
  const demo = useBitcoind((s) => s.demo);
  const [kind, setKind] = useState<"receive" | "change">("receive");
  const [index, setIndex] = useState(0);
  const [addr, setAddr] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const live = status === "ready" && !demo;

  async function run() {
    if (!compiled?.ok) {
      setErr(t("node.err.empty"));
      return;
    }
    if (!live) {
      setErr(t("node.err.demoDerive"));
      return;
    }
    const i = Math.max(0, Math.min(999999, Math.floor(Number(index) || 0)));
    setIndex(i);
    setBusy(true);
    setErr(null);
    try {
      const node = useBitcoind.getState();
      const branch = descriptorForBranch(compiled.descriptor, kind === "change" ? 1 : 0);
      const list = await deriveAddressRange(
        { url: node.url, username: node.username, password: node.password },
        branch,
        i,
        i,
      );
      const hit = list[0]?.trim() ?? "";
      if (!hit) throw new Error("node.err.derive");
      setAddr(hit);
    } catch (e) {
      setAddr("");
      setErr(localizeMessage(locale, e instanceof Error ? e.message : "node.err.derive"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-border bg-elevated/40 px-2.5 py-2">
      <p className="text-2xs font-medium tracking-[0.14em] text-fg-subtle uppercase">{t("node.derive.title")}</p>
      <p className="text-2xs text-pretty text-fg-muted">{t("node.derive.hint")}</p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex gap-1" role="group" aria-label={t("node.derive.kind")}>
          {(["receive", "change"] as const).map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={kind === id}
              onClick={() => setKind(id)}
              className={
                kind === id
                  ? "h-9 rounded-full bg-primary px-3 text-xs text-primary-foreground"
                  : "h-9 rounded-full border border-border px-3 text-xs text-fg-muted hover:bg-muted hover:text-fg"
              }
            >
              {t(`hw.${id}`)}
            </button>
          ))}
        </div>
        <div className="space-y-1">
          <Label htmlFor="derive-index">{t("node.derive.index")}</Label>
          <Input
            id="derive-index"
            type="number"
            min={0}
            max={999999}
            value={index}
            onChange={(e) => setIndex(Number(e.target.value))}
            className="w-24 font-mono text-xs"
          />
        </div>
        <Button type="button" size="sm" disabled={busy || !compiled?.ok} onClick={() => void run()}>
          {busy ? t("node.derive.working") : t("node.derive.run")}
        </Button>
      </div>
      {err ? <p className="text-2xs text-danger">{err}</p> : null}
      {addr ? (
        <AddressLine
          address={addr}
          label={`${t(`hw.${kind}`)} ${index}`}
          textClassName="text-2xs text-fg"
        />
      ) : null}
    </div>
  );
}

function CheckResult({ bare = false }: { bare?: boolean }) {
  const { t } = useT();
  const lastCheck = useBitcoind((s) => s.lastCheck);
  const status = useBitcoind((s) => s.status);
  const demo = useBitcoind((s) => s.demo);
  if (!lastCheck) return null;
  const utxoOn = status === "ready" && !demo && lastCheck.source === "core" && lastCheck.issolvable;
  const body = (
    <>
      {bare ? null : (
        <p className="text-2xs font-medium tracking-[0.14em] text-fg-subtle uppercase">{t("node.checkTitle")}</p>
      )}
      <p className={`${bare ? "" : "mt-1 "}text-2xs text-pretty text-fg-muted`}>{t("node.check.hint")}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <Badge variant={lastCheck.issolvable ? "ok" : "warn"}>
          {lastCheck.issolvable ? t("node.solvable") : t("node.unsolvable")}
        </Badge>
        {lastCheck.isrange ? <Badge>{t("node.range")}</Badge> : null}
        <Badge variant="default">{lastCheck.source === "core" ? t("node.sourceCore") : t("node.sourceDemo")}</Badge>
      </div>
      <p className="mt-1.5 font-mono text-2xs break-all text-fg">
        {lastCheck.checksumNote === "match"
          ? t("node.check.csExport", { cs: `#${lastCheck.exportChecksum || lastCheck.checksum}` })
          : `${t("node.check.csExport", { cs: `#${lastCheck.exportChecksum || lastCheck.checksum}` })}  ·  ${t("node.check.csCore", { cs: `#${lastCheck.checksum}` })}`}
      </p>
      <p className="mt-1 text-2xs text-pretty text-fg-muted">
        {lastCheck.checksumNote === "match"
          ? t("node.check.csMatch")
          : lastCheck.checksumNote === "receive"
            ? t("node.check.csReceive")
            : t("node.check.csDiffer")}
      </p>
      <p className="mt-1 max-h-24 overflow-y-auto">
        <ClipText value={lastCheck.descriptor} className="text-2xs text-fg-muted" copy />
      </p>
      {lastCheck.addresses.length ? (
        <ul className="mt-2 space-y-0.5">
          {lastCheck.addresses.map((a, i) => (
            <li key={a} className="flex items-center gap-2">
              <span className="w-6 shrink-0 font-mono text-2xs text-fg-subtle">{i}</span>
              <AddressLine address={a} label={`${t("hw.receive")} ${i}`} />
            </li>
          ))}
        </ul>
      ) : null}
      {lastCheck.deriveError ? (
        <p className="mt-1 text-fg-muted">
          {t("node.deriveSkip")}: {lastCheck.deriveError}
        </p>
      ) : null}
      <UtxoScanPanel
        enabled={utxoOn}
        hint={utxoOn ? t("hw.utxo.blurb") : t("hw.utxo.needCheck")}
      />
    </>
  );
  if (bare) return <div className="space-y-0">{body}</div>;
  return <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs">{body}</div>;
}

/** When Core is live, check the descriptor and scan UTXOs once per checksum. */
export function NodeAutoSync() {
  const status = useBitcoind((s) => s.status);
  const demo = useBitcoind((s) => s.demo);
  const checking = useBitcoind((s) => s.checking);
  const scanningWatch = useBitcoind((s) => s.scanningWatch);
  const compiled = useStudio(compiledForStudio);
  const cs = compiled?.ok ? checksumOf(compiled.descriptor) : "";
  const desc = compiled?.ok ? compiled.descriptor : "";
  const last = useRef("");

  useEffect(() => {
    if (status !== "ready" || demo || !desc || !cs) {
      if (status !== "ready") last.current = "";
      const st = useBitcoind.getState();
      if (st.lastWatch && (!cs || st.lastWatch.checksum !== cs)) st.setLastWatch(null);
      return;
    }
    const st = useBitcoind.getState();
    if (st.lastWatch && st.lastWatch.checksum !== cs) st.setLastWatch(null);
    if (last.current === cs) return;
    const checkHit = st.lastCheck?.exportChecksum === cs || st.lastCheck?.checksum === cs;
    const watchHit = st.lastWatch?.checksum === cs;
    if (checkHit && watchHit) {
      last.current = cs;
      return;
    }
    if (st.checking || st.scanningWatch) return;
    last.current = cs;
    if (!checkHit) void st.validate(desc);
    if (!watchHit) void st.scanWatch(desc).catch(() => undefined);
  }, [status, demo, cs, desc, checking, scanningWatch]);

  return null;
}
