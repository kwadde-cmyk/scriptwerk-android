import { useId, useState } from "react";
import { compileDescriptorCached } from "@/lib/miniscript/compile";
import { clampUtxoCount, formatBtc, mergeUtxoResults, UTXO_SCAN_CAP, type UtxoScanResult } from "@/lib/hw/address-check";
import { scanDescriptorUtxos } from "@/lib/bitcoind/rpc";
import { useBitcoind } from "@/store/bitcoind";
import { useStudio } from "@/store/studio";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CopyButton } from "@/components/copy-button";
import { useT } from "@/lib/use-t";
import { localizeMessage } from "@/lib/i18n";
import { toast } from "sonner";

export function UtxoScanPanel({
  enabled,
  hint,
  receive = true,
  change = true,
}: {
  enabled: boolean;
  hint: string;
  receive?: boolean;
  change?: boolean;
}) {
  const { t, locale } = useT();
  const fieldId = useId();
  const root = useStudio((s) => s.root);
  const keys = useStudio((s) => s.keys);
  const reuseKeys = useStudio((s) => s.reuseKeys);
  const compiled = compileDescriptorCached(root, keys, reuseKeys);
  const [count, setCount] = useState(20);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UtxoScanResult | null>(null);
  const [scanned, setScanned] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!enabled || !compiled?.ok) return;
    const n = clampUtxoCount(count);
    setCount(n);
    setBusy(true);
    setError(null);
    setResult(null);
    setScanned(0);
    const node = useBitcoind.getState();
    const cfg = { url: node.url, username: node.username, password: node.password };
    try {
      let from = 0;
      let merged: UtxoScanResult = { height: 0, total: 0, unspents: [] };
      while (from < UTXO_SCAN_CAP) {
        const next = await scanDescriptorUtxos(cfg, compiled.descriptor, {
          count: n,
          receive,
          change,
          electrum: node.electrum,
          from,
        });
        merged = mergeUtxoResults(merged, next);
        from += n;
        merged.scanned = Math.min(from, UTXO_SCAN_CAP);
        setScanned(merged.scanned);
        setResult(merged);
        if (!next.unspents.length) break;
      }
      useBitcoind.getState().setLastUtxo({
        height: merged.height,
        coins: merged.unspents.map((u) => ({ height: u.height, amount: u.amount })),
      });
      if (merged.unspents.length) {
        toast.success(t("hw.utxo.found", { n: merged.unspents.length, btc: formatBtc(merged.total) }));
      } else {
        toast.success(t("hw.utxo.empty", { n: merged.scanned ?? n }));
      }
    } catch (e) {
      const msg = localizeMessage(locale, e instanceof Error ? e.message : "hw.utxo.bad");
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 border-t border-border pt-2">
      <p className="text-xs text-fg">{t("hw.utxo.title")}</p>
      <p className="text-2xs text-pretty text-fg-muted">{hint}</p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor={fieldId}>{t("hw.utxo.count")}</Label>
          <Input
            id={fieldId}
            type="number"
            min={1}
            max={1000}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            className="w-24 font-mono text-xs"
          />
        </div>
        <Button size="sm" disabled={!enabled || busy || !compiled?.ok} onClick={() => void run()}>
          {t("hw.utxo.run")}
        </Button>
      </div>
      {busy ? (
        <p className="text-2xs text-fg-muted">
          {t("hw.utxo.working")}
          {scanned ? ` · ${t("hw.utxo.scanned", { n: scanned })}` : ""}
        </p>
      ) : null}
      {error ? <p className="text-2xs text-danger">{error}</p> : null}
      {result && !busy ? (
        <p className="text-xs text-fg">
          {result.unspents.length
            ? `${t("hw.utxo.found", { n: result.unspents.length, btc: formatBtc(result.total) })} · ${t("hw.utxo.scanned", { n: result.scanned ?? scanned })}`
            : t("hw.utxo.empty", { n: result.scanned ?? count })}
        </p>
      ) : null}
      {result?.unspents.length ? (
        <div className="max-h-48 overflow-auto">
          <table className="w-full text-left font-mono text-2xs">
            <thead className="text-fg-subtle">
              <tr>
                <th className="pr-2 font-normal">{t("hw.utxo.colAmount")}</th>
                <th className="pr-2 font-normal">{t("hw.utxo.colTxid")}</th>
                <th className="pr-2 font-normal">{t("hw.utxo.colVout")}</th>
                <th className="font-normal">{t("hw.utxo.colHeight")}</th>
              </tr>
            </thead>
            <tbody>
              {result.unspents.map((u) => (
                <tr key={`${u.txid}:${u.vout}`}>
                  <td className="py-0.5 pr-2 align-top">{formatBtc(u.amount)}</td>
                  <td className="max-w-[10rem] py-0.5 pr-2 align-top">
                    <span className="inline-flex max-w-full items-start gap-0.5">
                      <span className="min-w-0 break-all">
                        {u.txid.length > 16 ? `${u.txid.slice(0, 8)}…${u.txid.slice(-8)}` : u.txid}
                      </span>
                      <CopyButton value={u.txid} />
                    </span>
                  </td>
                  <td className="py-0.5 pr-2 align-top">{u.vout}</td>
                  <td className="py-0.5 align-top">{u.height || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
