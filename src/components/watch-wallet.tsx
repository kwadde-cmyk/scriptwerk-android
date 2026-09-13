import { useMemo, useState } from "react";
import { compileDescriptorCached } from "@/lib/miniscript/compile";
import { checksumOf } from "@/lib/miniscript/checksum";
import { clampUtxoCount, formatAmount, type UtxoHit } from "@/lib/hw/address-check";
import { useBitcoind } from "@/store/bitcoind";
import { useStudio } from "@/store/studio";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CopyButton } from "@/components/copy-button";
import { AmountText, AmountUnitSwitch } from "@/components/amount";
import { useT } from "@/lib/use-t";
import { localizeMessage, numberLocale } from "@/lib/i18n";
import { toast } from "sonner";

export function WatchWalletPanel() {
  const { t, locale } = useT();
  const nloc = numberLocale(locale);
  const unit = useStudio((s) => s.amountUnit);
  const policyName = useStudio((s) => s.policyName);
  const root = useStudio((s) => s.root);
  const keys = useStudio((s) => s.keys);
  const reuseKeys = useStudio((s) => s.reuseKeys);
  const compiled = compileDescriptorCached(root, keys, reuseKeys);
  const status = useBitcoind((s) => s.status);
  const demo = useBitcoind((s) => s.demo);
  const electrum = useBitcoind((s) => s.electrum);
  const lastWatch = useBitcoind((s) => s.lastWatch);
  const scanningWatch = useBitcoind((s) => s.scanningWatch);
  const scanWatch = useBitcoind((s) => s.scanWatch);
  const setOpen = useBitcoind((s) => s.setOpen);
  const ready = status === "ready" && !demo;
  const [count, setCount] = useState(20);
  const [error, setError] = useState<string | null>(null);

  const descriptor = compiled?.ok ? compiled.descriptor : "";
  const checksum = descriptor ? checksumOf(descriptor) : "";
  const snap = lastWatch;

  async function run() {
    if (!ready || !compiled?.ok) return;
    const n = clampUtxoCount(count);
    setCount(n);
    setError(null);
    try {
      const merged = await scanWatch(compiled.descriptor, { count: n });
      if (merged?.unspents.length) {
        toast.success(
          t("wallet.found", { n: merged.unspents.length, amount: formatAmount(merged.total, unit, nloc).label }),
        );
      } else {
        toast.success(t("wallet.empty", { n: merged?.scanned ?? n }));
      }
    } catch (e) {
      const msg = localizeMessage(locale, e instanceof Error ? e.message : "hw.utxo.bad");
      setError(msg);
      toast.error(msg);
    }
  }

  const used = snap?.addresses.filter((a) => a.coins > 0) ?? [];
  const unused = (snap?.addresses.filter((a) => a.coins === 0) ?? []).slice(0, 8);
  const coinsByAddr = useMemo(() => {
    const map = new Map<string, UtxoHit[]>();
    for (const u of snap?.unspents ?? []) {
      const key = (u.address || "").trim();
      if (!key) continue;
      const list = map.get(key) ?? [];
      list.push(u);
      map.set(key, list);
    }
    return map;
  }, [snap]);

  const savedName = policyName.trim();

  return (
    <div className="space-y-5">
      <p className="text-2xs text-pretty text-fg-muted">{t("wallet.blurb")}</p>

      <section className="rounded-lg border border-border bg-surface px-3 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-2xs font-medium tracking-[0.14em] text-fg-subtle uppercase">{t("wallet.title")}</p>
            {savedName ? <p className="mt-1 font-display text-lg tracking-tight text-fg">{savedName}</p> : null}
          </div>
          <AmountUnitSwitch />
        </div>
        {checksum ? (
          <p className="mt-1 inline-flex items-center gap-1 font-mono text-xs text-fg">
            #{checksum}
            <CopyButton value={descriptor} label={t("wallet.copyDesc")} />
          </p>
        ) : (
          <p className="mt-1 text-xs text-fg-muted">{t("read.noPolicy")}</p>
        )}
        <p className="mt-3 font-display text-2xl tracking-tight text-fg">
          {snap ? <AmountText btc={snap.total} /> : "—"}
        </p>
        {snap ? (
          <p className="mt-1 text-2xs text-fg-muted">
            {t("wallet.confirmed", { amount: formatAmount(snap.confirmed, unit, nloc).label })}
            {snap.unconfirmed > 0
              ? ` · ${t("wallet.mempool", { amount: formatAmount(snap.unconfirmed, unit, nloc).label })}`
              : ""}
            {snap.height ? ` · ${t("wallet.tip", { n: snap.height.toLocaleString(nloc) })}` : ""}
          </p>
        ) : (
          <p className="mt-1 text-2xs text-fg-muted">{t("wallet.needScan")}</p>
        )}
      </section>

      {!ready ? (
        <div className="space-y-2">
          <p className="text-xs text-fg-muted">{demo ? t("wallet.noDemo") : t("wallet.needNode")}</p>
          <Button type="button" onClick={() => setOpen(true)}>
            {t("node.open")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="wallet-gap">{t("wallet.gap")}</Label>
            <Input
              id="wallet-gap"
              type="number"
              min={1}
              max={1000}
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
              className="w-24 font-mono text-xs"
            />
          </div>
          <Button type="button" disabled={scanningWatch || !compiled?.ok} onClick={() => void run()}>
            {scanningWatch ? t("wallet.working") : t("wallet.refresh")}
          </Button>
        </div>
      )}
      {ready && !electrum ? <p className="text-2xs text-warn">{t("wallet.needElectrum")}</p> : null}
      {scanningWatch && snap?.scanned ? (
        <p className="text-2xs text-fg-muted">{t("hw.utxo.scanned", { n: snap.scanned })}</p>
      ) : null}
      {error ? <p className="text-2xs text-danger">{error}</p> : null}

      {snap?.addresses.length ? (
        <section>
          <h3 className="mb-2 text-2xs font-medium tracking-[0.14em] text-fg-subtle uppercase">{t("wallet.addrs")}</h3>
          <ul className="space-y-1">
            {used.map((a) => (
              <AddrRow
                key={a.address}
                kind={t(`wallet.${a.kind}`)}
                index={a.index}
                address={a.address}
                amount={a.amount}
                coins={coinsByAddr.get(a.address) ?? []}
                height={snap.height}
                used
              />
            ))}
            {unused.map((a) => (
              <AddrRow
                key={a.address}
                kind={t(`wallet.${a.kind}`)}
                index={a.index}
                address={a.address}
                amount={0}
                coins={[]}
                height={snap.height}
                used={false}
              />
            ))}
          </ul>
          {snap.addresses.length > used.length + unused.length ? (
            <p className="mt-1 text-2xs text-fg-subtle">
              {t("wallet.moreAddrs", { n: snap.addresses.length - used.length - unused.length })}
            </p>
          ) : null}
        </section>
      ) : null}

      {snap?.unspents.length ? (
        <section>
          <h3 className="mb-2 text-2xs font-medium tracking-[0.14em] text-fg-subtle uppercase">{t("wallet.coins")}</h3>
          <div className="max-h-64 overflow-auto">
            <table className="w-full text-left font-mono text-2xs">
              <thead className="text-fg-subtle">
                <tr>
                  <th className="pr-2 font-normal">{t("hw.utxo.colAmount")}</th>
                  <th className="pr-2 font-normal">{t("wallet.colAddr")}</th>
                  <th className="pr-2 font-normal">{t("wallet.colConf")}</th>
                  <th className="font-normal">{t("hw.utxo.colTxid")}</th>
                </tr>
              </thead>
              <tbody>
                {snap.unspents.map((u) => {
                  const conf = u.height > 0 && snap.height > 0 ? Math.max(0, snap.height - u.height + 1) : 0;
                  const addr = u.address || "";
                  return (
                    <tr key={`${u.txid}:${u.vout}`}>
                      <td className="py-0.5 pr-2 align-top">
                        <AmountText btc={u.amount} coins />
                      </td>
                      <td className="max-w-[8rem] py-0.5 pr-2 align-top">
                        <span className="inline-flex max-w-full items-start gap-0.5">
                          <span className="min-w-0 break-all">
                            {addr.length > 16 ? `${addr.slice(0, 8)}…${addr.slice(-6)}` : addr || "—"}
                          </span>
                          {addr ? <CopyButton value={addr} /> : null}
                        </span>
                      </td>
                      <td className="py-0.5 pr-2 align-top">{conf || "—"}</td>
                      <td className="max-w-[8rem] py-0.5 align-top">
                        <span className="inline-flex max-w-full items-start gap-0.5">
                          <span className="min-w-0 break-all">
                            {u.txid.length > 16 ? `${u.txid.slice(0, 8)}…${u.txid.slice(-6)}` : u.txid}
                          </span>
                          <CopyButton value={u.txid} />
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function AddrRow({
  kind,
  index,
  address,
  amount,
  coins,
  height,
  used,
}: {
  kind: string;
  index: number;
  address: string;
  amount: number;
  coins: UtxoHit[];
  height: number;
  used: boolean;
}) {
  const { t } = useT();
  return (
    <li className="rounded-md border border-border px-2 py-1.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-2xs text-fg-muted">
              {kind} {index}
            </span>
            {used ? (
              <Badge variant="ok">
                {t("wallet.sum")}: <AmountText btc={amount} className="tabular-nums" />
              </Badge>
            ) : (
              <Badge variant="default">—</Badge>
            )}
          </div>
          <p className="mt-0.5 font-mono text-2xs break-all text-fg">{address}</p>
        </div>
        <CopyButton value={address} />
      </div>
      {coins.length ? (
        <ul className="mt-1.5 space-y-0.5 border-t border-border pt-1.5">
          {coins.map((u) => {
            const conf = u.height > 0 && height > 0 ? Math.max(0, height - u.height + 1) : 0;
            return (
              <li key={`${u.txid}:${u.vout}`} className="flex flex-wrap items-center gap-x-2 font-mono text-2xs text-fg-muted">
                <AmountText btc={u.amount} />
                <span>{conf ? `${conf} conf` : t("wallet.unconf")}</span>
                <span className="break-all">{u.txid.length > 16 ? `${u.txid.slice(0, 8)}…${u.txid.slice(-6)}` : u.txid}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}