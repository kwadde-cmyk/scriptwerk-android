import { useEffect, useMemo, useState } from "react";
import { compileBip388 } from "@/lib/miniscript/bip388";
import { compiledForStudio, policyIsFrozen } from "@/lib/miniscript/policy-mode";
import {
  allRequestedMatch,
  chainMatches,
  clampIndexRange,
  descriptorForBranch,
  policyCacheKey,
  watchOnlyKeys,
  type AddressCheckRow,
  type AddressKind,
} from "@/lib/hw/address-check";
import { deriveAddressRange } from "@/lib/bitcoind/rpc";
import { defaultAccountPath, detectHid, type HwKind } from "@/lib/hw";
import { useHardware } from "@/store/hardware";
import { useStudio } from "@/store/studio";
import { useBitcoind } from "@/store/bitcoind";
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
import { useT } from "@/lib/use-t";
import { localizeMessage } from "@/lib/i18n";
import { CopyButton, Copyable } from "@/components/copy-button";
import { AddressLine } from "@/components/address-qr";
import { UtxoScanPanel } from "@/components/utxo-scan";
import { Usb } from "lucide-react";
import { toast } from "sonner";

export function HardwareButton() {
  const { t } = useT();
  const open = useHardware((s) => s.open);
  const setOpen = useHardware((s) => s.setOpen);
  const session = useHardware((s) => s.session);
  const ready = Boolean(session);

  useEffect(() => {
    useHardware.setState({ hid: detectHid() });
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="icon" className="relative size-9" aria-label={t("header.usb")} aria-pressed={ready}>
          <Usb />
          {ready ? <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-ok" aria-hidden /> : null}
        </Button>
      </DialogTrigger>
      <HardwareDialogBody />
    </Dialog>
  );
}

function HardwareDialogBody() {
  const { t, locale } = useT();
  const status = useHardware((s) => s.status);
  const kind = useHardware((s) => s.kind);
  const demo = useHardware((s) => s.demo);
  const label = useHardware((s) => s.label);
  const fingerprint = useHardware((s) => s.fingerprint);
  const pairingCode = useHardware((s) => s.pairingCode);
  const error = useHardware((s) => s.error);
  const hid = useHardware((s) => s.hid);
  const pendingKeyId = useHardware((s) => s.pendingKeyId);
  const lastHmac = useHardware((s) => s.lastHmac);
  const policyHmacKey = useHardware((s) => s.policyHmacKey);
  const connect = useHardware((s) => s.connect);
  const disconnect = useHardware((s) => s.disconnect);
  const fillKey = useHardware((s) => s.fillKey);
  const registerPolicy = useHardware((s) => s.registerPolicy);
  const keys = useStudio((s) => s.keys);
  const root = useStudio((s) => s.root);
  const reuseKeys = useStudio((s) => s.reuseKeys);
  const frozen = useStudio((s) => policyIsFrozen(s.policyMode));
  const dialogOpen = useHardware((s) => s.open);
  const session = useHardware((s) => s.session);
  const [path, setPath] = useState(defaultAccountPath());
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [walletName, setWalletName] = useState("Scriptwerk");

  const pending = keys.find((k) => k.id === pendingKeyId) ?? null;
  const bip = useMemo(
    () => (!frozen && dialogOpen && root ? compileBip388(root, keys, walletName, reuseKeys) : null),
    [frozen, dialogOpen, root, keys, reuseKeys, walletName],
  );
  const ready = Boolean(session);
  const errText = error ? localizeMessage(locale, error) : null;

  async function run(fn: () => Promise<void>) {
    setBusyAction("1");
    try {
      await fn();
    } catch (err) {
      const msg = localizeMessage(locale, err instanceof Error ? err.message : "hw.err.generic");
      toast.error(msg);
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <DialogContent className="max-h-[min(720px,calc(100dvh-2rem))] w-[min(520px,calc(100vw-1.5rem))] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{t("hw.title")}</DialogTitle>
        <DialogDescription>{t("hw.blurb")}</DialogDescription>
      </DialogHeader>

      {hid === "missing" ? <p className="text-xs text-warn">{t("hw.needChrome")}</p> : null}
      {hid === "iframe" ? <p className="text-xs text-warn">{t("hw.iframe")}</p> : null}

      {!ready ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <DeviceCard
            title={t("export.ledger")}
            hint={t("hw.ledgerHint")}
            disabled={status === "picking" || status === "connecting" || status === "pairing"}
            onUsb={() =>
              run(async () => {
                await connect("ledger", false);
                toast.success(t("hw.connected"));
              })
            }
            onDemo={() =>
              run(async () => {
                await connect("ledger", true);
                toast.success(t("hw.demoOn"));
              })
            }
          />
          <DeviceCard
            title={t("export.bitbox")}
            hint={t("hw.bitboxHint")}
            disabled={status === "picking" || status === "connecting" || status === "pairing"}
            onUsb={() =>
              run(async () => {
                await connect("bitbox", false);
                toast.success(t("hw.connected"));
              })
            }
            onDemo={() =>
              run(async () => {
                await connect("bitbox", true);
                toast.success(t("hw.demoOn"));
              })
            }
          />
        </div>
      ) : null}

      {status === "pairing" && pairingCode ? (
        <div className="rounded-xl border border-border-strong bg-surface px-4 py-5 text-center">
          <p className="text-2xs tracking-[0.14em] text-fg-subtle uppercase">{t("hw.pairing")}</p>
          <p className="mt-2 font-mono text-3xl tracking-[0.3em] text-fg">{pairingCode}</p>
          <p className="mt-2 text-xs text-fg-muted">{t("hw.pairingBlurb")}</p>
        </div>
      ) : null}

      {status === "picking" || status === "connecting" ? (
        <p className="text-sm text-fg-muted">{kind === "ledger" ? t("hw.waitLedger") : t("hw.waitBitbox")}</p>
      ) : null}

      {errText ? <p className="text-xs text-danger">{errText}</p> : null}

      {ready && kind ? (
        <div className="space-y-3">
          <div className="rounded-xl border border-border bg-surface px-3 py-2.5">
            <p className="text-sm text-fg">
              {label}
              {demo ? <span className="ml-2 text-2xs text-fg-subtle uppercase">{t("hw.demo")}</span> : null}
            </p>
            <Copyable value={fingerprint} textClassName="text-2xs text-fg-muted" />
          </div>

          <div className="space-y-1">
            <Label htmlFor="hw-name">{t("export.policyName")}</Label>
            <Input
              id="hw-name"
              value={walletName}
              onChange={(e) => setWalletName(e.target.value.slice(0, 64))}
              className="text-xs"
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="hw-path">{t("keys.bip32")}</Label>
            <Input
              id="hw-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              className="font-mono text-xs"
            />
          </div>

          {pending ? <p className="text-xs text-fg-muted">{t("hw.pendingKey", { name: pending.name })}</p> : null}

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={Boolean(busyAction)}
              onClick={() =>
                run(async () => {
                  const target = pending ?? keys.find((k) => !k.xpub.trim()) ?? keys[0];
                  if (!target) {
                    toast.error(t("keys.empty"));
                    return;
                  }
                  await fillKey(target.id, path);
                  toast.success(t("keys.taken", { name: target.name }));
                })
              }
            >
              {t("hw.fetchKey")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={Boolean(busyAction) || frozen || !bip?.ok}
              onClick={() =>
                run(async () => {
                  if (frozen) {
                    toast.error(t("hw.frozen"));
                    return;
                  }
                  if (!bip?.ok) {
                    toast.error(bip?.error ?? t("export.none"));
                    return;
                  }
                  const key = policyCacheKey(bip.policy);
                  const reused = Boolean(lastHmac && policyHmacKey === key);
                  await registerPolicy(bip.policy);
                  toast.success(reused ? t("hw.hmacReuse") : t("hw.registered"));
                })
              }
            >
              {t("hw.register")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void disconnect()}>
              {t("hw.disconnect")}
            </Button>
          </div>
          {lastHmac && lastHmac.length === 64 ? (
            <p className="font-mono text-2xs text-fg-subtle">
              {t("hw.hmacSession")} · {lastHmac.slice(0, 8)}…
            </p>
          ) : kind === "bitbox" ? (
            <p className="text-2xs text-fg-subtle">{t("hw.bitboxStored")}</p>
          ) : null}
          {frozen ? (
            <p className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-2xs text-pretty text-warn">
              {t("hw.frozen")}
            </p>
          ) : null}
          {kind === "ledger" ? (
            <p className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-2xs text-pretty text-warn">
              {t("hw.verifyNotice")}
            </p>
          ) : null}
          {bip?.ok && !frozen ? (
            <AddressCheckPanel
              policyOk={bip.ok}
              walletName={walletName}
              disabled={Boolean(busyAction)}
            />
          ) : null}
        </div>
      ) : null}
    </DialogContent>
  );
}

function AddressCheckPanel({
  policyOk,
  walletName,
  disabled,
}: {
  policyOk: boolean;
  walletName: string;
  disabled: boolean;
}) {
  const { t, locale } = useT();
  const root = useStudio((s) => s.root);
  const keys = useStudio((s) => s.keys);
  const reuseKeys = useStudio((s) => s.reuseKeys);
  const network = useStudio((s) => s.network);
  const getWalletAddress = useHardware((s) => s.getWalletAddress);
  const nodeStatus = useBitcoind((s) => s.status);
  const nodeDemo = useBitcoind((s) => s.demo);
  const probe = useBitcoind((s) => s.probe);
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(0);
  const [receive, setReceive] = useState(true);
  const [change, setChange] = useState(true);
  const [verify, setVerify] = useState(true);
  const [verifyAll, setVerifyAll] = useState(false);
  const [rows, setRows] = useState<AddressCheckRow[]>([]);
  const [working, setWorking] = useState<string | null>(null);
  const [coreBanner, setCoreBanner] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const bip = useMemo(
    () => (root ? compileBip388(root, keys, walletName, reuseKeys) : null),
    [root, keys, walletName, reuseKeys],
  );
  const compiled = useStudio(compiledForStudio);

  async function run() {
    if (!bip?.ok || !compiled?.ok) {
      toast.error(bip?.error ?? compiled?.error ?? t("export.none"));
      return;
    }
    const range = clampIndexRange(from, to);
    setFrom(range.from);
    setTo(range.to);
    const kinds: AddressKind[] = [];
    if (receive) kinds.push("receive");
    if (change) kinds.push("change");
    if (!kinds.length) {
      toast.error(t("hw.checkNone"));
      return;
    }

    const next: AddressCheckRow[] = [];
    let coreMsg: string | null = null;
    const node = useBitcoind.getState();
    const liveCore = node.status === "ready" && !node.demo;
    if (node.status !== "ready") coreMsg = t("node.err.notConnected");
    else if (node.demo) coreMsg = t("node.err.demoDerive");
    else if (!chainMatches(network, node.probe?.chain)) {
      coreMsg = t("node.err.chain", { ui: network, node: node.probe?.chain || "?" });
    }

    const cfg = {
      url: node.url,
      username: node.username,
      password: node.password,
    };

    for (const kind of kinds) {
      const ch = kind === "change" ? 1 : 0;
      const branch = descriptorForBranch(compiled.descriptor, ch);
      let coreAddrs: string[] = [];
      let branchCoreErr: string | undefined;
      if (liveCore && !coreMsg) {
        try {
          coreAddrs = await deriveAddressRange(cfg, branch, range.from, range.to);
        } catch (e) {
          branchCoreErr = localizeMessage(locale, e instanceof Error ? e.message : "node.err.derive");
        }
      } else if (coreMsg) {
        branchCoreErr = coreMsg;
      }

      for (let i = range.from; i <= range.to; i++) {
        const path = `${ch}/${i}`;
        setWorking(t("hw.checkWorking", { path }));
        const display = verify && (verifyAll || i === range.from);
        let ledger = "";
        let ledgerError: string | undefined;
        try {
          ledger = await getWalletAddress({
            policy: bip.policy,
            change: ch,
            index: i,
            display,
          });
        } catch (e) {
          ledgerError = localizeMessage(locale, e instanceof Error ? e.message : "hw.err.generic");
        }
        const core = coreAddrs[i - range.from] ?? "";
        const coreError = !core ? branchCoreErr : undefined;
        next.push({
          index: i,
          kind,
          path,
          ledger,
          core,
          match: Boolean(ledger && core && ledger === core),
          ledgerError,
          coreError,
        });
        setRows([...next]);
      }
    }
    setWorking(null);
    setCoreBanner(coreMsg);
    setDone(true);
    setRows(next);
    if (allRequestedMatch(next)) toast.success(t("hw.checkOk"));
    else toast.error(t("hw.checkFail"));
  }

  const ok = done && allRequestedMatch(rows);
  const watchKeys = bip?.ok ? watchOnlyKeys(bip.policy) : [];

  return (
    <div className="space-y-2 rounded-xl border border-border bg-elevated/40 px-3 py-2.5">
      <p className="text-xs text-fg">{t("hw.checkTitle")}</p>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor="hw-from">{t("hw.checkFrom")}</Label>
          <Input
            id="hw-from"
            type="number"
            min={0}
            value={from}
            onChange={(e) => setFrom(Number(e.target.value))}
            className="font-mono text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="hw-to">{t("hw.checkTo")}</Label>
          <Input
            id="hw-to"
            type="number"
            min={0}
            value={to}
            onChange={(e) => setTo(Number(e.target.value))}
            className="font-mono text-xs"
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-3 text-xs">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={receive} onChange={(e) => setReceive(e.target.checked)} />
          {t("hw.checkReceive")}
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={change} onChange={(e) => setChange(e.target.checked)} />
          {t("hw.checkChange")}
        </label>
      </div>
      <label className="flex items-center gap-1.5 text-xs">
        <input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} />
        {t("hw.checkVerify")}
      </label>
      {verify ? (
        <label className="flex items-center gap-1.5 text-xs">
          <input type="checkbox" checked={verifyAll} onChange={(e) => setVerifyAll(e.target.checked)} />
          {t("hw.checkVerifyAll")}
        </label>
      ) : null}
      <p className="text-2xs text-fg-muted">{t("hw.checkVerifyHint")}</p>
      {compiled?.ok ? (
        <div className="space-y-1.5 rounded-lg border border-border bg-surface/60 px-2.5 py-2">
          <p className="text-2xs font-medium tracking-[0.14em] text-fg-subtle uppercase">{t("hw.watchTitle")}</p>
          <p className="text-2xs text-pretty text-fg-muted">{t("hw.watchBlurb")}</p>
          <div className="flex items-start gap-1">
            <p className="min-w-0 flex-1 font-mono text-2xs break-all text-fg-muted">
              {compiled.descriptor.length > 72
                ? `${compiled.descriptor.slice(0, 36)}…${compiled.descriptor.slice(-18)}`
                : compiled.descriptor}
            </p>
            <CopyButton value={compiled.descriptor} label={t("hw.watchCopyDesc")} />
          </div>
          {watchKeys.length ? (
            <ul className="space-y-1.5">
              <li className="text-2xs font-medium tracking-[0.14em] text-fg-subtle uppercase">{t("hw.watchKeys")}</li>
              {watchKeys.map((k) => (
                <li key={`${k.name}-${k.fingerprint}`} className="space-y-0.5">
                  <div className="flex min-w-0 items-center gap-1">
                    <span className="shrink-0 font-mono text-2xs text-fg">{k.label || k.name}</span>
                    <Copyable value={k.fingerprint} textClassName="text-2xs text-fg-muted" />
                  </div>
                  <div className="flex items-start gap-1">
                    <span className="min-w-0 flex-1 font-mono text-2xs break-all text-fg-muted">
                      {k.xpub.length > 24 ? `${k.xpub.slice(0, 12)}…${k.xpub.slice(-8)}` : k.xpub}
                    </span>
                    <CopyButton value={k.xpub} label={t("hw.watchCopyXpub")} />
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <p className="text-2xs text-fg-subtle">
        {nodeStatus === "ready" && !nodeDemo
          ? probe?.subversion || probe?.chain || t("node.title")
          : t("node.err.notConnected")}
      </p>
      <Button
        size="sm"
        disabled={disabled || !policyOk || Boolean(working)}
        onClick={() => void run()}
      >
        {t("hw.checkRun")}
      </Button>
      {working ? <p className="text-2xs text-fg-muted">{working}</p> : null}
      {coreBanner ? <p className="text-2xs text-warn">{coreBanner}</p> : null}
      {done && rows.length ? (
        <p className={`text-xs ${ok ? "text-ok" : "text-danger"}`}>
          {ok ? t("hw.checkOk") : t("hw.checkFail")}
        </p>
      ) : null}
      {ok ? (
        <p className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-2xs text-pretty text-warn">
          {t("hw.checkNextWallet")}
        </p>
      ) : null}
      {rows.length ? (
        <div className="max-h-56 overflow-auto">
          <table className="w-full text-left font-mono text-2xs">
            <thead className="text-fg-subtle">
              <tr>
                <th className="pr-2 font-normal">{t("hw.checkColIndex")}</th>
                <th className="pr-2 font-normal">{t("hw.checkColKind")}</th>
                <th className="pr-2 font-normal">{t("hw.checkColLedger")}</th>
                <th className="pr-2 font-normal">{t("hw.checkColCore")}</th>
                <th className="font-normal">{t("hw.checkColMatch")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.kind}-${r.index}`} className={r.match ? "text-fg" : "text-danger"}>
                  <td className="py-0.5 pr-2 align-top">{r.index}</td>
                  <td className="py-0.5 pr-2 align-top">{r.kind === "change" ? t("hw.change") : t("hw.receive")}</td>
                  <td className="max-w-[9rem] py-0.5 pr-2 align-top">
                    {r.ledgerError ? (
                      <span className="break-all">{r.ledgerError}</span>
                    ) : r.ledger ? (
                      <AddressLine address={r.ledger} label={`${t(r.kind === "change" ? "hw.change" : "hw.receive")} ${r.index}`} />
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="max-w-[9rem] py-0.5 pr-2 align-top">
                    {r.coreError ? (
                      <span className="break-all">{r.coreError}</span>
                    ) : r.core ? (
                      <AddressLine address={r.core} label={`${t(r.kind === "change" ? "hw.change" : "hw.receive")} ${r.index}`} />
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="py-0.5 align-top">{r.match ? t("hw.checkMatch") : t("hw.checkMiss")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <UtxoScanPanel
        enabled={ok && nodeStatus === "ready" && !nodeDemo && !disabled && !working}
        hint={ok ? t("hw.utxo.blurb") : t("hw.utxo.needMatch")}
        receive={receive}
        change={change}
      />
    </div>
  );
}

function DeviceCard({
  title,
  hint,
  disabled,
  onUsb,
  onDemo,
}: {
  title: string;
  hint: string;
  disabled: boolean;
  onUsb: () => void;
  onDemo: () => void;
}) {
  const { t } = useT();
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-3">
      <p className="text-sm text-fg">{title}</p>
      <p className="text-2xs text-pretty text-fg-muted">{hint}</p>
      <Button size="sm" disabled={disabled} onClick={onUsb}>
        <Usb /> {t("hw.connectUsb")}
      </Button>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={onDemo}>
        {t("hw.connectDemo")}
      </Button>
    </div>
  );
}

export function useHwFillKey(keyId: string, onOrigin?: (origin: string) => void) {
  const { t, locale } = useT();
  const setOpen = useHardware((s) => s.setOpen);
  const setPendingKey = useHardware((s) => s.setPendingKey);
  const fillKey = useHardware((s) => s.fillKey);
  const fetchXpub = useHardware((s) => s.fetchXpub);
  const sessionKind = useHardware((s) => s.kind);
  const status = useHardware((s) => s.status);

  return async (kind: HwKind, path?: string) => {
    setPendingKey(keyId);
    if (status === "ready" && sessionKind === kind) {
      try {
        if (onOrigin) {
          const result = await fetchXpub(path);
          onOrigin(result.origin);
          return;
        }
        await fillKey(keyId, path);
        toast.success(t("keys.taken", { name: useStudio.getState().keys.find((k) => k.id === keyId)?.name ?? "" }));
      } catch (err) {
        toast.error(localizeMessage(locale, err instanceof Error ? err.message : "hw.err.generic"));
      }
      return;
    }
    setOpen(true);
  };
}
