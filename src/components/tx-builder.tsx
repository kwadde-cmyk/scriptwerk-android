import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { QrCode, Trash2 } from "lucide-react";
import { addressFromScan, addedSignaturePubkeys, btcToSats, buildPsbt, estimateVbytes, expandSpots, extractSignedTx, feeFromRate, mergePsbtSignatures, planPayments, samePsbtTransaction, satsFromDecimal, satsToDecimal, witnessScriptBytes, type ScriptSpot } from "@/lib/tx/psbt";
import { signatureReport } from "@/lib/tx/sigs";
import { type UtxoHit, type WatchAddr } from "@/lib/hw/address-check";
import { AmountInline } from "@/components/amount";
import { Tip } from "@/components/ui/tooltip";
import { checksumOf } from "@/lib/miniscript/checksum";
import { evaluateCoinStatus } from "@/lib/miniscript/coin-status";
import { describeStageSlots, type Stage } from "@/lib/miniscript/stages";
import { lockWhen, keyHeadline } from "@/lib/miniscript/keys";
import { coinsForPresent, inScope, openPathIndexes, pickPath, stageNeeds, type PathNeed, type RecoveryScope } from "@/lib/miniscript/recovery-select";
import { coinLabel } from "@/lib/bip329";
import { SpendCheckCard } from "@/components/spend-check";
import { compiledForStudio, isWpkhDescriptor } from "@/lib/miniscript/policy-mode";
import { broadcastRawTx } from "@/lib/bitcoind/rpc";
import { compileBip388 } from "@/lib/miniscript/bip388";
import { useBitcoind } from "@/store/bitcoind";
import { useHardware } from "@/store/hardware";
import { pickUsbKind } from "@/lib/hw/usb-kind";
import { isHmacHex } from "@/lib/hw/address-check";
import { useStudio } from "@/store/studio";
import { exportBase } from "@/lib/export-name";
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
type TxBrief = { outs: { address: string; sats: number }[]; feeSats: number; inputs: string[] } | null;

function shortAddr(address: string): string {
  const a = address.trim();
  if (a.length <= 18) return a || "—";
  return `${a.slice(0, 8)}…${a.slice(-6)}`;
}

function newRow(): PayRow {
  return { id: Math.random().toString(36).slice(2, 8), address: "", amount: "" };
}

export function TxTab() {
  const { t, locale } = useT();
  const stages = useStudio((s) => s.stages);
  const reuse = useStudio((s) => s.reuseKeys);
  const slots = useMemo(() => describeStageSlots(stages, reuse), [stages, reuse]);
  const [path, setPath] = useState<number | null>(null);
  const [signed, setSigned] = useState("");
  const signedRef = useRef("");
  const syncRef = useRef<(merged: string) => void>(() => {});
  const clearRef = useRef<() => void>(() => {});
  const pathIndex = slots.length <= 1 ? 0 : path;
  const [brief, setBrief] = useState<TxBrief>(null);
  const [sentTx, setSentTx] = useState("");
  const scanningWatch = useBitcoind((s) => s.scanningWatch);
  const unspents = useBitcoind((s) => s.lastWatch?.unspents);

  useEffect(() => {
    if (!sentTx || scanningWatch || !brief || !unspents) return;
    const live = new Set(unspents.map((u) => `${u.txid}:${u.vout}`));
    if (!brief.inputs.some((id) => !live.has(id))) return;
    signedRef.current = "";
    setSigned("");
    setSentTx("");
    setBrief(null);
    clearRef.current();
  }, [sentTx, scanningWatch, brief, unspents]);

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

  function discard() {
    signedRef.current = "";
    setSigned("");
    clearRef.current();
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
      <Step n="1" title={t("tx.stepBuild")}>
        <SendPane
          pathIndex={pathIndex}
          syncRef={syncRef}
          clearRef={clearRef}
          takeSignature={takeSignature}
          onPlan={(plan) => {
            setSentTx("");
            setBrief(plan ? { outs: plan.outputs, feeSats: plan.feeSats, inputs: plan.inputs.map((c) => `${c.txid}:${c.vout}`) } : null);
          }}
        />
      </Step>
      <Step n="2" title={t("tx.stepSign")}>
        <SignPane pathIndex={pathIndex} signed={signed} takeSignature={takeSignature} onDiscard={discard} />
      </Step>
      <Step n="3" title={t("tx.stepSend")}>
        <BroadcastPane
          signed={signed}
          brief={brief}
          sentTx={sentTx}
          onSent={(id) => {
            setSentTx(id);
            const built = compiledForStudio(useStudio.getState());
            if (built?.ok) void useBitcoind.getState().scanWatch(built.descriptor).catch(() => undefined);
          }}
        />
      </Step>
    </div>
  );
}

function SendPane({
  pathIndex,
  syncRef,
  clearRef,
  takeSignature,
  onPlan,
}: {
  pathIndex: number | null;
  syncRef: { current: (merged: string) => void };
  clearRef: { current: () => void };
  takeSignature: (next: string) => { merged: string; gained: boolean };
  onPlan: (plan: { outputs: { address: string; sats: number }[]; feeSats: number; inputs: { txid: string; vout: number }[] } | null) => void;
}) {
  const { t, locale } = useT();
  const nloc = numberLocale(locale);
  const root = useStudio((s) => s.root);
  const compiled = useStudio(compiledForStudio);
  const watch = useBitcoind((s) => s.lastWatch);
  const watchOk = watch && compiled?.ok && watch.checksum === checksumOf(compiled.descriptor) ? watch : null;
  const coins = watchOk?.unspents ?? NO_COINS;
  const addresses = watchOk?.addresses ?? NO_ADDRS;
  const watchHeight = watchOk?.height ?? 0;
  const probeBlocks = useBitcoind((s) => (s.probe && s.probe.chain !== "demo" ? s.probe.blocks : 0)) ?? 0;
  const tip = probeBlocks || watchHeight;
  const stages = useStudio((s) => s.stages);
  const reuse = useStudio((s) => s.reuseKeys);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [rows, setRows] = useState<PayRow[]>([newRow()]);
  const [change, setChange] = useState("");
  const [changeEdited, setChangeEdited] = useState(false);
  const [rate, setRate] = useState("2");
  const [feeAbs, setFeeAbs] = useState("");
  const [feeSource, setFeeSource] = useState<"rate" | "abs">("rate");
  const [psbt, setPsbt] = useState("");
  const [dustWarn, setDustWarn] = useState(false);
  const [feeOnChange, setFeeOnChange] = useState(false);
  const [error, setError] = useState<string | null>(null);
  syncRef.current = (merged) => {
    setPsbt((cur) => (cur && samePsbtTransaction(cur, merged) ? mergePsbtSignatures(cur, merged) : cur));
  };
  clearRef.current = () => {
    setPsbt("");
    setError(null);
    onPlan(null);
  };

  const selected = coins.filter((c) => picked.includes(`${c.txid}:${c.vout}`));
  const sumBtc = selected.reduce((s, c) => s + c.amount, 0);
  const suggested = useMemo(() => suggestChange(addresses, avoidSet(selected, rows)), [addresses, selected, rows]);
  const changeValue = changeEdited ? change : (suggested?.address ?? "");
  const size = spendSize(stages, reuse, pathIndex ?? 0);
  const scriptBytes = compiled?.ok && !isWpkhDescriptor(compiled.descriptor) ? witnessScriptBytes(compiled.miniscript) : 0;
  const entered = rows.filter((r) => r.address.trim());
  const gross = entered.reduce((s, r) => s + rowSats(r), 0);
  const inputSats = selected.reduce((s, c) => s + btcToSats(c.amount), 0);
  const vbytes = estimateVbytes({
    inputs: Math.max(1, selected.length),
    outputs: [...entered.map((r) => r.address), ...(changeValue ? [changeValue] : [""])],
    sigs: size.sigs,
    keys: size.keys,
    scriptBytes,
  });
  const feeSats = resolveFee(feeSource, rate, feeAbs, vbytes);
  const canFromChange = inputSats - gross - feeSats >= 546;
  const useChange = feeOnChange && canFromChange;
  const changeLeft = useChange ? inputSats - gross - feeSats : inputSats - gross;
  const dustChange = selected.length > 0 && entered.some((r) => rowSats(r) > 0) && changeLeft > 0 && changeLeft < 546;

  function confirmPick() {
    setPicked(draft);
    setOpen(false);
    setPsbt("");
    onPlan(null);
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
      onPlan(plan);
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
        {t("tx.sum")} <AmountInline btc={sumBtc} />
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
            <Tip label={t("tx.remove")}>
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
            </Tip>
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
      <div className="flex flex-wrap items-end gap-2">
        <FeePair id="tx-fee" vbytes={vbytes} rate={rate} abs={feeAbs} source={feeSource} onRate={setRate} onAbs={setFeeAbs} onSource={setFeeSource} />
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
                      <span className="shrink-0"><AmountInline btc={c.amount} /></span>
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

export function RecoveryTab() {
  const { t, locale } = useT();
  const stages = useStudio((s) => s.stages);
  const reuse = useStudio((s) => s.reuseKeys);
  const root = useStudio((s) => s.root);
  const keys = useStudio((s) => s.keys);
  const labels = useStudio((s) => s.labels);
  const compiled = useStudio(compiledForStudio);
  const watch = useBitcoind((s) => s.lastWatch);
  const snap = watch && compiled?.ok && watch.checksum === checksumOf(compiled.descriptor) ? watch : null;
  const probe = useBitcoind((s) => s.probe);
  const tip = probe?.blocks && probe.chain !== "demo" ? probe.blocks : snap?.height ?? 0;
  const slots = useMemo(() => describeStageSlots(stages, reuse), [stages, reuse]);
  const needs = useMemo(() => stageNeeds(stages, reuse, keys), [stages, reuse, keys]);
  const [scope, setScope] = useState<RecoveryScope>("open");
  const [stageIndex, setStageIndex] = useState(0);
  const [present, setPresent] = useState<string[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [mergeOn, setMergeOn] = useState<string[]>([]);
  const [drive, setDrive] = useState<"keys" | "coins">("coins");
  const [rate, setRate] = useState("2");
  const [feeAbs, setFeeAbs] = useState("");
  const [feeSource, setFeeSource] = useState<"rate" | "abs">("rate");
  const [built, setBuilt] = useState<{ id: string; psbt: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [signOpen, setSignOpen] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const [sent, setSent] = useState<Record<string, string>>({});
  const nodeStatus = useBitcoind((s) => s.status);
  const demo = useBitcoind((s) => s.demo);
  const presentSet = useMemo(() => new Set(present), [present]);

  const movable = useMemo(() => {
    return (snap?.unspents ?? []).flatMap((coin) => {
      if (!coin.address || coin.height <= 0) return [];
      const status = evaluateCoinStatus({ height: coin.height, tip, stages, reuse, root });
      const open = openPathIndexes(status.paths);
      if (!open.length) return [];
      return [{ id: `${coin.txid}:${coin.vout}`, coin, open, paths: status.paths, tag: coinLabel(labels, coin.txid, coin.vout, coin.address) }];
    });
  }, [snap, tip, stages, reuse, root, labels]);

  const visible = useMemo(
    () => movable.filter((c) => (scope === "open" ? noTimelock(c.open, slots) : inScope(c.open, "stage", stageIndex) || noTimelock(c.open, slots))),
    [movable, scope, stageIndex, slots],
  );

  useEffect(() => {
    if (drive === "keys") {
      const pool = movable.filter((c) => visible.some((v) => v.id === c.id));
      const bare = scope === "stage"
        ? coinsForPresent(pool.filter((c) => noTimelock(c.open, slots)), needs, presentSet, "open", null)
        : [];
      const next = [...new Set([...coinsForPresent(pool, needs, presentSet, scope, stageIndex), ...bare])];
      setPicked((cur) => (cur.length === next.length && cur.every((id, i) => id === next[i]) ? cur : next));
      return;
    }
    setPicked((cur) => {
      const next = cur.filter((id) => visible.some((c) => c.id === id));
      return next.length === cur.length && next.every((id, i) => id === cur[i]) ? cur : next;
    });
  }, [drive, movable, needs, presentSet, scope, stageIndex, visible, slots]);

  function onKeys(names: string[]) {
    setPresent(names);
    setDrive("keys");
  }

  function toggleCoin(id: string) {
    setDrive("coins");
    setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  const selected = visible.filter((c) => picked.includes(c.id));
  const rows = selected.map((row) => ({
    ...row,
    pathIndex: pickPath(scope === "stage" ? row.open.filter((n) => n === stageIndex) : row.open, needs, presentSet) ?? row.open[0] ?? 0,
  }));
  const bundles = bundleByTag(rows, new Set(mergeOn)).map((bundle, i, all) => {
    const taken = new Set(all.flatMap((b) => b.members.map((m) => m.coin.address || "")));
    return { ...bundle, dest: freshReceive(snap?.addresses ?? [], taken)[i] ?? "" };
  });
  const needPaths = [...new Set(rows.map((r) => r.pathIndex))];
  const scriptBytes = compiled?.ok && !isWpkhDescriptor(compiled.descriptor) ? witnessScriptBytes(compiled.miniscript) : 0;
  const tagged = visible.filter((c) => c.tag.trim());
  const allMerge = tagged.length > 0 && tagged.every((c) => mergeOn.includes(c.id));

  function toggleMerge(id: string) {
    setMergeOn((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  function setAllMerge(on: boolean) {
    const ids = tagged.map((c) => c.id);
    setMergeOn((cur) => (on ? [...new Set([...cur, ...ids])] : cur.filter((id) => !ids.includes(id))));
  }

  async function buildAll() {
    setError(null);
    const next: { id: string; psbt: string }[] = [];
    try {
      if (!compiled?.ok) throw new Error("tx.err.script");
      for (const bundle of bundles) {
        if (!bundle.dest) throw new Error("tx.err.fresh");
        if (bundle.members.some((m) => bundle.dest === m.coin.address)) throw new Error("tx.err.reuse");
        const size = spendSize(stages, reuse, bundle.pathIndex);
        const vb = estimateVbytes({ inputs: bundle.members.length, outputs: [bundle.dest], sigs: size.sigs, keys: size.keys, scriptBytes });
        const feeSats = resolveFee(feeSource, rate, feeAbs, vb);
        const total = bundle.members.reduce((sum, m) => sum + btcToSats(m.coin.amount), 0);
        const locks = pathLock(stages, bundle.pathIndex);
        const plan = planPayments({
          coins: bundle.members.map((m) => asCoin(m.coin)),
          payments: [{ address: bundle.dest, sats: total - feeSats }],
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
        next.push({ id: bundle.id, psbt: buildPsbt(plan, meta) });
      }
      setBuilt(next);
      setSent({});
    } catch (e) {
      setBuilt([]);
      setSent({});
      setError(localizeMessage(locale, e instanceof Error ? e.message : "tx.funds"));
    }
  }

  async function broadcast(psbt: string) {
    const hex = extractSignedTx(psbt);
    const node = useBitcoind.getState();
    return broadcastRawTx({ url: node.url, username: node.username, password: node.password }, hex);
  }

  async function sendOne(id: string, psbt: string) {
    setError(null);
    setSending(id);
    try {
      const txid = await broadcast(psbt);
      setSent((cur) => ({ ...cur, [id]: txid }));
      refreshWatch();
    } catch (e) {
      setError(localizeMessage(locale, e instanceof Error ? e.message : "tx.err.broadcast"));
    } finally {
      setSending(null);
    }
  }

  async function sendAll() {
    const queue = bundles.filter((bundle) => readyIds.has(bundle.id));
    if (!queue.length) return;
    setError(null);
    setSending("all");
    let failed = "";
    let sentAny = false;
    for (const bundle of queue) {
      const psbt = built.find((b) => b.id === bundle.id)?.psbt ?? "";
      try {
        const txid = await broadcast(psbt);
        sentAny = true;
        setSent((cur) => ({ ...cur, [bundle.id]: txid }));
      } catch (e) {
        if (!failed) failed = localizeMessage(locale, e instanceof Error ? e.message : "tx.err.broadcast");
      }
    }
    setSending(null);
    if (sentAny) refreshWatch();
    if (failed) setError(failed);
  }

  const nodeOk = nodeStatus === "ready" && !demo;
  const scanningWatch = useBitcoind((s) => s.scanningWatch);
  const readyIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of built) {
      if (sent[item.id]) continue;
      try {
        extractSignedTx(item.psbt);
        ids.add(item.id);
      } catch {
        /* still unsigned */
      }
    }
    return ids;
  }, [built, sent]);

  const liveIds = bundles.map((b) => b.id).join("|");
  useEffect(() => {
    if (scanningWatch) return;
    const live = new Set(liveIds ? liveIds.split("|") : []);
    setSent((cur) => {
      const ids = Object.keys(cur);
      if (!ids.some((id) => !live.has(id))) return cur;
      const next: Record<string, string> = {};
      for (const id of ids) if (live.has(id) && cur[id]) next[id] = cur[id];
      return next;
    });
  }, [liveIds, scanningWatch]);

  function refreshWatch() {
    if (!compiled?.ok) return;
    void useBitcoind.getState().scanWatch(compiled.descriptor).catch(() => undefined);
  }

  let readyOut = 0;
  let readyFee = 0;
  for (const bundle of bundles) {
    if (!readyIds.has(bundle.id)) continue;
    const size = spendSize(stages, reuse, bundle.pathIndex);
    const vb = estimateVbytes({ inputs: bundle.members.length, outputs: [bundle.dest || ""], sigs: size.sigs, keys: size.keys, scriptBytes });
    const feeSats = resolveFee(feeSource, rate, feeAbs, vb);
    const total = bundle.members.reduce((sum, m) => sum + btcToSats(m.coin.amount), 0);
    readyOut += Math.max(0, total - feeSats);
    readyFee += feeSats;
  }

  const sample = bundles[0];
  const sampleSize = spendSize(stages, reuse, sample?.pathIndex ?? 0);

  return (
    <div className="space-y-5">
      <p className="text-2xs text-pretty text-fg-muted">{t("rec.blurb")}</p>
      <div className="flex gap-1 rounded-lg border border-border p-1">
        <Button type="button" className="flex-1" variant={scope === "stage" ? "default" : "outline"} onClick={() => setScope("stage")}>
          {t("rec.byStage")}
        </Button>
        <Button type="button" className="flex-1" variant={scope === "open" ? "default" : "outline"} onClick={() => setScope("open")}>
          {t("rec.allOpen")}
        </Button>
      </div>
      {scope === "stage" ? (
        <div className="flex flex-wrap gap-2">
          {slots.map((slot, i) => (
            <Button key={slot.id} type="button" variant={stageIndex === i ? "default" : "outline"} onClick={() => setStageIndex(i)}>
              {slot.quorum} · {lockWhen(slot.lock, slot.delay, locale)}
            </Button>
          ))}
        </div>
      ) : null}
      <p className="text-2xs text-pretty text-fg-muted">{t("rec.keysHint")}</p>
      <SpendCheckCard present={present} onPresentChange={onKeys} keysOnly />
      {rows.length ? (
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-2xs font-medium tracking-[0.14em] text-fg-subtle uppercase">{t("rec.need")}</h2>
          <span className="font-mono text-2xs text-fg-muted">{t("rec.selected", { n: rows.length })}</span>
        </div>
        <ul className="space-y-1">
          {needPaths.map((i) => {
            const need = needs[i];
            if (!need) return null;
            return <NeedLine key={i} need={need} present={presentSet} slotLabel={slots[i] ? `${slots[i].quorum} · ${lockWhen(slots[i].lock, slots[i].delay, locale)}` : need.quorum} />;
          })}
        </ul>
      </section>
      ) : null}
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-2xs font-medium tracking-[0.14em] text-fg-subtle uppercase">{t("rec.coins")}</h2>
          <Button type="button" variant={allMerge ? "default" : "outline"} disabled={!tagged.length} aria-pressed={allMerge} onClick={() => setAllMerge(!allMerge)}>
            {t("rec.mergeTag")}
          </Button>
        </div>
        {tagged.length ? <p className="text-2xs text-pretty text-fg-muted">{t("rec.mergeHint")}</p> : null}
        {!visible.length ? <p className="text-xs text-fg-muted">{t("rec.empty")}</p> : null}
        <ul className="space-y-1">
          {visible.map((row) => {
            const on = picked.includes(row.id);
            const merge = mergeOn.includes(row.id);
            return (
              <li key={row.id} className="flex items-stretch gap-1">
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleCoin(row.id)}
                  className={
                    on
                      ? "flex min-h-11 min-w-0 flex-1 items-center justify-between gap-2 rounded-md bg-muted px-3 py-2 text-left text-xs"
                      : "flex min-h-11 min-w-0 flex-1 items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-left text-xs text-fg-muted"
                  }
                >
                  <span className="min-w-0">
                    <span className="block truncate font-mono">{row.coin.txid.slice(0, 10)}…:{row.coin.vout}</span>
                    <span className="block text-2xs text-fg-subtle">
                      {row.open.map((i) => slots[i] ? `${slots[i].quorum} · ${lockWhen(slots[i].lock, slots[i].delay, locale)}` : "").filter(Boolean).join(" · ")}
                    </span>
                    {scope === "stage" && noTimelock(row.open, slots) ? (() => {
                      const next = row.paths.filter((p) => !p.open && p.blocksLeft > 0).sort((a, b) => a.blocksLeft - b.blocksLeft)[0];
                      return next ? <span className="mt-0.5 block text-2xs text-fg-muted">{t("rec.nextLock", { n: next.index, m: next.blocksLeft })}</span> : null;
                    })() : null}
                  </span>
                  <AmountInline btc={row.coin.amount} />
                </button>
                {row.tag.trim() ? (
                  <button
                    type="button"
                    aria-pressed={merge}
                    onClick={() => toggleMerge(row.id)}
                    className={
                      merge
                        ? "max-w-28 shrink-0 rounded-md bg-primary px-2 text-2xs text-primary-foreground"
                        : "max-w-28 shrink-0 rounded-md border border-border px-2 text-2xs text-fg-muted"
                    }
                  >
                    <span className="block truncate">{row.tag}</span>
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
      <FeePair
        id="tx-rec-fee"
        vbytes={sample ? estimateVbytes({ inputs: sample.members.length, outputs: [sample.dest || ""], sigs: sampleSize.sigs, keys: sampleSize.keys, scriptBytes }) : 0}
        rate={rate}
        abs={feeAbs}
        source={feeSource}
        onRate={setRate}
        onAbs={setFeeAbs}
        onSource={setFeeSource}
      />
      <ul className="space-y-3">
        {bundles.map((bundle) => {
          const psbt = built.find((b) => b.id === bundle.id)?.psbt ?? "";
          const size = spendSize(stages, reuse, bundle.pathIndex);
          const vb = estimateVbytes({ inputs: bundle.members.length, outputs: [bundle.dest || ""], sigs: size.sigs, keys: size.keys, scriptBytes });
          const feeSats = resolveFee(feeSource, rate, feeAbs, vb);
          const total = bundle.members.reduce((sum, m) => sum + btcToSats(m.coin.amount), 0);
          const outSats = Math.max(0, total - feeSats);
          const title = bundle.tag
            ? `${bundle.tag} · ${bundle.members.length}`
            : `${bundle.members[0]?.coin.txid.slice(0, 12) ?? ""}…:${bundle.members[0]?.coin.vout ?? ""}`;
          return (
            <li key={bundle.id} className="space-y-2 rounded-md border border-border p-3">
              <p className="font-mono text-2xs text-fg-muted">{title}</p>
              {bundle.members.map((m) => (
                <p key={m.id} className="break-all font-mono text-xs">{t("tx.from")} {m.coin.address}</p>
              ))}
              <p className="break-all font-mono text-xs">{t("tx.to")} {bundle.dest || t("tx.noFresh")}</p>
              <p className="text-xs text-fg-muted">
                <AmountInline btc={outSats / 1e8} /> · {t("tx.feeHint", { vb: String(vb), sats: String(feeSats) })}
              </p>
              {psbt && (readyIds.has(bundle.id) || sent[bundle.id]) ? (
                <p className="text-xs text-fg">
                  <AmountInline btc={outSats / 1e8} />
                  <span className="text-fg-muted"> → </span>
                  <span className="font-mono">{shortAddr(bundle.dest)}</span>
                  <span className="text-fg-muted">
                    {" "}
                    · {feeSats.toLocaleString(numberLocale(locale))} sat
                    {slots[bundle.pathIndex] ? ` · ${t("wallet.stageChip", { n: slots[bundle.pathIndex].index })}` : ""}
                  </span>
                </p>
              ) : null}
              {psbt ? <SigStatus psbt={psbt} pathIndex={bundle.pathIndex} /> : null}
              {psbt ? (
                <div className="flex flex-wrap items-center gap-2">
                  {sent[bundle.id] ? (
                    <span className="inline-flex min-w-0 items-center gap-1 text-xs text-ok">
                      {t("tx.sent")}
                      <span className="truncate font-mono text-2xs text-fg-muted">{sent[bundle.id]!.slice(0, 10)}…</span>
                      <CopyButton value={sent[bundle.id]!} label={t("tx.copyTxid")} />
                    </span>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!readyIds.has(bundle.id) || !nodeOk || sending != null}
                      onClick={() => void sendOne(bundle.id, psbt)}
                    >
                      {sending === bundle.id ? t("tx.sending") : t("rec.send")}
                    </Button>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => void buildAll()} disabled={!bundles.length}>{t("rec.buildN", { n: bundles.length })}</Button>
        <Button type="button" variant="outline" disabled={!built.length} onClick={() => setSignOpen(true)}>{t("rec.signAll")}</Button>
        <Button type="button" variant="outline" disabled={!readyIds.size || !nodeOk || sending != null} onClick={() => void sendAll()}>
          {sending === "all" ? t("tx.sending") : t("rec.sendAll")}
        </Button>
        {readyIds.size ? (
          <span className="text-xs text-fg-muted">
            {t("rec.readyN", { n: readyIds.size, fee: readyFee.toLocaleString(numberLocale(locale)) })}
            {" · "}
            <AmountInline btc={readyOut / 1e8} />
          </span>
        ) : null}
      </div>
      {built.length && !nodeOk ? <p className="text-xs text-fg-muted">{t("tx.needNode")}</p> : null}
      <RecoverySignDialog
        open={signOpen}
        onOpenChange={setSignOpen}
        items={bundles.flatMap((bundle) => {
          const psbt = built.find((b) => b.id === bundle.id)?.psbt;
          if (!psbt) return [];
          const title = bundle.tag
            ? `${bundle.tag} · ${bundle.members.length}`
            : `${bundle.members[0]?.coin.txid.slice(0, 10) ?? ""}…:${bundle.members[0]?.coin.vout ?? ""}`;
          return [{ id: bundle.id, psbt, pathIndex: bundle.pathIndex, title }];
        })}
        onUpdate={(id, psbt) => {
          setBuilt((cur) => cur.map((b) => (b.id === id ? { ...b, psbt } : b)));
          setSent((cur) => {
            if (!cur[id]) return cur;
            const next = { ...cur };
            delete next[id];
            return next;
          });
        }}
      />
      {error ? <p className="text-xs text-pretty text-danger">{error}</p> : null}
    </div>
  );
}

function NeedLine({ need, present, slotLabel }: { need: PathNeed; present: ReadonlySet<string>; slotLabel: string }) {
  const { t } = useT();
  const missingMust = need.mustLabels.filter((_, i) => !present.has(need.must[i] ?? ""));
  const restHave = need.rest.filter((n) => present.has(n)).length;
  const restMissing = need.restLabels.filter((_, i) => !present.has(need.rest[i] ?? ""));
  return (
    <li className="text-xs text-pretty text-fg">
      <span className="font-mono text-2xs text-fg-muted">{slotLabel}</span>
      {missingMust.length ? <span className="mt-0.5 block text-danger">{t("spend.mustHave")}: {missingMust.join(", ")}</span> : null}
      {need.restNeed > restHave ? (
        <span className="mt-0.5 block">{t("spend.needOf", { k: need.restNeed - restHave, keys: restMissing.join(", ") || "—" })}</span>
      ) : (
        <span className="mt-0.5 block text-ok">{t("spend.now")}</span>
      )}
    </li>
  );
}

type SignItem = { id: string; psbt: string; pathIndex: number; title: string };
type SignTransport = "qr" | "file" | "ledger" | "bitbox";

function mentionsKey(label: string, name: string, note: string): boolean {
  if (note && (label === note || label.startsWith(`${note} `))) return true;
  return label.split(/\s+/).some((part) => part === name || (part.startsWith(name) && /^\d+$/.test(part.slice(name.length))));
}

function RecoverySignDialog({
  open,
  onOpenChange,
  items,
  onUpdate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: SignItem[];
  onUpdate: (id: string, psbt: string) => void;
}) {
  const { t, locale } = useT();
  const keys = useStudio((s) => s.keys);
  const stages = useStudio((s) => s.stages);
  const reuse = useStudio((s) => s.reuseKeys);
  const hmac = useHardware((s) => s.lastHmac);
  const compiled = useStudio(compiledForStudio);
  const needs = useMemo(() => stageNeeds(stages, reuse, keys), [stages, reuse, keys]);
  const [phase, setPhase] = useState<"pick" | "run">("pick");
  const [keyName, setKeyName] = useState("");
  const [transport, setTransport] = useState<SignTransport | null>(null);
  const [scan, setScan] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open && !wasOpen.current) {
      setPhase("pick");
      setKeyName("");
      setTransport(null);
      setScan(false);
      setError(null);
    }
    wasOpen.current = open;
  }, [open]);

  function reportOf(item: SignItem) {
    try {
      return signatureReport(item.psbt, { keys, stages, reuse, pathIndex: item.pathIndex });
    } catch {
      return null;
    }
  }

  function gapOf(item: SignItem): number {
    const report = reportOf(item);
    if (!report) return 0;
    return report.inputs.reduce((n, input) => (input.pathReady ? n : n + Math.max(0, input.need - input.haveOnPath)), 0);
  }

  function onPath(item: SignItem, name: string): boolean {
    const need = needs[item.pathIndex];
    return Boolean(need && (need.must.includes(name) || need.rest.includes(name)));
  }

  function signedBy(item: SignItem, name: string): boolean {
    const key = keys.find((k) => k.name === name);
    const note = key?.note.trim() ?? "";
    const report = reportOf(item);
    return Boolean(report?.inputs.some((input) => input.present.some((p) => p.onPath && mentionsKey(p.label, name, note))));
  }

  function waiting(item: SignItem, name: string): boolean {
    return onPath(item, name) && gapOf(item) > 0 && !signedBy(item, name);
  }

  const masters = keys.filter((k) => k.name.trim()).sort((a, b) => a.name.localeCompare(b.name));
  const involved = masters.filter((k) => items.some((item) => onPath(item, k.name)));
  const forKey = items.filter((item) => keyName && onPath(item, keyName));
  const queue = forKey.filter((item) => waiting(item, keyName));
  const current = queue[0];
  const leftSigs = items.reduce((n, item) => n + gapOf(item), 0);
  const wpkh = Boolean(compiled?.ok && isWpkhDescriptor(compiled.descriptor));
  const registerFirst = transport === "ledger" && !wpkh && !isHmacHex(hmac);

  function take(text: string) {
    if (!current) return;
    setError(null);
    const next = text.trim();
    if (!samePsbtTransaction(current.psbt, next)) {
      setError(localizeMessage(locale, "tx.err.qr"));
      return;
    }
    const merged = mergePsbtSignatures(current.psbt, next);
    if (!addedSignaturePubkeys(current.psbt, merged).length) {
      setError(localizeMessage(locale, "tx.err.noSig"));
      return;
    }
    onUpdate(current.id, merged);
    noteSigned(merged, current.pathIndex);
  }

  async function takeFiles(list: File[]) {
    setError(null);
    const pending = queue;
    let missed = 0;
    for (const file of list) {
      const text = (await readPsbtFile(file)).trim();
      const hit = pending.find((item) => samePsbtTransaction(item.psbt, text));
      if (!hit) {
        missed += 1;
        continue;
      }
      const merged = mergePsbtSignatures(hit.psbt, text);
      if (!addedSignaturePubkeys(hit.psbt, merged).length) {
        missed += 1;
        continue;
      }
      onUpdate(hit.id, merged);
      noteSigned(merged, hit.pathIndex);
    }
    if (missed) setError(localizeMessage(locale, "tx.err.qr"));
  }

  async function sendDevice() {
    if (!current || (transport !== "ledger" && transport !== "bitbox")) return;
    setError(null);
    const next = await sign(current.psbt, transport, setBusy, (psbt) => onUpdate(current.id, psbt), setError, locale);
    if (next?.added) noteSigned(next.psbt, current.pathIndex);
  }

  const active = keys.find((k) => k.name === keyName);

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>{t("rec.signTitle")}</DialogTitle>
          <DialogDescription>{t("rec.signBlurb")}</DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[calc(85vh-8rem)]">
        <div className="space-y-3 pr-3">
        <p className="text-sm text-fg">{t("rec.leftSigs", { n: leftSigs })}</p>
        {phase === "pick" ? (
          <div className="space-y-4">
            <div>
              <p className="text-2xs font-medium tracking-[0.14em] text-fg-subtle uppercase">{t("rec.whichKey")}</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {involved.map((k) => {
                  const left = items.filter((item) => waiting(item, k.name)).length;
                  const on = keyName === k.name;
                  return (
                    <button
                      key={k.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setKeyName(k.name)}
                      className={
                        on
                          ? "min-h-9 rounded-full bg-primary px-3 text-xs text-primary-foreground"
                          : "min-h-9 rounded-full border border-border px-3 text-xs text-fg-muted"
                      }
                    >
                      {keyHeadline(k)}
                      <span className="ml-1.5 font-mono text-2xs opacity-70">{k.name}</span>
                      <span className="ml-1.5 font-mono text-2xs opacity-70">{left}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <p className="text-2xs font-medium tracking-[0.14em] text-fg-subtle uppercase">{t("rec.transport")}</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {(["qr", "file", "ledger", "bitbox"] as const).map((kind) => (
                  <Button key={kind} type="button" variant={transport === kind ? "default" : "outline"} onClick={() => setTransport(kind)}>
                    {kind === "qr" ? t("tx.exportQr") : kind === "file" ? t("rec.file") : kind === "ledger" ? "Ledger" : "BitBox"}
                  </Button>
                ))}
              </div>
            </div>
            <Button type="button" disabled={!keyName || !transport} onClick={() => { setError(null); setPhase("run"); }}>
              {t("rec.start")}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-fg-muted">{active ? keyHeadline(active) : keyName} · {transport === "qr" ? t("tx.exportQr") : transport === "file" ? t("rec.file") : transport === "ledger" ? "Ledger" : "BitBox"}</p>
              <Button type="button" variant="ghost" onClick={() => setPhase("pick")}>{t("rec.nextKey")}</Button>
            </div>
            {!current ? (
              <p className="text-sm text-fg">{forKey.length ? t("rec.keyDone") : t("rec.noQueue")}</p>
            ) : (
              <>
                <p className="text-sm text-fg">
                  {t("rec.txOf", { i: forKey.length - queue.length + 1, n: forKey.length })}
                  <span className="mt-0.5 block font-mono text-xs text-fg-muted">{current.title}</span>
                  <span className="mt-0.5 block text-xs text-fg-muted">{t("rec.txGap", { n: gapOf(current) })}</span>
                </p>
                {registerFirst ? <p className="text-xs text-pretty text-fg-muted">{t("rec.ledgerReg")}</p> : null}
                {transport === "qr" ? (
                  <>
                    <QrPreview value={current.psbt} label={t("tx.exportQr")} />
                    <Button type="button" variant="outline" onClick={() => setScan(true)}>{t("rec.importBack")}</Button>
                  </>
                ) : null}
                {transport === "file" ? (
                  <div className="space-y-2">
                    <p className="text-xs text-pretty text-fg-muted">{t("rec.fileAll")}</p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() =>
                          downloadPsbtZip(
                            queue.map((item, i) => ({
                              name: `${String(i + 1).padStart(2, "0")}-${item.id.replace(":", "-")}.psbt`,
                              b64: item.psbt,
                            })),
                            `${exportBase(useStudio.getState().policyName)}-${keyName || "recovery"}.zip`,
                          )
                        }
                      >
                        {t("rec.downloadAll")}
                      </Button>
                      <Button type="button" variant="outline" onClick={() => fileRef.current?.click()}>{t("rec.importBack")}</Button>
                      <input
                        ref={fileRef}
                        type="file"
                        multiple
                        accept=".psbt,.txn,application/octet-stream"
                        className="hidden"
                        onChange={(e) => {
                          const files = e.target.files ? [...e.target.files] : [];
                          e.target.value = "";
                          if (files.length) void takeFiles(files);
                        }}
                      />
                    </div>
                  </div>
                ) : null}
                {transport === "ledger" || transport === "bitbox" ? (
                  <Button type="button" variant="outline" disabled={!!busy} onClick={() => void sendDevice()}>
                    {busy ? t("tx.signing") : t("rec.sendDevice")}
                  </Button>
                ) : null}
                <SigStatus psbt={current.psbt} pathIndex={current.pathIndex} />
              </>
            )}
          </div>
        )}
        {error ? <p className="text-xs text-pretty text-danger">{error}</p> : null}
        </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
    <Dialog open={scan} onOpenChange={setScan}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("tx.scan")}</DialogTitle>
          <DialogDescription>{t("tx.qrVideoHint")}</DialogDescription>
        </DialogHeader>
        <QrScanner
          video
          onRead={(text) => {
            take(text.trim());
            setScan(false);
          }}
        />
      </DialogContent>
    </Dialog>
    </>
  );
}

function SignPane({
  pathIndex,
  signed,
  takeSignature,
  onDiscard,
}: {
  pathIndex: number | null;
  signed: string;
  takeSignature: (next: string) => { merged: string; gained: boolean };
  onDiscard: () => void;
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
          <Button type="button" variant="outline" disabled={!ready} onClick={() => downloadPsbt(signed, `${exportBase(useStudio.getState().policyName)}-send.psbt`)}>{t("tx.psbt")}</Button>
          <Button type="button" variant="outline" disabled={!ready} onClick={() => setExportQr((v) => !v)}>{t("tx.exportQr")}</Button>
          <Tip label={t("tx.discard")}>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={t("tx.discard")}
              disabled={!ready}
              onClick={() => {
                setExportQr(false);
                setError(null);
                onDiscard();
              }}
            >
              <Trash2 />
            </Button>
          </Tip>
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

function BroadcastPane({
  signed,
  brief,
  sentTx,
  onSent,
}: {
  signed: string;
  brief: TxBrief;
  sentTx: string;
  onSent: (txid: string) => void;
}) {
  const { t, locale } = useT();
  const status = useBitcoind((s) => s.status);
  const demo = useBitcoind((s) => s.demo);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setError(null);
    setSending(true);
    try {
      const hex = extractSignedTx(signed);
      const node = useBitcoind.getState();
      const id = await broadcastRawTx({ url: node.url, username: node.username, password: node.password }, hex);
      onSent(id);
    } catch (e) {
      setError(localizeMessage(locale, e instanceof Error ? e.message : "tx.err.broadcast"));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-2">
      {brief && signed.trim() ? (
        <div className="space-y-1 text-xs">
          {brief.outs.map((o) => (
            <p key={`${o.address}:${o.sats}`}>
              <AmountInline btc={o.sats / 1e8} />
              <span className="text-fg-muted"> → </span>
              <span className="font-mono">{shortAddr(o.address)}</span>
            </p>
          ))}
          <p className="text-fg-muted">{brief.feeSats.toLocaleString(numberLocale(locale))} sat</p>
        </div>
      ) : (
        <p className="text-2xs text-pretty text-fg-muted">{t("tx.signedBlurb")}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {sentTx ? (
          <span className="inline-flex min-w-0 items-center gap-1 text-xs text-ok">
            {t("tx.sent")}
            <span className="truncate font-mono text-2xs text-fg-muted">{sentTx.slice(0, 10)}…</span>
            <CopyButton value={sentTx} label={t("tx.copyTxid")} />
          </span>
        ) : (
          <Button type="button" onClick={() => void send()} disabled={sending || !signed.trim() || status !== "ready" || demo}>
            {sending ? t("tx.sending") : t("tx.broadcast")}
          </Button>
        )}
        <Button type="button" variant="outline" disabled={!signed.trim()} onClick={() => downloadSigned(signed)}>
          {t("tx.saveFile")}
        </Button>
      </div>
      {status !== "ready" || demo ? <p className="text-xs text-fg-muted">{t("tx.needNode")}</p> : null}
      {error ? <p className="text-xs text-pretty text-danger">{error}</p> : null}
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
        <Tip label={t("tx.scan")}>
        <Button type="button" variant="outline" size="icon" aria-label={t("tx.scan")} onClick={() => setScan(true)}>
          <QrCode />
        </Button>
        </Tip>
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

function resolveFee(source: "rate" | "abs", rate: string, abs: string, vbytes: number): number {
  if (source === "abs") {
    const n = Number(abs.replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }
  return feeFromRate(Number(rate.replace(",", ".")), vbytes);
}

function shownRate(source: "rate" | "abs", rate: string, feeSats: number, vbytes: number): string {
  if (source === "rate") return rate;
  if (vbytes < 1 || feeSats < 1) return "";
  const n = Math.round((feeSats / vbytes) * 1000) / 1000;
  return String(n);
}

function FeePair({
  id,
  vbytes,
  rate,
  abs,
  source,
  onRate,
  onAbs,
  onSource,
}: {
  id: string;
  vbytes: number;
  rate: string;
  abs: string;
  source: "rate" | "abs";
  onRate: (v: string) => void;
  onAbs: (v: string) => void;
  onSource: (s: "rate" | "abs") => void;
}) {
  const { t } = useT();
  const feeSats = resolveFee(source, rate, abs, vbytes);
  return (
    <>
      <div className="w-28">
        <Label htmlFor={`${id}-rate`}>{t("tx.feeRate")}</Label>
        <Input
          id={`${id}-rate`}
          inputMode="decimal"
          value={shownRate(source, rate, feeSats, vbytes)}
          onChange={(e) => {
            onSource("rate");
            onRate(e.target.value);
          }}
          className="mt-1 font-mono"
        />
      </div>
      <div className="w-32">
        <Label htmlFor={`${id}-abs`}>{t("tx.feeAbs")}</Label>
        <Input
          id={`${id}-abs`}
          inputMode="numeric"
          value={source === "abs" ? abs : feeSats > 0 ? String(feeSats) : ""}
          onChange={(e) => {
            onSource("abs");
            onAbs(e.target.value);
          }}
          className="mt-1 font-mono"
        />
      </div>
    </>
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

function crc32(data: Uint8Array): number {
  let c = ~0;
  for (const b of data) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return ~c >>> 0;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function downloadPsbtZip(files: { name: string; b64: string }[], zipName: string) {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = enc.encode(file.name);
    const raw = file.b64.trim();
    const data = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    const head = new Uint8Array(local.buffer);
    locals.push(head, name, data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, data.length, true);
    cen.setUint32(24, data.length, true);
    cen.setUint16(28, name.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), name);
    offset += head.length + name.length + data.length;
  }
  const directory = concatBytes(central);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, directory.length, true);
  eocd.setUint32(16, offset, true);
  downloadBytes(concatBytes([...locals, directory, new Uint8Array(eocd.buffer)]), zipName);
}

function downloadSigned(value: string) {
  const base = exportBase(useStudio.getState().policyName);
  const raw = value.trim().replace(/\s+/g, "");
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) {
    const bytes = new Uint8Array(raw.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(raw.slice(i * 2, i * 2 + 2), 16);
    const psbt = raw.toLowerCase().startsWith("70736274");
    downloadBytes(bytes, psbt ? `${base}-signed.psbt` : `${base}-signed.txn`);
    return;
  }
  downloadPsbt(raw, `${base}-signed.psbt`);
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
    if ((!item?.witnessScript && !isWpkhDescriptor(descriptor)) || !item?.derivations?.length || item.address !== expected?.address) throw new Error("tx.err.script");
    by.set(`${spot.change}:${spot.index}`, item);
  });
  const resolved = ids.map((id) => (id ? by.get(id) ?? null : null));
  return {
    inputs: resolved.slice(0, inputs.length).map((spot) => spot ?? { address: "", witnessScript: "", derivations: [] }),
    outputs: resolved.slice(inputs.length),
  };
}

function suggestChange(addresses: WatchAddr[], avoid: Set<string>): WatchAddr | null {
  return addresses.find((a) => a.kind === "change" && a.coins === 0 && !a.used && a.address && !avoid.has(a.address)) ?? null;
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

function noTimelock(open: number[], slots: { lock?: string; delay: number }[]): boolean {
  return open.some((i) => slots[i] && slots[i].lock !== "after" && slots[i].delay === 0);
}

function bundleByTag<T extends { id: string; tag: string; pathIndex: number }>(rows: T[], merge: ReadonlySet<string>) {
  const seen = new Set<string>();
  const out: { id: string; members: T[]; tag: string; pathIndex: number }[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    const tag = row.tag.trim();
    const mates = tag && merge.has(row.id)
      ? rows.filter((r) => r.tag.trim() === tag && r.pathIndex === row.pathIndex && merge.has(r.id))
      : [row];
    const group = mates.length > 1 ? mates : [row];
    for (const member of group) seen.add(member.id);
    out.push({
      id: group.length > 1 ? `tag:${row.pathIndex}:${tag}` : row.id,
      members: group,
      tag: group.length > 1 ? tag : "",
      pathIndex: row.pathIndex,
    });
  }
  return out;
}

function freshReceive(addresses: WatchAddr[], taken: Set<string>): string[] {
  const used = new Set(taken);
  const out: string[] = [];
  for (const a of addresses) {
    if (a.kind !== "receive" || a.coins > 0 || a.used) continue;
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
