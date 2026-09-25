import { useMemo, useState } from "react";
import { QrCode } from "lucide-react";
import { addressFromScan, btcToSats, buildPsbt, estimateVbytes, extractSignedTx, feeFromRate, inspectSignatures, planPayments, satsFromDecimal, satsToDecimal } from "@/lib/tx/psbt";
import { formatAmount, type UtxoHit, type WatchAddr } from "@/lib/hw/address-check";
import { evaluateCoinStatus } from "@/lib/miniscript/coin-status";
import { describeStageSlots, type Stage } from "@/lib/miniscript/stages";
import { lockWhen } from "@/lib/miniscript/keys";
import { broadcastRawTx } from "@/lib/bitcoind/rpc";
import { compileBip388 } from "@/lib/miniscript/bip388";
import { useBitcoind } from "@/store/bitcoind";
import { useHardware } from "@/store/hardware";
import { useStudio } from "@/store/studio";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CopyButton } from "@/components/copy-button";
import { FilePick, QrPreview, QrScanner } from "@/components/qr-io";
import { useT } from "@/lib/use-t";
import { localizeMessage, numberLocale } from "@/lib/i18n";
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
  const pathIndex = slots.length <= 1 ? 0 : path;
  const need = pathIndex == null ? 1 : spendSize(stages, reuse, pathIndex).sigs;
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
      {mode === "send" ? <SendPane pathIndex={pathIndex} /> : <RecoveryPane pathIndex={pathIndex} />}
      <BroadcastPane required={need} />
    </div>
  );
}

function SendPane({ pathIndex }: { pathIndex: number | null }) {
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
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [rows, setRows] = useState<PayRow[]>([newRow()]);
  const [change, setChange] = useState("");
  const [changeEdited, setChangeEdited] = useState(false);
  const [rate, setRate] = useState("2");
  const [psbt, setPsbt] = useState("");
  const [feeOnChange, setFeeOnChange] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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

  function confirmPick() {
    setPicked(draft);
    setOpen(false);
    setPsbt("");
  }

  function build() {
    setError(null);
    setPsbt("");
    try {
      const plan = planPayments({
        coins: selected.map(asCoin),
        payments: applyFee(
          entered.map((r) => ({ address: r.address, sats: rowSats(r) })),
          feeSats,
          useChange,
        ),
        feeSats,
        changeAddress: changeValue,
      });
      setPsbt(buildPsbt(plan));
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
        <div key={row.id} className="grid gap-2 sm:grid-cols-[1fr_8rem_auto]">
          <AddressField
            id={`tx-to-${row.id}`}
            label={i === 0 ? t("tx.to") : t("tx.toMore")}
            value={row.address}
            onChange={(address) => setRows((cur) => cur.map((r) => (r.id === row.id ? { ...r, address } : r)))}
          />
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
          <div className="flex items-end">
            <Button
              type="button"
              variant="outline"
              disabled={rows.length < 2}
              onClick={() => setRows((cur) => cur.filter((r) => r.id !== row.id))}
            >
              {t("tx.remove")}
            </Button>
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
        <Button type="button" variant={useChange ? "default" : "outline"} disabled={!canFromChange} onClick={() => setFeeOnChange((v) => !v)}>
          {t("tx.feeFromChange")}
        </Button>
      </div>
      <p className="text-2xs text-fg-muted">{t(useChange ? "tx.feeOnChange" : "tx.feeOnAmount", { vb: String(vbytes), sats: String(feeSats) })}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={build} disabled={!selected.length || pathIndex == null}>{t("tx.build")}</Button>
        <Button type="button" variant="outline" disabled={!psbt || !!busy} onClick={() => void sign(psbt, "ledger", setBusy, setPsbt, setError, locale)}>
          {busy === "ledger" ? t("tx.signing") : t("tx.ledger")}
        </Button>
        <Button type="button" variant="outline" disabled={!psbt || !!busy} onClick={() => void sign(psbt, "bitbox", setBusy, setPsbt, setError, locale)}>
          {busy === "bitbox" ? t("tx.signing") : t("tx.bitbox")}
        </Button>
      </div>
      {error ? <p className="text-xs text-pretty text-danger">{error}</p> : null}
      {psbt ? <PsbtExport value={psbt} name="scriptwerk-send.psbt" /> : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("tx.pick")}</DialogTitle>
            <DialogDescription>{t("tx.pickBlurb")}</DialogDescription>
          </DialogHeader>
          {!coins.length ? (
            <p className="text-xs text-fg-muted">{t("tx.needScan")}</p>
          ) : (
            <ul className="max-h-80 space-y-1 overflow-auto">
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

function RecoveryPane({ pathIndex }: { pathIndex: number | null }) {
  const { t, locale } = useT();
  const nloc = numberLocale(locale);
  const unit = useStudio((s) => s.amountUnit);
  const stages = useStudio((s) => s.stages);
  const reuse = useStudio((s) => s.reuseKeys);
  const root = useStudio((s) => s.root);
  const snap = useBitcoind((s) => s.lastWatch);
  const probe = useBitcoind((s) => s.probe);
  const tip = probe?.blocks && probe.chain !== "demo" ? probe.blocks : snap?.height ?? 0;
  const [rate, setRate] = useState("2");
  const [built, setBuilt] = useState<{ id: string; psbt: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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

  function buildAll() {
    setError(null);
    const next: { id: string; psbt: string }[] = [];
    try {
      for (const row of rows) {
        if (!row.dest) throw new Error("tx.err.fresh");
        if (row.dest === row.coin.address) throw new Error("tx.err.reuse");
        const size = spendSize(stages, reuse, pathIndex ?? 0);
        const vb = estimateVbytes({ inputs: 1, outputs: [row.dest], sigs: size.sigs, keys: size.keys });
        const feeSats = feeFromRate(Number(rate.replace(",", ".")), vb);
        const plan = planPayments({
          coins: [asCoin(row.coin)],
          payments: [{ address: row.dest, sats: btcToSats(row.coin.amount) - feeSats }],
          feeSats,
        });
        if (plan.outputs.length !== 1) throw new Error("tx.err.reuse");
        next.push({ id: `${row.coin.txid}:${row.coin.vout}`, psbt: buildPsbt(plan) });
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
              <div className="flex flex-wrap items-center gap-2">
                {psbt ? <PsbtExport value={psbt} name={`scriptwerk-${id.replace(":", "-")}.psbt`} /> : <span className="text-2xs text-fg-muted">{t("tx.buildEach")}</span>}
                <Button type="button" variant="outline" disabled={!psbt || !!busy} onClick={() => void sign(psbt, "ledger", setBusy, (next) => setBuilt((cur) => cur.map((b) => (b.id === id ? { ...b, psbt: next } : b))), setError, locale)}>
                  {t("tx.ledger")}
                </Button>
                <Button type="button" variant="outline" disabled={!psbt || !!busy} onClick={() => void sign(psbt, "bitbox", setBusy, (next) => setBuilt((cur) => cur.map((b) => (b.id === id ? { ...b, psbt: next } : b))), setError, locale)}>
                  {t("tx.bitbox")}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      <Button type="button" onClick={buildAll} disabled={!rows.length || pathIndex == null}>{t("tx.buildEach")}</Button>
      {error ? <p className="text-xs text-pretty text-danger">{error}</p> : null}
    </section>
  );
}

function BroadcastPane({ required }: { required: number }) {
  const { t, locale } = useT();
  const status = useBitcoind((s) => s.status);
  const demo = useBitcoind((s) => s.demo);
  const [signed, setSigned] = useState("");
  const [txid, setTxid] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const report = useMemo(() => {
    if (!signed.trim()) return null;
    try {
      return inspectSignatures(signed);
    } catch {
      return null;
    }
  }, [signed]);

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
    <section className="space-y-2 border-t border-border pt-4">
      <h2 className="text-2xs font-medium tracking-[0.14em] text-fg-subtle uppercase">{t("tx.signed")}</h2>
      <p className="text-2xs text-pretty text-fg-muted">{t("tx.signedBlurb")}</p>
      <Textarea value={signed} onChange={(e) => setSigned(e.target.value)} className="min-h-24" spellCheck={false} />
      {report ? (
        <ul className="space-y-1">
          {report.inputs.length === 0 ? <li className="text-xs text-fg-muted">{t("tx.sigRaw")}</li> : null}
          {report.inputs.map((input) => {
            const miss = Math.max(0, required - input.pubkeys.length);
            return (
              <li key={input.index} className="text-xs text-pretty text-fg-muted">
                {input.finalized
                  ? t("tx.sigFinal", { n: String(input.index) })
                  : t("tx.sigHave", { n: String(input.index), have: String(input.pubkeys.length), need: String(required) })}
                {!input.finalized && miss > 0 ? ` ${t("tx.sigMiss", { n: String(miss) })}` : ""}
                {input.pubkeys.length ? (
                  <span className="mt-0.5 block font-mono text-2xs">{input.pubkeys.map((pk) => `${pk.slice(0, 12)}…`).join(" · ")}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <FilePick accept=".psbt,.txn,.txt,.hex,text/plain" label={t("tx.file")} onRead={setSigned} />
        <Button type="button" onClick={() => void send()} disabled={sending || !signed.trim() || status !== "ready" || demo}>
          {sending ? t("tx.sending") : t("tx.broadcast")}
        </Button>
      </div>
      {status !== "ready" || demo ? <p className="text-xs text-fg-muted">{t("tx.needNode")}</p> : null}
      {error ? <p className="text-xs text-pretty text-danger">{error}</p> : null}
      {txid ? <p className="break-all font-mono text-xs">{txid} <CopyButton value={txid} label={t("tx.copyTxid")} /></p> : null}
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

function PsbtExport({ value, name }: { value: string; name: string }) {
  const { t } = useT();
  const [qr, setQr] = useState(false);
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={() => downloadPsbt(value, name)}>{t("tx.exportFile")}</Button>
        <Button type="button" variant="outline" onClick={() => setQr((v) => !v)}>{t("tx.exportQr")}</Button>
        <CopyButton value={value} label={t("tx.copy")} className="size-11" />
      </div>
      {qr ? <QrPreview value={value} label={t("tx.copy")} compact /> : null}
    </div>
  );
}

function downloadPsbt(b64: string, name: string) {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bin], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function rowSats(row: PayRow): number {
  const n = satsFromDecimal(row.amount);
  return Number.isFinite(n) ? n : 0;
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
    setPsbt(signed);
  } catch (e) {
    setError(localizeMessage(locale, e instanceof Error ? e.message : "tx.err.sign"));
  } finally {
    setBusy(null);
  }
}
