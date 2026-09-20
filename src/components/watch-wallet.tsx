import { useMemo, useState, type FormEvent } from "react";
import { compiledForStudio, policyIsFrozen } from "@/lib/miniscript/policy-mode";
import { checksumOf } from "@/lib/miniscript/checksum";
import { clampUtxoCount, formatAmount, type UtxoHit } from "@/lib/hw/address-check";
import { blocksApprox } from "@/lib/miniscript/keys";
import { evaluateCoinStatus, type CoinSpendState, type CoinStatus } from "@/lib/miniscript/coin-status";
import {
  buildBip329Export,
  coinLabel,
  labelText,
  serializeBip329,
  type Bip329Type,
} from "@/lib/bip329";
import { useBitcoind } from "@/store/bitcoind";
import { useStudio } from "@/store/studio";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CopyButton } from "@/components/copy-button";
import { AddressLine } from "@/components/address-qr";
import { AmountText, AmountUnitSwitch } from "@/components/amount";
import { FilePick } from "@/components/qr-io";
import { useT } from "@/lib/use-t";
import { localizeMessage, numberLocale } from "@/lib/i18n";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Clock, Download, Lock, Tag, Unlock } from "lucide-react";
import { PolicyNameHeading, usePolicyTitle } from "@/components/policy-title";
import { cn } from "@/lib/utils";

type CoinSort = "age" | "size" | "addr" | "tag";

export function WatchWalletPanel() {
  const { t, locale } = useT();
  const nloc = numberLocale(locale);
  const unit = useStudio((s) => s.amountUnit);
  const { name: titleName } = usePolicyTitle();
  const compiled = useStudio(compiledForStudio);
  const stages = useStudio((s) => s.stages);
  const reuseKeys = useStudio((s) => s.reuseKeys);
  const root = useStudio((s) => s.root);
  const keys = useStudio((s) => s.keys);
  const frozen = useStudio((s) => policyIsFrozen(s.policyMode));
  const labels = useStudio((s) => s.labels);
  const importBip329 = useStudio((s) => s.importBip329);
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
  const [sort, setSort] = useState<CoinSort>("age");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const descriptor = compiled?.ok ? compiled.descriptor : "";
  const checksum = descriptor ? checksumOf(descriptor) : "";
  const snap = lastWatch && checksum && lastWatch.checksum === checksum ? lastWatch : null;

  const coins = useMemo(() => {
    const tip = snap?.height ?? 0;
    const meta = new Map((snap?.addresses ?? []).map((a) => [a.address, a]));
    const rows = (snap?.unspents ?? []).map((u) => {
      const hit = meta.get((u.address || "").trim());
      return {
        u,
        status: evaluateCoinStatus({
          height: u.height,
          tip,
          stages,
          reuse: reuseKeys,
          root,
        }),
        label: coinLabel(labels, u.txid, u.vout, u.address),
        kind: hit?.kind,
        index: hit?.index,
      };
    });
    return rows;
  }, [snap, stages, reuseKeys, root, labels]);

  const sorted = useMemo(() => {
    const list = [...coins];
    const dir = sortDir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      let d = 0;
      if (sort === "age") {
        const ah = a.u.height > 0 ? a.u.height : Number.POSITIVE_INFINITY;
        const bh = b.u.height > 0 ? b.u.height : Number.POSITIVE_INFINITY;
        d = ah - bh;
      } else if (sort === "size") {
        d = a.u.amount - b.u.amount;
      } else if (sort === "addr") {
        const ak = a.kind === "change" ? 1 : 0;
        const bk = b.kind === "change" ? 1 : 0;
        d = ak - bk || (a.index ?? 1e9) - (b.index ?? 1e9);
      } else {
        const al = a.label.trim();
        const bl = b.label.trim();
        if (!al && bl) d = 1;
        else if (al && !bl) d = -1;
        else d = al.localeCompare(bl, undefined, { numeric: true, sensitivity: "base" });
      }
      if (d === 0) d = a.u.txid.localeCompare(b.u.txid) || a.u.vout - b.u.vout;
      return d * dir;
    });
    return list;
  }, [coins, sort, sortDir]);

  function pickSort(id: CoinSort) {
    if (sort === id) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSort(id);
    setSortDir(id === "size" ? "desc" : "asc");
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

  function exportLabels() {
    const records = buildBip329Export({
      labels,
      origin: descriptor || undefined,
      addresses: snap?.addresses,
      unspents: snap?.unspents,
      xpubs: keys
        .filter((k) => k.xpub.trim())
        .map((k) => ({
          xpub: k.xpub.trim(),
          origin:
            k.fingerprint && k.derivation
              ? `[${k.fingerprint.replace(/^#/, "")}/${k.derivation.replace(/^m\//, "")}]`
              : undefined,
          note: k.note,
        })),
    });
    if (!records.length) {
      toast.error(t("wallet.bip329None"));
      return;
    }
    const body = serializeBip329(records);
    const blob = new Blob([body], { type: "application/jsonl;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${titleName.replace(/\s+/g, "-").toLowerCase()}-labels.jsonl`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(t("wallet.bip329Exported", { n: records.length }));
  }

  function onImportLabels(text: string) {
    const hit = importBip329(text);
    if (!hit.ok) {
      toast.error(t(hit.error));
      return;
    }
    toast.success(t("wallet.bip329Ok", { n: hit.n }));
  }

  const labelCount = Object.keys(labels).length;

  return (
    <div className="space-y-5">
      <p className="text-2xs text-pretty text-fg-muted">{t("wallet.blurb")}</p>

      <section className="rounded-lg border border-border bg-surface px-3 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-2xs font-medium tracking-[0.14em] text-fg-subtle uppercase">{t("wallet.title")}</p>
            <p className="mt-1 font-display text-lg tracking-tight text-fg">
              <PolicyNameHeading />
            </p>
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

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-2xs font-medium tracking-[0.14em] text-fg-subtle uppercase">{t("wallet.bip329")}</h3>
          {labelCount ? <span className="font-mono text-2xs text-fg-muted">{labelCount}</span> : null}
        </div>
        <p className="text-2xs text-pretty text-fg-muted">{t("wallet.bip329Blurb")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <FilePick onRead={onImportLabels} label={t("wallet.bip329Import")} accept=".jsonl,.json,.txt,application/json" />
          <Button type="button" variant="outline" size="sm" onClick={exportLabels}>
            <Download />
            {t("wallet.bip329Export")}
          </Button>
        </div>
      </section>

      {coins.length ? (
        <section>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-2xs font-medium tracking-[0.14em] text-fg-subtle uppercase">{t("wallet.coins")}</h3>
            <span className="font-mono text-2xs text-fg-muted">{sorted.length}</span>
          </div>
          {frozen ? <p className="mb-2 text-2xs text-fg-muted">{t("wallet.frozenSpend")}</p> : null}
          <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label={t("wallet.sort")}>
            {(
              [
                ["age", "wallet.sortAge"],
                ["size", "wallet.sortSize"],
                ["addr", "wallet.sortAddr"],
                ["tag", "wallet.sortTag"],
              ] as const
            ).map(([id, key]) => {
              const active = sort === id;
              return (
                <button
                  key={id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => pickSort(id)}
                  className={cn(
                    "inline-flex min-h-9 items-center gap-1 rounded-full px-3 text-xs",
                    active
                      ? "bg-primary text-primary-foreground"
                      : "border border-border text-fg-muted hover:bg-muted hover:text-fg",
                  )}
                >
                  {t(key)}
                  {active ? (sortDir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />) : null}
                </button>
              );
            })}
          </div>
          {sorted.length ? (
            <ul className="space-y-1.5">
              {sorted.map((row) => (
                <CoinRow
                  key={`${row.u.txid}:${row.u.vout}`}
                  hit={row.u}
                  status={row.status}
                  label={row.label}
                  kind={row.kind}
                  index={row.index}
                />
              ))}
            </ul>
          ) : (
            <p className="text-2xs text-fg-muted">{t("wallet.noCoins")}</p>
          )}
        </section>
      ) : null}

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
                label={labelText(labels, "addr", a.address)}
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
                label={labelText(labels, "addr", a.address)}
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
    </div>
  );
}

function spendBadge(state: CoinSpendState): "ok" | "warn" | "default" {
  if (state === "now") return "ok";
  if (state === "later") return "warn";
  return "default";
}

function CoinRow({
  hit,
  status,
  label,
  kind,
  index,
}: {
  hit: UtxoHit;
  status: CoinStatus;
  label: string;
  kind?: "receive" | "change";
  index?: number;
}) {
  const { t, locale } = useT();
  const nloc = numberLocale(locale);
  const next = status.next;
  const spendLabel =
    status.state === "now"
      ? t("wallet.spendNow")
      : status.state === "later" && next
        ? t("wallet.spendLater", {
            n: next.blocksLeft.toLocaleString(nloc),
            approx: blocksApprox(next.blocksLeft, locale),
          })
        : status.state === "unconfirmed"
          ? t("wallet.unconf")
          : t("wallet.spendUnknown");
  const addr = hit.address || "";
  const Icon = status.spendable ? Unlock : status.state === "later" ? Lock : Clock;

  return (
    <li className="rounded-md border border-border px-2.5 py-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <AmountText btc={hit.amount} coins />
            <Badge
              variant={spendBadge(status.state)}
              title={
                next && !status.spendable
                  ? t("wallet.opensAt", { n: next.opensAt.toLocaleString(nloc) })
                  : undefined
              }
            >
              <Icon className="mr-1 size-3" />
              {spendLabel}
            </Badge>
          </div>
          {status.paths.length ? (
            <div className="flex flex-wrap gap-1">
              {status.paths.map((p) => (
                <span
                  key={p.index}
                  title={
                    p.open
                      ? t("wallet.opensAt", { n: p.opensAt.toLocaleString(nloc) })
                      : p.kind === "after"
                        ? t("wallet.opensAt", { n: p.opensAt.toLocaleString(nloc) })
                        : t("wallet.spendLater", {
                            n: p.blocksLeft.toLocaleString(nloc),
                            approx: blocksApprox(p.blocksLeft, locale),
                          })
                  }
                  className={cn(
                    "inline-flex min-h-7 items-center gap-1 rounded-full px-2 text-2xs",
                    p.open ? "bg-ok/15 text-ok" : "bg-danger/15 text-danger",
                  )}
                >
                  {p.open ? <Unlock className="size-3" /> : <Lock className="size-3" />}
                  {t("wallet.stageChip", { n: p.index })}
                  {p.open
                    ? null
                    : p.blocksLeft > 0
                      ? ` · ${t("wallet.stageLeft", { n: p.blocksLeft.toLocaleString(nloc) })}`
                      : null}
                </span>
              ))}
            </div>
          ) : null}
          <p className="text-2xs text-fg-muted">
            {status.state === "unconfirmed"
              ? t("wallet.unconf")
              : t("wallet.ageConf", {
                  n: status.confirmations.toLocaleString(nloc),
                  approx: blocksApprox(status.confirmations, locale),
                })}
            {kind ? ` · ${t(`wallet.${kind}`)}${index != null ? ` ${index}` : ""}` : ""}
          </p>
          {addr ? (
            <div className="space-y-0.5">
              <AddressLine
                address={addr}
                label={label || (kind ? `${t(`wallet.${kind}`)} ${index ?? ""}`.trim() : undefined)}
                textClassName="text-2xs text-fg"
              />
              {label ? <p className="font-sans text-2xs text-fg-muted">{label}</p> : null}
            </div>
          ) : label ? (
            <p className="font-sans text-2xs text-fg-muted">{label}</p>
          ) : null}
          <p className="font-mono text-2xs break-all text-fg-subtle">
            {shortId(hit.txid)}:{hit.vout}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-0.5">
          <LabelEdit type="output" refValue={`${hit.txid}:${hit.vout}`} current={label} />
          <CopyButton value={`${hit.txid}:${hit.vout}`} />
        </div>
      </div>
    </li>
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
  label,
}: {
  kind: string;
  index: number;
  address: string;
  amount: number;
  coins: UtxoHit[];
  height: number;
  used: boolean;
  label: string;
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
            {label ? <span className="text-2xs text-fg">{label}</span> : null}
          </div>
          <p className="mt-0.5">
            <AddressLine address={address} label={`${kind} ${index}`} textClassName="text-2xs text-fg" />
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <LabelEdit type="addr" refValue={address} current={label} />
        </div>
      </div>
      {coins.length ? (
        <ul className="mt-1.5 space-y-0.5 border-t border-border pt-1.5">
          {coins.map((u) => {
            const conf = u.height > 0 && height > 0 ? Math.max(0, height - u.height + 1) : 0;
            return (
              <li key={`${u.txid}:${u.vout}`} className="flex flex-wrap items-center gap-x-2 font-mono text-2xs text-fg-muted">
                <AmountText btc={u.amount} />
                <span>{conf ? `${conf} conf` : t("wallet.unconf")}</span>
                <span className="break-all">{shortId(u.txid)}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}

function LabelEdit({
  type,
  refValue,
  current,
}: {
  type: Bip329Type;
  refValue: string;
  current: string;
}) {
  const { t } = useT();
  const setLabel = useStudio((s) => s.setLabel);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(current);

  function save(e?: FormEvent) {
    e?.preventDefault();
    const next = draft.trim();
    if (next !== current.trim()) setLabel(type, refValue, next);
    setOpen(false);
  }

  function cancel() {
    setDraft(current);
    setOpen(false);
  }

  if (!open) {
    return (
      <button
        type="button"
        className={cn(
          "inline-flex size-9 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-muted hover:text-fg",
          current && "text-primary",
        )}
        aria-label={t("wallet.label")}
        title={current || t("wallet.labelHint")}
        onClick={() => {
          setDraft(current);
          setOpen(true);
        }}
      >
        <Tag className="size-3.5" />
      </button>
    );
  }

  return (
    <form onSubmit={save} className="flex items-center gap-1">
      <Input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => save()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        placeholder={t("wallet.labelAdd")}
        className="h-9 w-36 px-2 text-xs"
        aria-label={t("wallet.label")}
      />
    </form>
  );
}

function shortId(v: string): string {
  const s = v.trim();
  if (s.length <= 20) return s;
  return `${s.slice(0, 8)}…${s.slice(-6)}`;
}
