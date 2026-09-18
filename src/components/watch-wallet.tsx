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
import { AmountText, AmountUnitSwitch } from "@/components/amount";
import { FilePick } from "@/components/qr-io";
import { useT } from "@/lib/use-t";
import { localizeMessage, numberLocale } from "@/lib/i18n";
import { toast } from "sonner";
import { Clock, Download, Lock, Tag, Unlock } from "lucide-react";
import { cn } from "@/lib/utils";

type CoinFilter = "all" | "now" | "later" | "unconfirmed";

export function WatchWalletPanel() {
  const { t, locale } = useT();
  const nloc = numberLocale(locale);
  const unit = useStudio((s) => s.amountUnit);
  const policyName = useStudio((s) => s.policyName);
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
  const [filter, setFilter] = useState<CoinFilter>("all");

  const descriptor = compiled?.ok ? compiled.descriptor : "";
  const checksum = descriptor ? checksumOf(descriptor) : "";
  const snap = lastWatch;

  const coins = useMemo(() => {
    const tip = snap?.height ?? 0;
    const rows = (snap?.unspents ?? []).map((u) => ({
      u,
      status: evaluateCoinStatus({
        height: u.height,
        tip,
        stages,
        reuse: reuseKeys,
        root,
      }),
      label: coinLabel(labels, u.txid, u.vout, u.address),
    }));
    rows.sort((a, b) => {
      if (!a.u.height && b.u.height) return 1;
      if (a.u.height && !b.u.height) return -1;
      return a.u.height - b.u.height || b.u.amount - a.u.amount;
    });
    return rows;
  }, [snap, stages, reuseKeys, root, labels]);

  const filtered = coins.filter((c) => {
    if (filter === "now") return c.status.spendable;
    if (filter === "later") return c.status.state === "later" || c.status.state === "unknown";
    if (filter === "unconfirmed") return c.status.state === "unconfirmed";
    return true;
  });

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

  const counts = {
    all: coins.length,
    now: coins.filter((c) => c.status.spendable).length,
    later: coins.filter((c) => c.status.state === "later" || c.status.state === "unknown").length,
    unconfirmed: coins.filter((c) => c.status.state === "unconfirmed").length,
  };

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
    a.download = `${(policyName || "scriptwerk").replace(/\s+/g, "-").toLowerCase()}-labels.jsonl`;
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

  const savedName = policyName.trim();
  const labelCount = Object.keys(labels).length;

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
            <span className="font-mono text-2xs text-fg-muted">{filtered.length}/{coins.length}</span>
          </div>
          {frozen ? <p className="mb-2 text-2xs text-fg-muted">{t("wallet.frozenSpend")}</p> : null}
          <div className="mb-3 flex flex-wrap gap-1.5">
            {(
              [
                ["all", "wallet.filterAll"],
                ["now", "wallet.filterNow"],
                ["later", "wallet.filterLocked"],
                ["unconfirmed", "wallet.filterMempool"],
              ] as const
            ).map(([id, key]) => (
              <button
                key={id}
                type="button"
                aria-pressed={filter === id}
                onClick={() => setFilter(id)}
                className={cn(
                  "min-h-9 rounded-full px-3 text-xs",
                  filter === id
                    ? "bg-primary text-primary-foreground"
                    : "border border-border text-fg-muted hover:bg-muted hover:text-fg",
                )}
              >
                {t(key)}
                <span className="ml-1.5 font-mono text-2xs opacity-70">{counts[id]}</span>
              </button>
            ))}
          </div>
          {filtered.length ? (
            <ul className="space-y-1.5">
              {filtered.map((row) => {
                const meta = snap?.addresses.find((a) => a.address === row.u.address);
                return (
                  <CoinRow
                    key={`${row.u.txid}:${row.u.vout}`}
                    hit={row.u}
                    status={row.status}
                    label={row.label}
                    kind={meta?.kind}
                    index={meta?.index}
                  />
                );
              })}
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
  const labels = useStudio((s) => s.labels);
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
  const recovery = status.paths.find((p) => p.delay > 0 || p.kind === "after");
  const recoveryNote =
    status.state === "now" && recovery
      ? recovery.open
        ? t("wallet.recoveryOpen")
        : t("wallet.recoveryIn", {
            n: recovery.blocksLeft.toLocaleString(nloc),
            approx: blocksApprox(recovery.blocksLeft, locale),
          })
      : null;
  const addr = hit.address || "";
  const addrLabel = addr ? labelText(labels, "addr", addr) : "";
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
          <p className="text-2xs text-fg-muted">
            {status.state === "unconfirmed"
              ? t("wallet.unconf")
              : t("wallet.ageConf", {
                  n: status.confirmations.toLocaleString(nloc),
                  approx: blocksApprox(status.confirmations, locale),
                })}
            {kind ? ` · ${t(`wallet.${kind}`)}${index != null ? ` ${index}` : ""}` : ""}
            {status.state === "later" && next
              ? ` · ${t("wallet.stageOpen", { n: next.index, quorum: next.quorum })}`
              : ""}
            {recoveryNote ? ` · ${recoveryNote}` : ""}
          </p>
          {addr ? (
            <p className="font-mono text-2xs break-all text-fg">
              {shortId(addr)}
              {label ? <span className="ml-1.5 font-sans text-fg-muted">{label}</span> : null}
            </p>
          ) : null}
          <p className="font-mono text-2xs break-all text-fg-subtle">
            {shortId(hit.txid)}:{hit.vout}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-0.5">
          {addr ? <LabelEdit type="addr" refValue={addr} current={addrLabel} /> : null}
          <CopyButton value={addr || hit.txid} />
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
          <p className="mt-0.5 font-mono text-2xs break-all text-fg">{address}</p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <LabelEdit type="addr" refValue={address} current={label} />
          <CopyButton value={address} />
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
    setLabel(type, refValue, draft);
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
            setDraft(current);
            setOpen(false);
          }
        }}
        placeholder={t("wallet.labelAdd")}
        className="h-9 w-28 px-2 text-xs"
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
