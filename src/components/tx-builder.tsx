import { useMemo, useRef, useState, type ReactNode } from "react";
import { QrCode, Trash2 } from "lucide-react";
import { addressFromScan, addedSignaturePubkeys, btcToSats, buildPsbt, estimateVbytes, expandSpots, extractSignedTx, feeFromRate, mergePsbtSignatures, planPayments, samePsbtTransaction, satsFromDecimal, satsToDecimal, type ScriptSpot } from "@/lib/tx/psbt";
import { signatureReport } from "@/lib/tx/sigs";
import { formatAmount, type UtxoHit, type WatchAddr } from "@/lib/hw/address-check";
import { evaluateCoinStatus } from "@/lib/miniscript/coin-status";
import { describeStageSlots, type Stage } from "@/lib/miniscript/stages";
import { lockWhen } from "@/lib/miniscript/keys";
import { compiledForStudio } from "@/lib/miniscript/policy-mode";
import { broadcastRawTx } from "@/lib/bitcoind/rpc";
import { compileBip388 } from "@/lib/miniscript/bip388";
import { useBitcoind } from "@/store/bitcoind";
import { useHardware } from "@/store/hardware";
import { pickUsbKind } from "@/lib/hw/usb-kind";
import { useStudio } from "@/store/studio";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { CopyButton } from "@/components/copy-button";
import { QrPreview, QrScanner } from "@/components/qr-io";
import { toast } from "sonner";
import { useT } from "@/lib/use-t";
import { localizeMessage, numberLocale, t as translate } from "@/lib/i18n";
import type { HwKind } from "@/lib/hw";

const NO_COINS: UtxoHit[] = [];
const NO_ADDRS: WatchAddr[] = [];

type PayRow = { id: string; address: string; amount: string };

function newRow(): PayRow {
  return { id: Math.random().toString(36).slice(2, 8), address: "", amount: "" };
}

export function TxTab() {
  const { t, locale } = useT();
  const stages = useStudio((s) => s.stages);
  const reuse = useStudio((s) => s.reuseKeys);
  const slots = useMemo(() => describeStageSlots(stages, reuse), [stages, reuse]);
  const [mode, setMode] = useState<"send" | "recovery">("send");
  const [path, setPath] = useState<number | null>(null);
  const [signed, setSigned] = useState("");
  const signedRef = useRef("");
  const syncRef = useRef<(merged: string) => void>(() => {});
  const pathIndex = slots.length <= 1 ? 0 : path;

  function takeSignature(next: string): { merged: string; gained: boolean } {
    const prev = signedRef.current;
    const merged = mergePsbtSignatures(prev, next);
    signedRef.current = merged;
    setSigned(merged);
    syncRef.current(merged);
    let gained = false;
    try {
      gained = addedSignaturePubkeys(prev, merged).length > 0;
    } catch {
      gained = merged !== prev;
    }
    return { merged, gained };
  }

  return (
    <div className="space-y-5">
      {slots.length > 1 ? (
        <div className="space-y-2">
          <p className="text-2xs font-medium tracking-[0.14em] text-fg-subtle uppercase">{t("tx.path")}</p>
          <div className="flex flex-wrap gap-2">
            {slots.map((slot, i) => (
              <Button key={slot.index} type="button" variant={pathIndex === i ? "default" : "outline"} onClick={() => setPath(i)}>
                {slot.quorum} · {lockWhen(slot.lock, slot.delay, locale)}
              </Button>
            ))}
          </div>
          {pathIndex == null ? <p className="text-xs text-fg-muted">{t("tx.pathNeed")}</p> : null}
        </div>
      ) : null}
      <div className="flex gap-1 rounded-lg border border-border p-1">
        <Button type="button" className="flex-1" variant={mode === "send" ? "default" : "outline"} onClick={() => setMode("send")}>
          {t("tx.send")}
        </Button>
        <Button type="button" className="flex-1" variant={mode === "recovery" ? "default" : "outline"} onClick={() => setMode("recovery")}>
          {t("tx.recovery")}
        </Button>
      </div>
      <Step n="1" title={mode === "send" ? t("tx.stepBuild") : t("tx.recovery")}>
        {mode === "send" ? (
          <SendPane pathIndex={pathIndex} syncRef={syncRef} takeSignature={takeSignature} />
        ) : (
          <RecoveryPane pathIndex={pathIndex} syncRef={syncRef} takeSignature={takeSignature} />
        )}
      </Step>
      <Step n="2" title={t("tx.stepSign")}>
        <SignPane pathIndex={pathIndex} signed={signed} takeSignature={takeSignature} />
      </Step>
      <Step n="3" title={t("tx.stepSend")}>
        <BroadcastPane signed={signed} />
      </Step>
    </div>
  );
}

function SendPane({
  pathIndex,
  syncRef,
  takeSignature,
}: {
  pathIndex: number | null;
  syncRef: { current: (merged: string) => void };
  takeSignature: (next: string) => { merged: string; gained: boolean };
}) {
  const { t, locale } = useT();
  const nloc = numberLocale(locale);
  const unit = useStudio((s) => s.amountUnit);
  const coins = useBitcoind((s) => s.lastWatch?.unspents) ?? NO_COINS;
  const addresses = useBitcoind((s) => s.lastWatch?.addresses) ?? NO_ADDRS;
  const watchHeight = useBitcoind((s) => s.lastWatch?.height) ?? 0;
  const probeBlocks = useBitcoind((s) => (s.probe && s.probe.chain !== "demo" ? s.probe.blocks : 0)) ?? 0;
  const tip = probeBlocks || watchHeight;
  const stages = useStudio((s) => s.stages);
  const reuse = useStudio((s) => s.reuseKeys);
  const root = useStudio((s) => s.root);
  const compiled = useStudio(compiledForStudio);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [rows, setRows] = useState<PayRow[]>([newRow()]);
  const [change, setChange] = useState("");
  const [changeEdited, setChangeEdited] = useState(false);
  const [rate, setRate] = useState("2");
  const [psbt, setPsbt] = useState("");
  const [dustWarn, setDustWarn] = useState(false);
  const [feeOnChange, setFeeOnChange] = useState(false);
  const [error, setError] = useState<string | null>(null);
  syncRef.current = (merged) => {
    setPsbt((cur) => (cur && samePsbtTransaction(cur, merged) ? mergePsbtSignatures(cur, merged) : cur));
  };

  const selected = coins.filter((c) => picked.includes(`${c.txid}:${c.vout}`));
  const sumBtc = selected.reduce((s, c) => s + c.amount, 0);
  const suggested = useMemo(() => suggestChange(addresses, avoidSet(selected, rows)), [addresses, selected, rows]);
  const changeValue = changeEdited ? change : (suggested?.address ?? "");
  const size = spendSize(stages, reuse, pathIndex ?? 0);
  const entered = rows.filter((r) => r.address.trim());
  const gross = entered.reduce((s, r) => s + rowSats(r), 0);
  const inputSats = selected.reduce((s, c) => s + btcToSats(c.amount), 0);
  const vbytes = estimateVbytes({
    inputs: Math.max(1, selected.length),
    outputs: [...entered.map((r) => r.address), ...(changeValue ? [changeValue] : [""])],
    sigs: size.sigs,
    keys: size.keys,
  });
  const feeSats = feeFromRate(Number(rate.replace(",", ".")), vbytes);
  const canFromChange = inputSats - gross - feeSats >= 546;
  const useChange = feeOnChange && canFromChange;
  const changeLeft = useChange ? inputSats - gross - feeSats : inputSats - gross;
  const dustChange = selected.length > 0 && entered.some((r) => rowSats(r) > 0) && changeLeft > 0 && changeLeft < 546;

  function confirmPick() {
    setPicked(draft);
    setOpen(false);
    setPsbt("");
  }

  async function build() {
    setError(null);
    setPsbt("");
    setDustWarn(false);
    try {
      const locks = pathLock(stages, pathIndex ?? 0);
      const plan = planPayments({
        coins: selected.map(asCoin),
        payments: applyFee(
          entered.map((r) => ({ address: r.address, sats: rowSats(r) })),
          feeSats,
          useChange,
        ),
        feeSats,
        changeAddress: changeValue,
        tip,
        older: locks.older,
        after: locks.after,
      });
      if (!compiled?.ok) throw new Error("tx.err.script");
      const meta = await walletMeta(
        compiled.descriptor,
        addresses,
        plan.inputs.map((c) => c.address),
        plan.outputs.map((o) => o.address),
      );
      setDustWarn(Boolean(plan.dustChange));
      const built = buildPsbt(plan, meta);
      setPsbt(built);
      takeSignature(built);
    } catch (e) {
      setError(localizeMessage(locale, e instanceof Error ? e.message : "tx.funds"));
    }
  }

  return (
    <section className="space-y-3">
      <p className="text-2xs text-pretty text-fg-muted">{t("tx.sendBlurb")}</p>
      <Button type="button" variant="outline" onClick={() => { setDraft(picked); setOpen(true); }}>
        {t("tx.pick")}
      </Button>
      <p className="font-mono text-sm">
        {t("tx.sum")} {formatAmount(sumBtc, unit, nloc).label}
        <span className="ml-2 text-2xs text-fg-muted">{t("tx.coinN", { n: String(selected.length) })}</span>
      </p>
      {rows.map((row, i) => (
        <div key={row.id} className="space-y-2">
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <AddressField
                id={`tx-to-${row.id}`}
                label={i === 0 ? t("tx.to") : t("tx.toMore")}
                value={row.address}
                onChange={(address) => setRows((cur) => cur.map((r) => (r.id === row.id ? { ...r, address } : r)))}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={t("tx.remove")}
              disabled={rows.length < 2}
              onClick={() => setRows((cur) => cur.filter((r) => r.id !== row.id))}
            >
              <Trash2 />
            </Button>
          </div>
          <div>
            <Label htmlFor={`tx-amt-${row.id}`}>{t("tx.amount")}</Label>
            <div className="mt-1 flex gap-2">
              <Input
                id={`tx-amt-${row.id}`}
                inputMode="decimal"
                value={row.amount}
                placeholder="0.001"
                onChange={(e) => setRows((cur) => cur.map((r) => (r.id === row.id ? { ...r, amount: e.target.value } : r)))}
                className="font-mono"
              />
              <Button
                type="button"
                variant="outline"
                disabled={!selected.length || pathIndex == null}
                onClick={() =>
                  setRows((cur) =>
                    cur.map((r) => {
                      if (r.id !== row.id) return r;
                      const others = cur.filter((x) => x.id !== r.id).reduce((s, x) => s + rowSats(x), 0);
                      const room = inputSats - others - (useChange ? feeSats : 0);
                      return { ...r, amount: satsToDecimal(Math.max(0, room)) };
                    }),
                  )
                }
              >
                {t("tx.max")}
              </Button>
            </div>
          </div>
        </div>
      ))}
      <Button type="button" variant="outline" onClick={() => setRows((cur) => [...cur, newRow()])}>
        {t("tx.addAddr")}
      </Button>
      <AddressField
        id="tx-change"
        label={t("tx.change")}
        value={changeValue}
        onChange={(next) => {
          setChangeEdited(true);
          setChange(next);
        }}
      />
      {suggested && !changeEdited ? (
        <p className="text-2xs text-fg-muted">{t("tx.changeHint", { n: String(suggested.index) })}</p>
      ) : !changeValue ? (
        <p className="text-2xs text-fg-muted">{t("tx.noChange")}</p>
      ) : null}
      <div className="flex items-end gap-2">
        <div className="w-24">
          <Label htmlFor="tx-fee">{t("tx.feeRate")}</Label>
          <Input id="tx-fee" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} className="mt-1 font-mono" />
        </div>
        <Button type="button" variant={useChange ? "secondary" : "outline"} aria-pressed={useChange} disabled={!canFromChange} onClick={() => setFeeOnChange((v) => !v)}>
          {t("tx.feeFromChange")}
        </Button>
      </div>
      <p className="text-2xs text-fg-muted">{t(useChange ? "tx.feeOnChange" : "tx.feeOnAmount", { vb: String(vbytes), sats: String(feeSats) })}</p>
      {dustChange ? <p className="text-xs text-pretty text-warn">{t("tx.dustChange", { sats: String(changeLeft) })}</p> : null}
      <Button type="button" onClick={build} disabled={!selected.length || pathIndex == null}>{t("tx.build")}</Button>
      {error ? <p className="text-xs text-pretty text-danger">{error}</p> : null}
      {dustWarn && !dustChange ? <p className="text-xs text-pretty text-warn">{t("tx.dustChange", { sats: String(changeLeft) })}</p> : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("tx.pick")}</DialogTitle>
            <DialogDescription>{t("tx.pickBlurb")}</DialogDescription>
          </DialogHeader>
          {!coins.length ? (
            <p className="text-xs text-fg-muted">{t("tx.needScan")}</p>
          ) : (
            <ScrollArea className="max-h-80">
            <ul className="space-y-1 pr-3">
              {coins.map((c) => {
                const id = `${c.txid}:${c.vout}`;
                const on = draft.includes(id);
                const lock = coinPath(c, tip, stages, reuse, root, pathIndex);
                const locked = lock && !lock.open && c.height > 0;
                return (
                  <li key={id}>
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => setDraft((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))}
                      className={
                        on
                          ? "flex min-h-11 w-full items-center justify-between gap-2 rounded-md bg-muted px-3 py-2 text-left text-xs"
                          : "flex min-h-11 w-full items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-left text-xs text-fg-muted"
                      }
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-mono">{c.txid.slice(0, 10)}…:{c.vout}</span>
                        {c.height <= 0 ? (
                          <span className="block text-2xs text-fg-subtle">{t("tx.unconfirmed")}</span>
                        ) : locked ? (
                          <span className="block text-2xs text-fg-subtle">
                            {t("tx.lockedAt", {
                              h: lock.opensAt.toLocaleString(nloc),
                              n: lock.blocksLeft.toLocaleString(nloc),
                            })}
                          </span>
                        ) : null}
                      </span>
                      <span className="shrink-0 tabular-nums">{formatAmount(c.amount, unit, nloc).label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            </ScrollArea>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={confirmPick}>{t("tx.useCoins")}</Button>
            <Button type="button" variant="outline" onClick={() => setDraft(coins.map((c) => `${c.txid}:${c.vout}`))}>{t("tx.pickAll")}</Button>
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                setDraft(
                  coins
                    .filter((c) => c.height > 0 && coinPath(c, tip, stages, reuse, root, pathIndex)?.open)
                    .map((c) => `${c.txid}:${c.vout}`),
                )
              }
            >
              {t("tx.pickOpen")}
            </Button>
            <Button type="button" variant="outline" onClick={() => setDraft([])}>{t("tx.pickNone")}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function RecoveryPane({
  pathIndex,
  syncRef,
  takeSignature,
}: {
  pathIndex: number | null;
  syncRef: { current: (merged: string) => void };
  takeSignature: (next: string) => { merged: string; gained: boolean };
}) {
  const { t, locale } = useT();
  const nloc = numberLocale(locale);
  const unit = useStudio((s) => s.amountUnit);
  const stages = useStudio((s) => s.stages);
  const reuse = useStudio((s) => s.reuseKeys);
  const root = useStudio((s) => s.root);
  const compiled = useStudio(compiledForStudio);
  const snap = useBitcoind((s) => s.lastWatch);
  const probe = useBitcoind((s) => s.probe);
  const tip = probe?.blocks && probe.chain !== "demo" ? probe.blocks : snap?.height ?? 0;
  const [rate, setRate] = useState("2");
  const [built, setBuilt] = useState<{ id: string; psbt: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  syncRef.current = (merged) => {
    setBuilt((cur) =>
      cur.map((b) => (b.psbt && samePsbtTransaction(b.psbt, merged) ? { ...b, psbt: mergePsbtSignatures(b.psbt, merged) } : b)),
    );
  };

  const rows = useMemo(() => {
    const coins = (snap?.unspents ?? []).filter((c) => {
      if (!c.address || pathIndex == null) return false;
      const status = evaluateCoinStatus({ height: c.height, tip, stages, reuse, root });
      const path = status.paths[pathIndex];
      return Boolean(path?.open && path.delay > 0);
    });
    const taken = new Set(coins.map((c) => c.address || ""));
    const fresh = freshReceive(snap?.addresses ?? [], taken);
    return coins.map((coin, i) => ({ coin, dest: fresh[i] ?? "" }));
  }, [snap, tip, stages, reuse, root, pathIndex]);

  async function buildAll() {
    setError(null);
    const next: { id: string; psbt: string }[] = [];
    try {
      if (!compiled?.ok) throw new Error("tx.err.script");
      for (const row of rows) {
        if (!row.dest) throw new Error("tx.err.fresh");
        if (row.dest === row.coin.address) throw new Error("tx.err.reuse");
        const size = spendSize(stages, reuse, pathIndex ?? 0);
        const vb = estimateVbytes({ inputs: 1, outputs: [row.dest], sigs: size.sigs, keys: size.keys });
        const feeSats = feeFromRate(Number(rate.replace(",", ".")), vb);
        const locks = pathLock(stages, pathIndex ?? 0);
        const plan = planPayments({
          coins: [asCoin(row.coin)],
          payments: [{ address: row.dest, sats: btcToSats(row.coin.amount) - feeSats }],
          feeSats,
          tip,
          older: locks.older,
          after: locks.after,
        });
        if (plan.outputs.length !== 1) throw new Error("tx.err.reuse");
        const meta = await walletMeta(
          compiled.descriptor,
          snap?.addresses ?? [],
          plan.inputs.map((c) => c.address),
          plan.outputs.map((o) => o.address),
        );
        next.push({ id: `${row.coin.txid}:${row.coin.vout}`, psbt: buildPsbt(plan, meta) });
      }
      setBuilt(next);
    } catch (e) {
      setBuilt([]);
      setError(localizeMessage(locale, e instanceof Error ? e.message : "tx.funds"));
    }
  }

  return (
    <section className="space-y-3">
      <p className="text-2xs text-pretty text-fg-muted">{t("tx.recoveryBlurb")}</p>
      <div>
        <Label htmlFor="tx-rec-fee">{t("tx.feeRate")}</Label>
        <Input id="tx-rec-fee" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} className="mt-1 font-mono" />
      </div>
      {!rows.length ? <p className="text-xs text-fg-muted">{t("tx.recoveryEmpty")}</p> : null}
      <ul className="space-y-3">
        {rows.map((row) => {
          const id = `${row.coin.txid}:${row.coin.vout}`;
          const psbt = built.find((b) => b.id === id)?.psbt ?? "";
          const size = spendSize(stages, reuse, pathIndex ?? 0);
          const vb = estimateVbytes({ inputs: 1, outputs: [row.dest || ""], sigs: size.sigs, keys: size.keys });
          const feeSats = feeFromRate(Number(rate.replace(",", ".")), vb);
          const outSats = Math.max(0, btcToSats(row.coin.amount) - feeSats);
          return (
            <li key={id} className="space-y-2 rounded-md border border-border p-3">
              <p className="font-mono text-2xs text-fg-muted">{row.coin.txid.slice(0, 12)}…:{row.coin.vout}</p>
              <p className="break-all font-mono text-xs">{t("tx.from")} {row.coin.address}</p>
              <p className="break-all font-mono text-xs">{t("tx.to")} {row.dest || t("tx.noFresh")}</p>
              <p className="text-xs text-fg-muted">
                {formatAmount(outSats / 1e8, unit, nloc).label} · {t("tx.feeHint", { vb: String(vb), sats: String(feeSats) })}
              </p>
              <div className="flex flex-wrap gap-2">
                {psbt ? (
                  <PsbtExport
                    value={psbt}
                    name={`scriptwerk-${id.replace(":", "-")}.psbt`}
                    extra={
                      <Button
                        type="button"
                        variant="outline"
                        disabled={!!busy}
                        onClick={() =>
                          void signDetected(psbt, setBusy, (next) => setBuilt((cur) => cur.map((b) => (b.id === id ? { ...b, psbt: next } : b))), setError, locale).then(
                            (next) => next && deliver(next, (merged) => setBuilt((cur) => cur.map((b) => (b.id === id ? { ...b, psbt: merged } : b))), takeSignature, pathIndex, setError, locale),
                          )
                        }
                      >
                        {busy ? t("tx.signing") : t("tx.usb")}
                      </Button>
                    }
                  />
                ) : (
                  <span className="text-2xs text-fg-muted">{t("tx.buildEach")}</span>
                )}
              </div>
              {psbt ? <SigStatus psbt={psbt} pathIndex={pathIndex} /> : null}
            </li>
          );
        })}
      </ul>
      <Button type="button" onClick={buildAll} disabled={!rows.length || pathIndex == null}>{t("tx.buildEach")}</Button>
      {error ? <p className="text-xs text-pretty text-danger">{error}</p> : null}
    </section>
  );
}

function SignPane({
  pathIndex,
  signed,
  takeSignature,
}: {
  pathIndex: number | null;
  signed: string;
  takeSignature: (next: string) => { merged: string; gained: boolean };
}) {
  const { t, locale } = useT();
  const [importQr, setImportQr] = useState(false);
  const [exportQr, setExportQr] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const ready = signed.trim().length > 0;

  async function usb() {
    setError(null);
    if (!ready) return;
    try {
      const next = await signDetected(signed, setBusy, () => {}, setError, locale);
      if (next) deliver(next, () => {}, takeSignature, pathIndex, setError, locale);
    } catch (e) {
      setBusy(null);
      setError(localizeMessage(locale, e instanceof Error ? e.message : "tx.err.sign"));
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-2xs font-medium tracking-[0.14em] text-fg-subtle uppercase">{t("tx.export")}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={!ready} onClick={() => downloadPsbt(signed, "scriptwerk-send.psbt")}>{t("tx.psbt")}</Button>
          <Button type="button" variant="outline" disabled={!ready} onClick={() => setExportQr((v) => !v)}>{t("tx.exportQr")}</Button>
        </div>
        {exportQr && ready ? <QrPreview value={signed} label={t("tx.exportQr")} compact /> : null}
      </div>
      <div className="space-y-2">
        <p className="text-2xs font-medium tracking-[0.14em] text-fg-subtle uppercase">{t("tx.import")}</p>
        {ready ? <SigStatus psbt={signed} pathIndex={pathIndex} /> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => fileRef.current?.click()}>{t("tx.psbt")}</Button>
          <input
            ref={fileRef}
            type="file"
            accept=".psbt,.txn,application/octet-stream"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void readPsbtFile(file).then((text) => takeSignature(text));
            }}
          />
          <Button type="button" variant="outline" onClick={() => setImportQr(true)}>{t("tx.exportQr")}</Button>
          <Button type="button" variant="outline" disabled={!ready || !!busy} onClick={() => void usb()}>
            {busy ? t("tx.signing") : t("tx.usb")}
          </Button>
        </div>
      </div>
      <Dialog open={importQr} onOpenChange={setImportQr}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("tx.scan")}</DialogTitle>
            <DialogDescription>{t("tx.qrVideoHint")}</DialogDescription>
          </DialogHeader>
          <QrScanner
            video
            onRead={(text) => {
              takeSignature(text.trim());
              setImportQr(false);
            }}
          />
        </DialogContent>
      </Dialog>
      {error ? <p className="text-xs text-pretty text-danger">{error}</p> : null}
    </div>
  );
}

function BroadcastPane({ signed }: { signed: string }) {
  const { t, locale } = useT();
  const status = useBitcoind((s) => s.status);
  const demo = useBitcoind((s) => s.demo);
  const [txid, setTxid] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setError(null);
    setTxid("");
    setSending(true);
    try {
      const hex = extractSignedTx(signed);
      const node = useBitcoind.getState();
      const id = await broadcastRawTx({ url: node.url, username: node.username, password: node.password }, hex);
      setTxid(id);
    } catch (e) {
      setError(localizeMessage(locale, e instanceof Error ? e.message : "tx.err.broadcast"));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-2xs text-pretty text-fg-muted">{t("tx.signedBlurb")}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => void send()} disabled={sending || !signed.trim() || status !== "ready" || demo}>
          {sending ? t("tx.sending") : t("tx.broadcast")}
        </Button>
        <Button type="button" variant="outline" disabled={!signed.trim()} onClick={() => downloadSigned(signed)}>
          {t("tx.saveFile")}
        </Button>
      </div>
      {status !== "ready" || demo ? <p className="text-xs text-fg-muted">{t("tx.needNode")}</p> : null}
      {error ? <p className="text-xs text-pretty text-danger">{error}</p> : null}
      {txid ? (
        <div className="flex items-start gap-1">
          <p className="min-w-0 flex-1 break-all font-mono text-xs">{txid}</p>
          <CopyButton value={txid} label={t("tx.copyTxid")} />
        </div>
      ) : null}
    </div>
  );
}

function Step({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 border-t border-border pt-4">
      <h2 className="text-2xs font-medium tracking-[0.14em] text-fg-subtle uppercase">
        {n} · {title}
      </h2>
      {children}
    </section>
  );
}

function AddressField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  const { t } = useT();
  const [scan, setScan] = useState(false);
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <div className="mt-1 flex gap-2">
        <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} className="font-mono" autoComplete="off" spellCheck={false} />
        <Button type="button" variant="outline" size="icon" aria-label={t("tx.scan")} onClick={() => setScan(true)}>
          <QrCode />
        </Button>
      </div>
      <Dialog open={scan} onOpenChange={setScan}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("tx.scan")}</DialogTitle>
            <DialogDescription>{label}</DialogDescription>
          </DialogHeader>
          <QrScanner
            onRead={(text) => {
              onChange(addressFromScan(text));
              setScan(false);
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PsbtExport({ value, name, extra }: { value: string; name: string; extra?: ReactNode }) {
  const { t } = useT();
  const [qr, setQr] = useState(false);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={() => downloadPsbt(value, name)}>{t("tx.psbt")}</Button>
        <Button type="button" variant="outline" onClick={() => setQr((v) => !v)}>{t("tx.exportQr")}</Button>
        {extra}
      </div>
      {qr ? <QrPreview value={value} label={t("tx.exportQr")} compact /> : null}
    </div>
  );
}

function downloadBytes(bytes: Uint8Array, name: string) {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const url = URL.createObjectURL(new Blob([copy], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadPsbt(b64: string, name: string) {
  downloadBytes(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), name);
}

function downloadSigned(value: string) {
  const raw = value.trim().replace(/\s+/g, "");
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) {
    const bytes = new Uint8Array(raw.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(raw.slice(i * 2, i * 2 + 2), 16);
    const psbt = raw.toLowerCase().startsWith("70736274");
    downloadBytes(bytes, psbt ? "scriptwerk-signed.psbt" : "scriptwerk-signed.txn");
    return;
  }
  downloadPsbt(raw, "scriptwerk-signed.psbt");
}

function rowSats(row: PayRow): number {
  const n = satsFromDecimal(row.amount);
  return Number.isFinite(n) ? n : 0;
}

async function readPsbtFile(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const binary = bytes.length > 4 && bytes[0] === 0x70 && bytes[1] === 0x73 && bytes[2] === 0x62 && bytes[3] === 0x74;
  if (!binary) return new TextDecoder().decode(bytes).trim();
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function applyFee(
  payments: { address: string; sats: number }[],
  feeSats: number,
  fromChange: boolean,
): { address: string; sats: number }[] {
  if (fromChange) return payments;
  const next = payments.map((p) => ({ ...p }));
  let left = feeSats;
  for (let i = next.length - 1; i >= 0 && left > 0; i--) {
    const room = next[i]!.sats - 546;
    const take = Math.min(Math.max(0, room), left);
    next[i]!.sats -= take;
    left -= take;
  }
  if (left > 0) throw new Error("tx.dust");
  return next;
}

function asCoin(c: UtxoHit) {
  return { txid: c.txid, vout: c.vout, amountBtc: c.amount, address: c.address || "" };
}

async function walletMeta(descriptor: string, list: WatchAddr[], inputs: string[], outputs: string[]) {
  const wanted = [
    ...inputs.map((address) => ({ address, required: true })),
    ...outputs.map((address) => ({ address, required: false })),
  ];
  const spots: { change: number; index: number }[] = [];
  const ids: (string | null)[] = [];
  for (const row of wanted) {
    const hit = list.find((a) => a.address === row.address.trim());
    if (!hit) {
      if (row.required) throw new Error("tx.err.script");
      ids.push(null);
      continue;
    }
    const id = `${hit.kind === "change" ? 1 : 0}:${hit.index}`;
    if (!spots.some((s) => `${s.change}:${s.index}` === id)) spots.push({ change: hit.kind === "change" ? 1 : 0, index: hit.index });
    ids.push(id);
  }
  const expanded = spots.length ? await expandSpots(descriptor, spots) : [];
  const by = new Map<string, ScriptSpot>();
  spots.forEach((spot, i) => {
    const item = expanded[i];
    const expected = list.find((a) => (a.kind === "change" ? 1 : 0) === spot.change && a.index === spot.index);
    if (!item?.witnessScript || !item.derivations?.length || item.address !== expected?.address) throw new Error("tx.err.script");
    by.set(`${spot.change}:${spot.index}`, item);
  });
  const resolved = ids.map((id) => (id ? by.get(id) ?? null : null));
  return {
    inputs: resolved.slice(0, inputs.length).map((spot) => spot ?? { address: "", witnessScript: "", derivations: [] }),
    outputs: resolved.slice(inputs.length),
  };
}

function suggestChange(addresses: WatchAddr[], avoid: Set<string>): WatchAddr | null {
  return addresses.find((a) => a.kind === "change" && a.coins === 0 && a.address && !avoid.has(a.address)) ?? null;
}

function avoidSet(coins: UtxoHit[], rows: PayRow[]): Set<string> {
  const avoid = new Set<string>();
  for (const c of coins) if (c.address) avoid.add(c.address);
  for (const r of rows) if (r.address.trim()) avoid.add(r.address.trim());
  return avoid;
}

function coinPath(
  coin: UtxoHit,
  tip: number,
  stages: Stage[],
  reuse: boolean,
  root: ReturnType<typeof useStudio.getState>["root"],
  pathIndex: number | null,
) {
  if (pathIndex == null) return null;
  const status = evaluateCoinStatus({ height: coin.height, tip, stages, reuse, root });
  return status.paths[pathIndex] ?? null;
}

function pathLock(stages: Stage[], index: number): { older: number; after: number } {
  const slot = describeStageSlots(stages, false)[index];
  if (!slot || slot.delay <= 0) return { older: 0, after: 0 };
  return slot.lock === "after" ? { older: 0, after: slot.delay } : { older: slot.delay, after: 0 };
}

function spendSize(stages: Stage[], reuse: boolean, index = 0): { sigs: number; keys: number } {
  const slots = describeStageSlots(stages, reuse);
  const slot = slots[index] ?? slots[0];
  return { sigs: Math.max(1, slot?.k ?? 1), keys: Math.max(1, slot?.n ?? 1) };
}

function freshReceive(addresses: WatchAddr[], taken: Set<string>): string[] {
  const used = new Set(taken);
  const out: string[] = [];
  for (const a of addresses) {
    if (a.kind !== "receive" || a.coins > 0) continue;
    if (used.has(a.address)) continue;
    used.add(a.address);
    out.push(a.address);
  }
  return out;
}

async function signDetected(
  psbt: string,
  setBusy: (v: string | null) => void,
  setPsbt: (v: string) => void,
  setError: (v: string | null) => void,
  locale: "de" | "en",
) {
  try {
    const hw = useHardware.getState();
    const kind = hw.session && !hw.demo ? hw.session.kind : await pickUsbKind();
    return await sign(psbt, kind, setBusy, setPsbt, setError, locale);
  } catch (e) {
    setError(localizeMessage(locale, e instanceof Error ? e.message : "tx.err.sign"));
    return null;
  }
}

async function sign(
  psbt: string,
  kind: HwKind,
  setBusy: (v: string | null) => void,
  setPsbt: (v: string) => void,
  setError: (v: string | null) => void,
  locale: "de" | "en",
) {
  setError(null);
  setBusy(kind);
  try {
    const studio = useStudio.getState();
    if (!studio.root) throw new Error("tx.needPolicy");
    const compiled = compileBip388(studio.root, studio.keys, studio.policyName || "Scriptwerk", studio.reuseKeys);
    if (!compiled.ok) throw new Error(compiled.error);
    const hw = useHardware.getState();
    if (!hw.session || hw.demo || hw.kind !== kind) await hw.connect(kind, false);
    const session = useHardware.getState().session;
    if (!session || session.demo) throw new Error("tx.err.demoSign");
    const hmac = await useHardware.getState().registerPolicy(compiled.policy);
    const signed = await session.signPsbt({ psbt, policy: compiled.policy, hmac });
    const added = addedSignaturePubkeys(psbt, signed);
    const any = addedSignaturePubkeys("", signed);
    if (!added.length && !any.length) throw new Error("tx.err.noSig");
    setPsbt(signed);
    return { psbt: signed, added: added.length > 0 };
  } catch (e) {
    setError(localizeMessage(locale, e instanceof Error ? e.message : "tx.err.sign"));
    return null;
  } finally {
    setBusy(null);
  }
}

function deliver(
  next: { psbt: string; added: boolean },
  setPsbt: (v: string) => void,
  takeSignature: (v: string) => { merged: string; gained: boolean },
  pathIndex: number | null,
  setError: (v: string | null) => void,
  locale: "de" | "en",
) {
  const { merged, gained } = takeSignature(next.psbt);
  setPsbt(merged);
  if (next.added || gained) noteSigned(next.psbt, pathIndex);
  else setError(localizeMessage(locale, "tx.err.noSig"));
}

function noteSigned(psbt: string, pathIndex: number | null) {
  const studio = useStudio.getState();
  const locale = studio.locale === "en" ? "en" : "de";
  try {
    const report = signatureReport(psbt, {
      keys: studio.keys,
      stages: studio.stages,
      reuse: studio.reuseKeys,
      pathIndex,
    });
    const names = [...new Set(report.inputs.flatMap((input) => input.present.map((p) => p.label)))];
    toast.success(names.length ? translate(locale, "tx.signedOk", { name: names.join(", ") }) : translate(locale, "tx.signedOkBare"));
  } catch {
    toast.success(translate(locale, "tx.signedOkBare"));
  }
}

function SigStatus({ psbt, pathIndex }: { psbt: string; pathIndex: number | null }) {
  const { t, locale } = useT();
  const keys = useStudio((s) => s.keys);
  const stages = useStudio((s) => s.stages);
  const reuse = useStudio((s) => s.reuseKeys);
  const report = useMemo(() => {
    try {
      return signatureReport(psbt, { keys, stages, reuse, pathIndex });
    } catch {
      return null;
    }
  }, [psbt, keys, stages, reuse, pathIndex]);
  if (!report || !report.inputs.length) return <p className="text-xs text-fg-muted">{t("tx.sigRaw")}</p>;
  const slot = pathIndex == null ? null : describeStageSlots(stages, reuse)[pathIndex];
  const path = slot ? `${slot.quorum} · ${lockWhen(slot.lock, slot.delay, locale)}` : "";
  return (
    <ul className="space-y-1">
      {report.inputs.map((input) => (
        <li key={input.index} className="text-xs text-pretty text-fg">
          {input.present.length
            ? t("tx.sigPresent", { names: input.present.map((p) => p.label).join(", ") })
            : input.finalized
              ? t("tx.sigFinal", { n: String(input.index) })
              : t("tx.sigNone")}
          {pathIndex == null ? (
            <span className="mt-0.5 block text-fg-muted">{t("tx.sigPathNeed")}</span>
          ) : input.pathReady ? (
            <span className="mt-0.5 block text-ok">{t("tx.sigPathDone", { path })}</span>
          ) : (
            <span className="mt-0.5 block text-fg-muted">
              {t("tx.sigMissKeys", {
                path,
                n: String(Math.max(0, input.need - input.haveOnPath)),
                who: input.missing.join(", ") || "—",
              })}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
